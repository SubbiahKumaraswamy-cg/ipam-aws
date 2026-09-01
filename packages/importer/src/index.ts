#!/usr/bin/env node
/**
 * CLI for importing the IP address allocation workbook.
 *
 * Usage
 *   ipam-import <workbook.xlsx> [options]
 *
 * Options
 *   --out <dir>          Write CSV files ready for the app's Import button.
 *   --json <dir>         Write raw JSON payloads.
 *   --api <url>          Push directly to the IPAM API.
 *   --token <jwt>        Cognito ID token (required with --api).
 *   --default-status <s> Force a status instead of deriving it.
 *   --dry-run            Report what was found without writing anything.
 *   --quiet              Suppress the per-warning listing.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AllocationStatus } from '@ipam/shared';
import { ALLOCATION_STATUSES } from '@ipam/shared';
import { parseWorkbook, type ParseResult } from './parse';

interface Args {
  file: string;
  out?: string;
  json?: string;
  api?: string;
  token?: string;
  defaultStatus?: AllocationStatus;
  dryRun: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { file: '', dryRun: false, quiet: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value.`);
      return value;
    };

    switch (arg) {
      case '--out':
        args.out = next();
        break;
      case '--json':
        args.json = next();
        break;
      case '--api':
        args.api = next().replace(/\/+$/, '');
        break;
      case '--token':
        args.token = next();
        break;
      case '--default-status': {
        const value = next() as AllocationStatus;
        if (!ALLOCATION_STATUSES.includes(value)) {
          throw new Error(
            `--default-status must be one of ${ALLOCATION_STATUSES.join(', ')}.`,
          );
        }
        args.defaultStatus = value;
        break;
      }
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--quiet':
        args.quiet = true;
        break;
      case '-h':
      case '--help':
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        if (args.file) throw new Error('Only one workbook may be given.');
        args.file = arg;
    }
  }

  if (!args.file) {
    printUsage();
    throw new Error('A workbook path is required.');
  }
  if (args.api && !args.token) {
    throw new Error('--api also requires --token (a Cognito ID token).');
  }
  return args;
}

function printUsage(): void {
  console.log(`
Import the IP address allocation workbook into Cloud IPAM.

  ipam-import <workbook.xlsx> [options]

Options
  --out <dir>            Write CSV files for the app's Import button
  --json <dir>           Write raw JSON payloads
  --api <url>            Push directly to the IPAM API
  --token <jwt>          Cognito ID token (required with --api)
  --default-status <s>   One of: ${ALLOCATION_STATUSES.join(', ')}
  --dry-run              Report findings without writing
  --quiet                Suppress per-warning output

Examples
  # Inspect the workbook first
  ipam-import "IP address allocation.xlsx" --dry-run

  # Produce CSVs to upload through the UI
  ipam-import "IP address allocation.xlsx" --out ./out

  # Load straight into a deployed environment
  ipam-import "IP address allocation.xlsx" \\
    --api https://abc.execute-api.eu-west-1.amazonaws.com --token "$ID_TOKEN"
`);
}

/** Minimal CSV serialiser (RFC 4180 quoting). */
function toCsv(
  rows: Record<string, unknown>[],
  columns: { key: string; header: string }[],
): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [columns.map((c) => escape(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escape(row[c.key])).join(','));
  }
  return lines.join('\r\n');
}

function writeCsvFiles(result: ParseResult, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];

  for (const environment of ['AWS', 'Azure'] as const) {
    const rows = result.allocations.filter((a) => a.environment === environment);
    if (rows.length === 0) continue;
    const file = join(dir, `${environment.toLowerCase()}-allocations.csv`);
    writeFileSync(
      file,
      toCsv(rows as unknown as Record<string, unknown>[], [
        { key: 'environment', header: 'Environment' },
        { key: 'regionGroup', header: 'Region' },
        { key: 'iso', header: 'ISO' },
        { key: 'country', header: 'COUNTRY' },
        { key: 'cloudSpace', header: 'CLOUD SPACE' },
        { key: 'mask', header: 'MASK' },
        { key: 'currentRange', header: 'Current Range' },
        { key: 'status', header: 'Status' },
        { key: 'remarks', header: 'Remarks' },
      ]),
      'utf8',
    );
    written.push(file);
  }

  if (result.subscriptions.length > 0) {
    const file = join(dir, 'azure-subscriptions.csv');
    writeFileSync(
      file,
      toCsv(result.subscriptions as unknown as Record<string, unknown>[], [
        { key: 'portalType', header: 'Portal' },
        { key: 'subscription', header: 'Subscription' },
        { key: 'addressSpace', header: 'Address Space' },
        { key: 'regionGroup', header: 'Region' },
        { key: 'remarks', header: 'Remarks' },
      ]),
      'utf8',
    );
    written.push(file);
  }

  if (result.planEntries.length > 0) {
    const file = join(dir, 'subnet-plan.csv');
    writeFileSync(
      file,
      toCsv(result.planEntries as unknown as Record<string, unknown>[], [
        { key: 'subnet16', header: '/16 SUBNETS' },
        { key: 'agg14', header: '/14 255.252.0.0' },
        { key: 'agg12', header: '/12 255.240.0.0' },
        { key: 'allocation', header: 'Allocation' },
        { key: 'remarks', header: 'Remarks' },
        { key: 'currentUsage', header: 'Current usage' },
        { key: 'change', header: 'Change' },
      ]),
      'utf8',
    );
    written.push(file);
  }

  return written;
}

