/**
 * Spreadsheet parser for the IP address allocation workbook.
 *
 * The workbook does not use a simple one-table-per-sheet layout. Instead each
 * allocation sheet contains several *blocks* laid out side by side, e.g.
 *
 *        A        B         C        D             E        F        G
 *   1         CAMEAT                          ASIA                LATAM      <- merged region headers
 *   2  ISO  COUNTRY  CLOUD SPACE  MASK    ISO  COUNTRY  ...
 *   3  AE   UAE      10.20.0.0    /16     SG   Singapore ...
 *
 * Blocks vary in width: some include `Current Range` and/or `Remarks`, others
 * (such as NORTH AMERICA) stop at `MASK`. The Azure sheets additionally carry
 * `Subscription` / `Address Space` tables split by portal type.
 *
 * The parser therefore scans for header anchors rather than assuming fixed
 * column positions.
 */

import ExcelJS from 'exceljs';
import type {
  CloudAllocationInput,
  AzureSubscriptionInput,
  SubnetPlanEntryInput,
  Environment,
  RegionGroup,
  AzurePortalType,
  AllocationStatus,
} from '@ipam/shared';
import { toCidrString } from '@ipam/shared';

export interface ParseResult {
  allocations: CloudAllocationInput[];
  subscriptions: AzureSubscriptionInput[];
  planEntries: SubnetPlanEntryInput[];
  warnings: string[];
  /** Per-sheet summary for reporting. */
  sheets: {
    name: string;
    kind: string;
    allocations: number;
    subscriptions: number;
    planEntries: number;
    skipped: number;
  }[];
}

/* -------------------------------------------------------------------------- */
/* Cell / grid helpers                                                        */
/* -------------------------------------------------------------------------- */

/** Convert any ExcelJS cell value into plain text. */
export function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Rich text: { richText: [{ text }] }
    if (Array.isArray(obj.richText)) {
      return obj.richText
        .map((part) => toText((part as { text?: unknown }).text))
        .join('')
        .trim();
    }
    // Formula cell: { formula, result }
    if ('result' in obj) return toText(obj.result);
    // Hyperlink: { text, hyperlink }
    if ('text' in obj) return toText(obj.text);
    // Error cell: { error: '#REF!' }
    if ('error' in obj) return '';
  }
  return String(value).trim();
}

/**
 * Build a dense 2D grid of the sheet's text, resolving merged cells so that
 * every cell in a merged range carries the master cell's value. This is what
 * lets us find the region label sitting above a block.
 */
export function buildGrid(sheet: ExcelJS.Worksheet): string[][] {
  const rowCount = sheet.rowCount;
  const colCount = sheet.columnCount;
  const grid: string[][] = [];

  for (let r = 1; r <= rowCount; r++) {
    const row: string[] = [];
    for (let c = 1; c <= colCount; c++) {
      const cell = sheet.getCell(r, c);
      // For merged cells only the master holds the value.
      const source = cell.isMerged && cell.master ? cell.master : cell;
      row.push(toText(source.value));
    }
    grid.push(row);
  }
  return grid;
}

