#!/usr/bin/env node
/**
 * CLI for importing the IP address allocation workbook into Cloud IPAM.
 *
 * Usage
 *   ipam-import <workbook.xlsx> [options]
 *
 * Options
 *   --out <dir>    Write CSV files ready for the app's Import buttons.
 *   --json <dir>   Write raw JSON payloads.
 *   --api <url>    Push directly to the IPAM API.
 *   --token <jwt>  Cognito ID token (required with --api).
 *   --dry-run      Report what was found without writing anything.
 *   --quiet        Suppress the per-warning listing.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseWorkbook, type ParseResult } from './parse';

interface Args {
  file: string;
  out?: string;
  json?: string;
  api?: string;
  token?: string;
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
  --out <dir>      Write CSV files for the app's Import buttons
  --json <dir>     Write raw JSON payloads
  --api <url>      Push directly to the IPAM API
  --token <jwt>    Cognito ID token (required with --api)
  --dry-run        Report findings without writing
  --quiet          Suppress per-warning output

Examples
  # Inspect the workbook first
  ipam-import "IPAM-Solution-Cloud-data.xlsx" --dry-run

  # Produce CSVs to upload through the UI
  ipam-import "IPAM-Solution-Cloud-data.xlsx" --out ./out

  # Load straight into a deployed environment
  ipam-import "IPAM-Solution-Cloud-data.xlsx" \\
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

  const write = (
    name: string,
    rows: Record<string, unknown>[],
    columns: { key: string; header: string }[],
  ) => {
    if (rows.length === 0) return;
    const file = join(dir, name);
    writeFileSync(file, toCsv(rows, columns), 'utf8');
    written.push(file);
  };

  write('countries.csv', result.countries as unknown as Record<string, unknown>[], [
    { key: 'iso', header: 'ISO' },
    { key: 'name', header: 'Country' },
    { key: 'regionGroup', header: 'Region' },
    { key: 'active', header: 'Active' },
    { key: 'remarks', header: 'Remarks' },
  ]);

  write('master-subnets.csv', result.masters as unknown as Record<string, unknown>[], [
    { key: 'cidr', header: 'Master Subnet' },
    { key: 'name', header: 'Name' },
    { key: 'regionGroup', header: 'Region' },
    { key: 'countryIso', header: 'ISO' },
    { key: 'providerLocation', header: 'Provider / Location' },
    { key: 'description', header: 'Description' },
    { key: 'remarks', header: 'Remarks' },
  ]);

  write(
    'azure-subscriptions.csv',
    result.subscriptions as unknown as Record<string, unknown>[],
    [
      { key: 'portalType', header: 'Portal' },
      { key: 'subscription', header: 'Subscription' },
      { key: 'addressSpace', header: 'Address Space' },
      { key: 'regionGroup', header: 'Region' },
      { key: 'remarks', header: 'Remarks' },
    ],
  );

  write('subnet-plan.csv', result.planEntries as unknown as Record<string, unknown>[], [
    { key: 'subnet16', header: '/16 SUBNETS' },
    { key: 'agg14', header: '/14 255.252.0.0' },
    { key: 'agg12', header: '/12 255.240.0.0' },
    { key: 'allocation', header: 'Allocation' },
    { key: 'remarks', header: 'Remarks' },
    { key: 'currentUsage', header: 'Current usage' },
    { key: 'change', header: 'Change' },
  ]);

  return written;
}

/**
 * Push parsed data to a deployed API.
 *
 * Countries go first because master subnets reference them.
 */
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
    console.log(`  POST ${path}`);
    // Surface per-row skips reported by the master-subnet importer.
    try {
      const parsed = JSON.parse(text) as {
        inserted?: number;
        updated?: number;
        skipped?: number;
        total?: number;
        errors?: string[];
      };
      const parts: string[] = [];
      if (parsed.total !== undefined) parts.push(`${parsed.total} submitted`);
      if (parsed.inserted !== undefined) parts.push(`${parsed.inserted} added`);
      if (parsed.updated !== undefined) parts.push(`${parsed.updated} updated`);
      if (parsed.skipped) parts.push(`${parsed.skipped} skipped`);
      console.log(`    ${parts.join(' · ')}`);
      for (const message of parsed.errors ?? []) {
        console.log(`    ! ${message}`);
      }
    } catch {
      console.log(`    ${text}`);
    }
  };

  console.log(`\nUploading to ${baseUrl} …`);
  await post('/countries/import', result.countries);
  await post('/master-subnets/import', result.masters);
  await post('/azure-subscriptions/import', result.subscriptions);
  await post('/subnet-plan/import', result.planEntries);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const file = resolve(args.file);

  console.log(`Reading ${file} …\n`);
  const result = await parseWorkbook(file);

  console.log('Sheet summary');
  console.log('─'.repeat(78));
  console.log(
    'SHEET'.padEnd(24) +
      'DETECTED AS'.padEnd(34) +
      'MASTERS'.padStart(8) +
      'SUBS'.padStart(6) +
      'PLAN'.padStart(6),
  );
  for (const sheet of result.sheets) {
    console.log(
      sheet.name.slice(0, 23).padEnd(24) +
        sheet.kind.slice(0, 33).padEnd(34) +
        String(sheet.masters).padStart(8) +
        String(sheet.subscriptions).padStart(6) +
        String(sheet.planEntries).padStart(6),
    );
  }
  console.log('─'.repeat(78));
  console.log(
    'TOTAL'.padEnd(58) +
      String(result.masters.length).padStart(8) +
      String(result.subscriptions.length).padStart(6) +
      String(result.planEntries.length).padStart(6),
  );
  console.log(`\n${result.countries.length} distinct country/countries found.`);

  // Region breakdown is the quickest way to spot a missed block.
  const byRegion = new Map<string, number>();
  for (const m of result.masters) {
    const key = `${m.providerLocation ?? 'unknown'} / ${m.regionGroup}`;
    byRegion.set(key, (byRegion.get(key) ?? 0) + 1);
  }
  if (byRegion.size > 0) {
    console.log('\nMaster subnets by provider and region');
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
      join(args.json, 'countries.json'),
      JSON.stringify(result.countries, null, 2),
    );
    writeFileSync(
      join(args.json, 'master-subnets.json'),
      JSON.stringify(result.masters, null, 2),
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
    for (const f of written) console.log(`  ${f}`);
    console.log(
      '\nUpload countries.csv first (Countries page), then master-subnets.csv ' +
        '(Master subnets page), since subnets reference countries.',
    );
  }

  if (args.api && args.token) {
    await pushToApi(result, args.api, args.token);
    console.log('\nUpload complete.');
  }

  if (!args.out && !args.json && !args.api) {
    console.log(
      '\nNothing written. Add --out <dir> for CSVs, --json <dir> for JSON, ' +
        'or --api/--token to upload.',
    );
  }
}

main().catch((err) => {
  console.error(`\nError: ${(err as Error).message}`);
  process.exitCode = 1;
});