/** Push parsed data to a deployed API. */
async function pushToApi(
  result: ParseResult,
  baseUrl: string,
  token: string,
): Promise<void> {
  const post = async (path: string, rows: unknown[]): Promise<void> => {
    if (rows.length === 0) return;
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(rows),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`POST ${path} failed (${response.status}): ${text}`);
    }
    console.log(`  POST ${path} → ${text}`);
  };

  console.log(`\nUploading to ${baseUrl} …`);
  await post('/allocations/import', result.allocations);
  await post('/azure-subscriptions/import', result.subscriptions);
  await post('/subnet-plan/import', result.planEntries);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const file = resolve(args.file);

  console.log(`Reading ${file} …\n`);
  const result = await parseWorkbook(file, {
    defaultStatus: args.defaultStatus,
  });

  // Per-sheet report.
  console.log('Sheet summary');
  console.log('─'.repeat(78));
  console.log(
    'SHEET'.padEnd(24) +
      'DETECTED AS'.padEnd(30) +
      'ALLOC'.padStart(7) +
      'SUBS'.padStart(6) +
      'PLAN'.padStart(6),
  );
  for (const sheet of result.sheets) {
    console.log(
      sheet.name.slice(0, 23).padEnd(24) +
        sheet.kind.slice(0, 29).padEnd(30) +
        String(sheet.allocations).padStart(7) +
        String(sheet.subscriptions).padStart(6) +
        String(sheet.planEntries).padStart(6),
    );
  }
  console.log('─'.repeat(78));
  console.log(
    'TOTAL'.padEnd(54) +
      String(result.allocations.length).padStart(7) +
      String(result.subscriptions.length).padStart(6) +
      String(result.planEntries.length).padStart(6),
  );

  // Region breakdown, which is the quickest way to spot a missed block.
  const byRegion = new Map<string, number>();
  for (const a of result.allocations) {
    const key = `${a.environment} / ${a.regionGroup}`;
    byRegion.set(key, (byRegion.get(key) ?? 0) + 1);
  }
  if (byRegion.size > 0) {
    console.log('\nAllocations by cloud and region');
    for (const [key, count] of [...byRegion.entries()].sort()) {
      console.log(`  ${key.padEnd(34)} ${String(count).padStart(5)}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log(`\n${result.warnings.length} warning(s)`);
    if (!args.quiet) {
      for (const warning of result.warnings.slice(0, 40)) {
        console.log(`  ! ${warning}`);
      }
      if (result.warnings.length > 40) {
        console.log(`  … and ${result.warnings.length - 40} more.`);
      }
    }
  }

  if (args.dryRun) {
    console.log('\nDry run — nothing written.');
    return;
  }

  if (args.json) {
    mkdirSync(args.json, { recursive: true });
    writeFileSync(
      join(args.json, 'allocations.json'),
      JSON.stringify(result.allocations, null, 2),
    );
    writeFileSync(
      join(args.json, 'azure-subscriptions.json'),
      JSON.stringify(result.subscriptions, null, 2),
    );
    writeFileSync(
      join(args.json, 'subnet-plan.json'),
      JSON.stringify(result.planEntries, null, 2),
    );
    console.log(`\nJSON written to ${resolve(args.json)}`);
  }

  if (args.out) {
    const written = writeCsvFiles(result, args.out);
    console.log(`\nCSV written to ${resolve(args.out)}:`);
    for (const file of written) console.log(`  ${file}`);
    console.log(
      '\nUpload these with the "Import CSV" button on the matching page.',
    );
  }

  if (args.api && args.token) {
    await pushToApi(result, args.api, args.token);
    console.log('\nUpload complete.');
  }

  if (!args.out && !args.json && !args.api) {
    console.log(
      '\nNothing written. Add --out <dir> to produce CSVs, --json <dir> for JSON, ' +
        'or --api/--token to upload.',
    );
  }
}

main().catch((err) => {
  console.error(`\nError: ${(err as Error).message}`);
  process.exitCode = 1;
});