/** Normalise a header label for comparison: upper case, single spaces. */
function normaliseHeader(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/* -------------------------------------------------------------------------- */
/* Region / environment mapping                                               */
/* -------------------------------------------------------------------------- */

/**
 * Map a region label found in the sheet onto a canonical RegionGroup.
 * Returns null when the label is not recognisable as a region.
 */
export function normaliseRegion(label: string): RegionGroup | null {
  const key = normaliseHeader(label).replace(/[^A-Z ]/g, '').trim();
  if (!key) return null;

  if (key.includes('EUROPE') || key === 'EMEA') return 'EUROPE';
  if (
    key.includes('CAMEAT') ||
    (key.includes('AFRICA') && key.includes('EAST')) ||
    key.includes('MIDDLE EAST')
  ) {
    return 'CAMEAT';
  }
  if (key.includes('LATAM') || key.includes('LATIN AMERICA')) return 'LATAM';
  if (key.includes('COMPASS')) return 'COMPASS GROUP';
  // Check America after LATAM so "LATIN AMERICA" is not swallowed here.
  // Note: deliberately no short aliases such as "US" or "NA" — those collide
  // with ISO country codes in the data rows.
  if (key.includes('AMERICA')) return 'AMERICA';
  if (key.includes('ASIA') || key.includes('APAC') || key.includes('PACIFIC')) {
    return 'ASIA';
  }
  return null;
}

/** Infer the cloud environment from a sheet name. */
export function environmentFromSheetName(name: string): Environment | null {
  const key = normaliseHeader(name);
  if (key.includes('AWS')) return 'AWS';
  if (key.includes('AZURE')) return 'Azure';
  return null;
}

/** Infer the Azure portal type from a sheet name or nearby label. */
export function portalTypeFromLabel(label: string): AzurePortalType | null {
  const key = normaliseHeader(label);
  if (key.includes('CLASSIC') || key.includes('OLD PORTAL')) {
    return 'Classic (Old Portal)';
  }
  if (
    key.includes('ARM') ||
    key.includes('NEW PORTAL') ||
    key.includes('AZURE NEW')
  ) {
    return 'ARM (New Portal)';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Block detection                                                            */
/* -------------------------------------------------------------------------- */

type FieldName =
  | 'iso'
  | 'country'
  | 'cloudSpace'
  | 'mask'
  | 'currentRange'
  | 'remarks';

const ALLOCATION_HEADER_MAP: { pattern: RegExp; field: FieldName }[] = [
  { pattern: /^ISO( CODE)?$/, field: 'iso' },
  { pattern: /^COUNTRY|^MARKET|^LOCATION/, field: 'country' },
  { pattern: /CLOUD SPACE|^NETWORK|^ADDRESS SPACE|^IP SPACE/, field: 'cloudSpace' },
  { pattern: /^MASK|SUBNET MASK|^PREFIX/, field: 'mask' },
  { pattern: /CURRENT RANGE|^RANGE|IN USE/, field: 'currentRange' },
  { pattern: /^REMARK|^NOTE|^COMMENT/, field: 'remarks' },
];

function mapAllocationHeader(label: string): FieldName | null {
  const key = normaliseHeader(label);
  for (const { pattern, field } of ALLOCATION_HEADER_MAP) {
    if (pattern.test(key)) return field;
  }
  return null;
}

interface Block {
  headerRow: number;
  startCol: number;
  endCol: number;
  columns: Partial<Record<FieldName, number>>;
  region: RegionGroup | null;
  regionLabel: string;
  unmapped: string[];
}

/**
 * Locate allocation blocks by anchoring on the `ISO` header cell, then reading
 * the contiguous run of header labels to its right.
 */
function findAllocationBlocks(grid: string[][]): Block[] {
  const blocks: Block[] = [];

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    for (let c = 0; c < row.length; c++) {
      if (normaliseHeader(row[c]) !== 'ISO') continue;

      // Collect the contiguous header run starting at this ISO cell.
      const columns: Partial<Record<FieldName, number>> = {};
      const unmapped: string[] = [];
      let end = c;
      for (let k = c; k < row.length; k++) {
        const label = row[k];
        if (!label) break; // A blank header ends the block.
        const field = mapAllocationHeader(label);
        if (field) {
          // First occurrence wins so a stray duplicate cannot hijack a column.
          if (columns[field] === undefined) columns[field] = k;
        } else {
          unmapped.push(label);
        }
        end = k;
      }

      // A usable block needs at least a country/network pair.
      if (columns.cloudSpace === undefined) continue;

      const { region, label } = findRegionLabel(grid, r, c, end);
      blocks.push({
        headerRow: r,
        startCol: c,
        endCol: end,
        columns,
        region,
        regionLabel: label,
        unmapped,
      });
      // Continue scanning after this block for side-by-side tables.
      c = end;
    }
  }

  return blocks;
}

/**
 * True when a row begins a different section — another header row, a region
 * banner, or an Azure subscription table. Allocation blocks must stop there
 * rather than reading on into unrelated rows further down the sheet.
 */
function looksLikeNewSection(
  grid: string[][],
  row: number,
  startCol: number,
  endCol: number,
): boolean {
  for (let c = startCol; c <= endCol; c++) {
    const text = grid[row]?.[c];
    if (!text) continue;
    const key = normaliseHeader(text);
    if (
      key === 'ISO' ||
      /^SUBSCRIPTION/.test(key) ||
      /^ADDRESS SPACE/.test(key) ||
      portalTypeFromLabel(text) !== null
    ) {
      return true;
    }
    // Only treat longer labels as region banners: short codes in the ISO
    // column (e.g. "CA") must not be mistaken for a new section.
    if (key.length > 4 && normaliseRegion(text) !== null) return true;
  }
  return false;
}

/**
 * Find the region label for a block by scanning upwards for the nearest
 * non-empty cell horizontally overlapping the block's columns.
 */
function findRegionLabel(
  grid: string[][],
  headerRow: number,
  startCol: number,
  endCol: number,
): { region: RegionGroup | null; label: string } {
  for (let r = headerRow - 1; r >= 0 && r >= headerRow - 6; r--) {
    for (let c = startCol; c <= endCol; c++) {
      const text = grid[r]?.[c];
      if (!text) continue;
      const region = normaliseRegion(text);
      if (region) return { region, label: text };
    }
  }
  return { region: null, label: '' };
}

/* -------------------------------------------------------------------------- */
/* Sheet parsers                                                              */
/* -------------------------------------------------------------------------- */

interface SheetOutcome {
  allocations: CloudAllocationInput[];
  subscriptions: AzureSubscriptionInput[];
  planEntries: SubnetPlanEntryInput[];
  warnings: string[];
  skipped: number;
  kind: string;
}

/** Parse the country allocation blocks on an AWS/Azure sheet. */
function parseAllocationSheet(
  grid: string[][],
  sheetName: string,
  environment: Environment,
  deriveStatus: (row: { currentRange: string | null }) => AllocationStatus,
): SheetOutcome {
  const warnings: string[] = [];
  const allocations: CloudAllocationInput[] = [];
  let skipped = 0;

  const blocks = findAllocationBlocks(grid);

  for (const block of blocks) {
    if (!block.region) {
      warnings.push(
        `${sheetName}: block at row ${block.headerRow + 1}, column ${
          block.startCol + 1
        } has no recognisable region heading — rows skipped. ` +
          `Add the region name above the ISO header, or import this block separately.`,
      );
      continue;
    }
    if (block.unmapped.length > 0) {
      warnings.push(
        `${sheetName} / ${block.region}: ignored unrecognised column(s): ${block.unmapped.join(
          ', ',
        )}.`,
      );
    }

    const get = (row: number, field: FieldName): string => {
      const col = block.columns[field];
      if (col === undefined) return '';
      return grid[row]?.[col] ?? '';
    };

    let blankStreak = 0;
    for (let r = block.headerRow + 1; r < grid.length; r++) {
      // Stop at the start of any new section (header, banner, other table).
      if (looksLikeNewSection(grid, r, block.startCol, block.endCol)) break;

      const iso = get(r, 'iso');
      const country = get(r, 'country');
      const cloudSpace = get(r, 'cloudSpace');
      const mask = get(r, 'mask');
      const currentRange = get(r, 'currentRange');
      const remarks = get(r, 'remarks');

      const isBlank = !iso && !country && !cloudSpace && !mask;
      if (isBlank) {
        // Tolerate spacer rows inside a block but stop after several.
        if (++blankStreak >= 3) break;
        continue;
      }
      blankStreak = 0;

      if (!cloudSpace) {
        skipped++;
        warnings.push(
          `${sheetName} / ${block.region}: row ${r + 1} (${
            country || iso || 'unnamed'
          }) has no CLOUD SPACE value — skipped.`,
        );
        continue;
      }

      // A row whose CLOUD SPACE is not an address at all is a sub-heading.
      if (!/\d+\.\d+/.test(cloudSpace)) {
        skipped++;
        continue;
      }

      const normalisedRange = currentRange || null;
      const cidr = toCidrString(cloudSpace, mask);
      if (!cidr) {
        warnings.push(
          `${sheetName} / ${block.region}: row ${r + 1} — "${cloudSpace}" with mask "${
            mask || '(none)'
          }" is not a valid IPv4 CIDR. Imported as-is for correction in the UI.`,
        );
      }

      allocations.push({
        environment,
        regionGroup: block.region,
        iso: iso ? iso.toUpperCase().slice(0, 8) : null,
        country: country || null,
        cloudSpace,
        // Default to /16, the prevailing size in this plan, when absent.
        mask: mask || '/16',
        currentRange: normalisedRange,
        status: deriveStatus({ currentRange: normalisedRange }),
        remarks: remarks || null,
        tags: { sourceSheet: sheetName },
      });
    }
  }

  return {
    allocations,
    subscriptions: [],
    planEntries: [],
    warnings,
    skipped,
    kind: `${environment} allocations (${blocks.length} region block(s))`,
  };
}

/** Parse `Subscription` / `Address Space` tables on an Azure sheet. */
function parseSubscriptionTables(
  grid: string[][],
  sheetName: string,
): { subscriptions: AzureSubscriptionInput[]; warnings: string[] } {
  const subscriptions: AzureSubscriptionInput[] = [];
  const warnings: string[] = [];
  // Fall back to the sheet name when no portal label sits above the table.
  const sheetPortal = portalTypeFromLabel(sheetName);

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    for (let c = 0; c < row.length; c++) {
      if (!/^SUBSCRIPTION/.test(normaliseHeader(row[c]))) continue;

      // The address-space column is the next non-empty header to the right.
      let addressCol = -1;
      for (let k = c + 1; k < row.length && k <= c + 3; k++) {
        if (!row[k]) continue;
        if (/ADDRESS SPACE|CLOUD SPACE|^CIDR/.test(normaliseHeader(row[k]))) {
          addressCol = k;
        }
        break;
      }
      if (addressCol === -1) continue;

      // Determine the portal from the banner above the table.
      let portalType: AzurePortalType | null = null;
      for (let up = r - 1; up >= 0 && up >= r - 4 && !portalType; up--) {
        for (let k = c; k <= addressCol; k++) {
          const found = portalTypeFromLabel(grid[up]?.[k] ?? '');
          if (found) {
            portalType = found;
            break;
          }
        }
      }
      portalType = portalType ?? sheetPortal;

      if (!portalType) {
        warnings.push(
          `${sheetName}: subscription table at row ${r + 1} has no Classic/ARM label above it — defaulting to "ARM (New Portal)".`,
        );
        portalType = 'ARM (New Portal)';
      }

      let blankStreak = 0;
      for (let d = r + 1; d < grid.length; d++) {
        const subscription = grid[d]?.[c] ?? '';
        const addressSpace = grid[d]?.[addressCol] ?? '';
        if (!subscription && !addressSpace) {
          if (++blankStreak >= 3) break;
          continue;
        }
        blankStreak = 0;
        if (/^SUBSCRIPTION/.test(normaliseHeader(subscription))) break;
        if (!subscription || !addressSpace) continue;

        subscriptions.push({
          portalType,
          subscription,
          addressSpace,
          regionGroup: null,
          remarks: null,
        });
      }
      c = addressCol;
    }
  }

  return { subscriptions, warnings };
}

/** Parse the hierarchical /16 → /14 → /12 subnet plan sheet. */
function parseSubnetPlanSheet(
  grid: string[][],
  sheetName: string,
): SheetOutcome {
  const warnings: string[] = [];
  const planEntries: SubnetPlanEntryInput[] = [];
  let skipped = 0;

  // Locate the header row: it contains a /16 column and an Allocation column.
  let headerRow = -1;
  const cols: Record<string, number> = {};

  for (let r = 0; r < grid.length && headerRow === -1; r++) {
    const found: Record<string, number> = {};
    grid[r].forEach((cell, c) => {
      const key = normaliseHeader(cell);
      if (!key) return;
      if (/\/16/.test(key) && found.subnet16 === undefined) found.subnet16 = c;
      else if (/\/14|255\.252\.0\.0/.test(key) && found.agg14 === undefined) {
        found.agg14 = c;
      } else if (/\/12|255\.240\.0\.0/.test(key) && found.agg12 === undefined) {
        found.agg12 = c;
      } else if (/^ALLOCATION/.test(key) && found.allocation === undefined) {
        found.allocation = c;
      } else if (/^REMARK|^NOTE/.test(key) && found.remarks === undefined) {
        found.remarks = c;
      } else if (/CURRENT USAGE|^USAGE/.test(key) && found.currentUsage === undefined) {
        found.currentUsage = c;
      } else if (/^CHANGE/.test(key) && found.change === undefined) {
        found.change = c;
      }
    });

    if (found.subnet16 !== undefined && found.allocation !== undefined) {
      headerRow = r;
      Object.assign(cols, found);
    }
  }

  if (headerRow === -1) {
    return {
      allocations: [],
      subscriptions: [],
      planEntries: [],
      warnings: [
        `${sheetName}: could not find a subnet plan header row (expected a "/16" column alongside "Allocation").`,
      ],
      skipped: 0,
      kind: 'unrecognised',
    };
  }

  const get = (row: number, key: string): string => {
    const col = cols[key];
    if (col === undefined) return '';
    return grid[row]?.[col] ?? '';
  };

  let blankStreak = 0;
  for (let r = headerRow + 1; r < grid.length; r++) {
    const subnet16 = get(r, 'subnet16');
    const agg14 = get(r, 'agg14');
    const agg12 = get(r, 'agg12');
    const allocation = get(r, 'allocation');
    const remarks = get(r, 'remarks');
    const currentUsage = get(r, 'currentUsage');
    const change = get(r, 'change');

    if (!subnet16 && !agg14 && !agg12 && !allocation) {
      if (++blankStreak >= 5) break;
      continue;
    }
    blankStreak = 0;

    // Normalise each CIDR column; unparseable values become null so the row
    // still imports (the API rejects malformed CIDRs outright).
    const n16 = subnet16 ? toCidrString(subnet16, '/16') : null;
    const n14 = agg14 ? toCidrString(agg14, '/14') : null;
    const n12 = agg12 ? toCidrString(agg12, '/12') : null;

    if (subnet16 && !n16) {
      warnings.push(
        `${sheetName}: row ${r + 1} — "${subnet16}" is not a valid /16 subnet; stored without a CIDR.`,
      );
    }

    if (!n16 && !n14 && !n12 && !allocation) {
      skipped++;
      continue;
    }

    planEntries.push({
      subnet16: n16,
      agg14: n14,
      agg12: n12,
      allocation: allocation || null,
      remarks: remarks || null,
      currentUsage: currentUsage || null,
      change: change || null,
    });
  }

  return {
    allocations: [],
    subscriptions: [],
    planEntries,
    warnings,
    skipped,
    kind: 'subnet plan',
  };
}

/* -------------------------------------------------------------------------- */
/* Workbook entry point                                                       */
/* -------------------------------------------------------------------------- */

export interface ParseOptions {
  /**
   * How to set the initial lifecycle status. By default a row that already has
   * a Current Range is treated as `Used`, otherwise `Allocated`.
   */
  defaultStatus?: AllocationStatus;
}

export async function parseWorkbook(
  filePath: string,
  options: ParseOptions = {},
): Promise<ParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const result: ParseResult = {
    allocations: [],
    subscriptions: [],
    planEntries: [],
    warnings: [],
    sheets: [],
  };

  const deriveStatus = (row: { currentRange: string | null }): AllocationStatus =>
    options.defaultStatus ?? (row.currentRange ? 'Used' : 'Allocated');

  workbook.eachSheet((sheet) => {
    if (sheet.state === 'hidden' || sheet.state === 'veryHidden') {
      result.warnings.push(`Skipped hidden sheet "${sheet.name}".`);
      return;
    }

    const grid = buildGrid(sheet);
    const environment = environmentFromSheetName(sheet.name);

    let outcome: SheetOutcome;

    if (environment) {
      outcome = parseAllocationSheet(grid, sheet.name, environment, deriveStatus);

      // Azure sheets may also carry subscription -> address space tables.
      if (environment === 'Azure') {
        const subs = parseSubscriptionTables(grid, sheet.name);
        outcome.subscriptions = subs.subscriptions;
        outcome.warnings.push(...subs.warnings);
      }

      // A sheet named for a cloud might still be the subnet plan.
      if (
        outcome.allocations.length === 0 &&
        outcome.subscriptions.length === 0
      ) {
        const plan = parseSubnetPlanSheet(grid, sheet.name);
        if (plan.planEntries.length > 0) outcome = plan;
      }
    } else {
      // Try the subnet plan layout, then fall back to subscription tables.
      outcome = parseSubnetPlanSheet(grid, sheet.name);
      if (outcome.planEntries.length === 0) {
        const subs = parseSubscriptionTables(grid, sheet.name);
        if (subs.subscriptions.length > 0) {
          outcome = {
            allocations: [],
            subscriptions: subs.subscriptions,
            planEntries: [],
            warnings: subs.warnings,
            skipped: 0,
            kind: 'Azure subscriptions',
          };
        }
      }
    }

    result.allocations.push(...outcome.allocations);
    result.subscriptions.push(...outcome.subscriptions);
    result.planEntries.push(...outcome.planEntries);
    result.warnings.push(...outcome.warnings);
    result.sheets.push({
      name: sheet.name,
      kind: outcome.kind,
      allocations: outcome.allocations.length,
      subscriptions: outcome.subscriptions.length,
      planEntries: outcome.planEntries.length,
      skipped: outcome.skipped,
    });
  });

  // De-duplicate subscriptions, which can repeat across sheets.
  const seen = new Set<string>();
  result.subscriptions = result.subscriptions.filter((s) => {
    const key = `${s.portalType}|${s.subscription}|${s.addressSpace}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return result;
}
