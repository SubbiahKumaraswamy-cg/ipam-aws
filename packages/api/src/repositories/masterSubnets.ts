/**
 * Repository for master_subnet — the parent blocks from which child subnets
 * are carved. Capacity figures come from the master_subnet_utilisation view so
 * they are always derived from the current children.
 */

import type {
  MasterSubnet,
  MasterSubnetInput,
  RegionGroup,
  ProviderLocation,
} from '@ipam/shared';
import {
  REGION_GROUPS,
  PROVIDER_LOCATIONS,
  toCidrString,
  suggestNextSubnet,
  largestFreeBlockPrefix,
} from '@ipam/shared';
import { query, queryOne, withTransaction } from '../db';
import { HttpError } from '../auth';
import { diff, recordAudit } from './audit';

interface MasterRow {
  id: string;
  name: string | null;
  cidr: string;
  region_group: RegionGroup;
  country_iso: string | null;
  country_name: string | null;
  provider_location: ProviderLocation | null;
  description: string | null;
  remarks: string | null;
  attributes: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
  total_addresses: string | null;
  usable_hosts: string | null;
  allocated_addresses: string | null;
  available_addresses: string | null;
  allocated_children: string | null;
  reserved_children: string | null;
  released_children: string | null;
  total_children: string | null;
}

/**
 * Master rows joined to their derived capacity. The view is aggregated, so it
 * is joined rather than re-grouped here.
 */
const SELECT_MASTER = `
  SELECT
    m.id,
    m.name,
    host(m.cidr) || '/' || masklen(m.cidr) AS cidr,
    m.region_group,
    m.country_iso,
    c.name AS country_name,
    m.provider_location,
    m.description,
    m.remarks,
    m.attributes,
    m.created_at,
    m.updated_at,
    m.created_by,
    m.updated_by,
    u.total_addresses::text      AS total_addresses,
    u.usable_hosts::text         AS usable_hosts,
    u.allocated_addresses::text  AS allocated_addresses,
    u.available_addresses::text  AS available_addresses,
    u.allocated_children::text   AS allocated_children,
    u.reserved_children::text    AS reserved_children,
    u.released_children::text    AS released_children,
    u.total_children::text       AS total_children
  FROM master_subnet m
  LEFT JOIN country c ON c.iso = m.country_iso
  LEFT JOIN master_subnet_utilisation u ON u.id = m.id
`;

const num = (value: string | null | undefined): number =>
  value ? Number(value) : 0;

function toDomain(row: MasterRow): MasterSubnet {
  return {
    id: row.id,
    name: row.name,
    cidr: row.cidr,
    regionGroup: row.region_group,
    countryIso: row.country_iso,
    countryName: row.country_name,
    providerLocation: row.provider_location,
    description: row.description,
    remarks: row.remarks,
    attributes: row.attributes ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    totalAddresses: num(row.total_addresses),
    usableHosts: num(row.usable_hosts),
    allocatedAddresses: num(row.allocated_addresses),
    availableAddresses: num(row.available_addresses),
    allocatedChildren: num(row.allocated_children),
    reservedChildren: num(row.reserved_children),
    releasedChildren: num(row.released_children),
    totalChildren: num(row.total_children),
  };
}

/** Validate and normalise a client payload. */
function validate(input: MasterSubnetInput): MasterSubnetInput & { cidr: string } {
  if (!REGION_GROUPS.includes(input.regionGroup)) {
    throw new HttpError(
      400,
      `regionGroup must be one of: ${REGION_GROUPS.join(', ')}.`,
    );
  }
  if (
    input.providerLocation &&
    !PROVIDER_LOCATIONS.includes(input.providerLocation)
  ) {
    throw new HttpError(
      400,
      `providerLocation must be one of: ${PROVIDER_LOCATIONS.join(', ')}.`,
    );
  }

  const cidr = toCidrString(input.cidr);
  if (!cidr) {
    throw new HttpError(
      400,
      `"${input.cidr}" is not a valid IPv4 CIDR. Use a form such as 10.20.0.0/16.`,
    );
  }

  return {
    ...input,
    cidr,
    name: input.name?.trim() || null,
    countryIso: input.countryIso ? input.countryIso.trim().toUpperCase() : null,
    description: input.description?.trim() || null,
    remarks: input.remarks ?? null,
    attributes: input.attributes ?? {},
  };
}

/**
 * Translate database-level guarantees into actionable messages.
 * The exclusion constraint is the authoritative overlap check.
 */
function translateError(err: unknown, cidr: string): never {
  const e = err as { code?: string; constraint?: string; message?: string };

  if (e.code === '23P01' && e.constraint === 'master_subnet_no_overlap') {
    throw new HttpError(
      409,
      `${cidr} overlaps an existing master subnet. Master subnets must not overlap.`,
    );
  }
  if (e.code === '23503') {
    throw new HttpError(
      400,
      'The referenced country does not exist. Add the country first.',
    );
  }
  // Raised by the master_subnet_contains_children trigger.
  if (e.code === 'P0001' && e.message) {
    throw new HttpError(409, e.message);
  }
  throw err as Error;
}

export interface MasterFilters {
  regionGroup?: string;
  countryIso?: string;
  providerLocation?: string;
  search?: string;
  /** Only masters contained within this CIDR. */
  within?: string;
}

export async function listMasters(
  filters: MasterFilters = {},
): Promise<MasterSubnet[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.regionGroup) {
    params.push(filters.regionGroup);
    conditions.push(`m.region_group = $${params.length}`);
  }
  if (filters.countryIso) {
    params.push(filters.countryIso.toUpperCase());
    conditions.push(`m.country_iso = $${params.length}`);
  }
  if (filters.providerLocation) {
    params.push(filters.providerLocation);
    conditions.push(`m.provider_location = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const i = params.length;
    conditions.push(
      `(m.name ILIKE $${i} OR c.name ILIKE $${i} OR m.description ILIKE $${i} ` +
        `OR m.remarks ILIKE $${i} OR host(m.cidr) ILIKE $${i})`,
    );
  }
  if (filters.within) {
    const normalised = toCidrString(filters.within);
    if (!normalised) throw new HttpError(400, '"within" must be a valid CIDR.');
    params.push(normalised);
    conditions.push(`m.cidr <<= $${params.length}::cidr`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<MasterRow>(
    `${SELECT_MASTER} ${where} ORDER BY m.region_group, c.name NULLS FIRST, m.cidr`,
    params,
  );
  return rows.map(toDomain);
}

export async function getMaster(id: string): Promise<MasterSubnet> {
  const row = await queryOne<MasterRow>(`${SELECT_MASTER} WHERE m.id = $1`, [id]);
  if (!row) throw new HttpError(404, 'Master subnet not found.');
  return toDomain(row);
}

export async function createMaster(
  input: MasterSubnetInput,
  actor: string,
): Promise<MasterSubnet> {
  const v = validate(input);
  try {
    return await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO master_subnet
           (name, cidr, region_group, country_iso, provider_location,
            description, remarks, attributes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
         RETURNING id`,
        [
          v.name,
          v.cidr,
          v.regionGroup,
          v.countryIso,
          v.providerLocation,
          v.description,
          v.remarks,
          JSON.stringify(v.attributes ?? {}),
          actor,
        ],
      );
      const id = inserted.rows[0].id;
      await recordAudit(client, 'master_subnet', id, 'create', actor, null);
      return id;
    }).then(getMaster);
  } catch (err) {
    return translateError(err, v.cidr);
  }
}

export async function updateMaster(
  id: string,
  input: MasterSubnetInput,
  actor: string,
): Promise<MasterSubnet> {
  const v = validate(input);
  try {
    await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT id, name, host(cidr)||'/'||masklen(cidr) AS cidr, region_group,
                country_iso, provider_location, description, remarks, attributes
           FROM master_subnet WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (existing.rowCount === 0) {
        throw new HttpError(404, 'Master subnet not found.');
      }

      const updated = await client.query(
        `UPDATE master_subnet SET
           name = $2, cidr = $3, region_group = $4, country_iso = $5,
           provider_location = $6, description = $7, remarks = $8,
           attributes = $9, updated_by = $10
         WHERE id = $1
         RETURNING id, name, host(cidr)||'/'||masklen(cidr) AS cidr, region_group,
                   country_iso, provider_location, description, remarks, attributes`,
        [
          id,
          v.name,
          v.cidr,
          v.regionGroup,
          v.countryIso,
          v.providerLocation,
          v.description,
          v.remarks,
          JSON.stringify(v.attributes ?? {}),
          actor,
        ],
      );

      await recordAudit(
        client,
        'master_subnet',
        id,
        'update',
        actor,
        diff(
          existing.rows[0] as Record<string, unknown>,
          updated.rows[0] as Record<string, unknown>,
        ),
      );
    });
  } catch (err) {
    return translateError(err, v.cidr);
  }
  return getMaster(id);
}

export async function deleteMaster(id: string, actor: string): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await client.query<{ cidr: string; children: string }>(
      `SELECT host(m.cidr)||'/'||masklen(m.cidr) AS cidr,
              (SELECT COUNT(*)::text FROM child_subnet WHERE master_subnet_id = m.id) AS children
         FROM master_subnet m WHERE m.id = $1`,
      [id],
    );
    if (existing.rowCount === 0) {
      throw new HttpError(404, 'Master subnet not found.');
    }
    const { cidr, children } = existing.rows[0];
    if (Number(children) > 0) {
      throw new HttpError(
        409,
        `${cidr} still has ${children} child subnet(s). Delete or reassign them first.`,
      );
    }

    await client.query(`DELETE FROM master_subnet WHERE id = $1`, [id]);
    await recordAudit(client, 'master_subnet', id, 'delete', actor, {
      cidr: { from: cidr, to: null },
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Capacity helpers                                                           */
/* -------------------------------------------------------------------------- */

export interface FreeSpaceReport {
  masterId: string;
  masterCidr: string;
  /** Requested prefix length, when supplied. */
  prefix: number | null;
  /** Lowest aligned free block of the requested size, if any. */
  suggestion: string | null;
  /** Smallest block size still available anywhere in the master. */
  largestAvailablePrefix: number | null;
  usedCidrs: string[];
}

/**
 * Suggest where a new child subnet of the requested size could go.
 *
 * The database still has the final say via its exclusion constraint; this
 * exists so requesters are handed a valid range instead of guessing.
 */
export async function findFreeSpace(
  masterId: string,
  prefix?: number,
): Promise<FreeSpaceReport> {
  const master = await getMaster(masterId);

  const rows = await query<{ cidr: string }>(
    `SELECT host(cidr)||'/'||masklen(cidr) AS cidr
       FROM child_subnet
      WHERE master_subnet_id = $1 AND status <> 'Released'
      ORDER BY cidr`,
    [masterId],
  );
  const usedCidrs = rows.map((r) => r.cidr);

  if (prefix !== undefined) {
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      throw new HttpError(400, 'prefix must be an integer between 0 and 32.');
    }
  }

  return {
    masterId,
    masterCidr: master.cidr,
    prefix: prefix ?? null,
    suggestion:
      prefix === undefined
        ? null
        : suggestNextSubnet(master.cidr, usedCidrs, prefix),
    largestAvailablePrefix: largestFreeBlockPrefix(master.cidr, usedCidrs),
    usedCidrs,
  };
}

/** Master subnets overlapping a candidate CIDR — used for pre-flight checks. */
export async function findOverlappingMasters(
  cidr: string,
  excludeId?: string,
): Promise<MasterSubnet[]> {
  const normalised = toCidrString(cidr);
  if (!normalised) throw new HttpError(400, 'A valid CIDR is required.');

  const params: unknown[] = [normalised];
  let extra = '';
  if (excludeId) {
    params.push(excludeId);
    extra = ` AND m.id <> $${params.length}`;
  }

  const rows = await query<MasterRow>(
    `${SELECT_MASTER} WHERE m.cidr && $1::cidr${extra} ORDER BY m.cidr`,
    params,
  );
  return rows.map(toDomain);
}


/* -------------------------------------------------------------------------- */
/* Bulk import                                                                */
/* -------------------------------------------------------------------------- */

export interface BulkMasterResult {
  inserted: number;
  updated: number;
  skipped: number;
  /** Human-readable reason for each row that could not be stored. */
  errors: string[];
}

/**
 * Bulk upsert used when seeding from the existing spreadsheet.
 *
 * A row whose CIDR already exists is updated in place. A row that overlaps a
 * *different* master subnet is reported and skipped rather than aborting the
 * whole import, because the source data legitimately contains overlaps that a
 * human needs to resolve.
 */
export async function bulkUpsertMasters(
  inputs: MasterSubnetInput[],
  actor: string,
): Promise<BulkMasterResult> {
  const result: BulkMasterResult = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  for (const [index, raw] of inputs.entries()) {
    const label = `row ${index + 1}`;
    let v: MasterSubnetInput & { cidr: string };
    try {
      v = validate(raw);
    } catch (err) {
      result.skipped++;
      result.errors.push(
        `${label}: ${err instanceof HttpError ? err.message : String(err)}`,
      );
      continue;
    }

    try {
      // Each row gets its own transaction so one failure cannot poison the rest.
      await withTransaction(async (client) => {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM master_subnet WHERE cidr = $1::cidr`,
          [v.cidr],
        );

        if (existing.rowCount && existing.rows[0]) {
          const id = existing.rows[0].id;
          await client.query(
            `UPDATE master_subnet SET
               name = COALESCE($2, name),
               region_group = $3,
               country_iso = COALESCE($4, country_iso),
               provider_location = COALESCE($5, provider_location),
               description = COALESCE($6, description),
               remarks = COALESCE($7, remarks),
               updated_by = $8
             WHERE id = $1`,
            [
              id,
              v.name,
              v.regionGroup,
              v.countryIso,
              v.providerLocation,
              v.description,
              v.remarks,
              actor,
            ],
          );
          await recordAudit(client, 'master_subnet', id, 'update', actor, null);
          result.updated++;
          return;
        }

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO master_subnet
             (name, cidr, region_group, country_iso, provider_location,
              description, remarks, attributes, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
           RETURNING id`,
          [
            v.name,
            v.cidr,
            v.regionGroup,
            v.countryIso,
            v.providerLocation,
            v.description,
            v.remarks,
            JSON.stringify(v.attributes ?? {}),
            actor,
          ],
        );
        await recordAudit(
          client,
          'master_subnet',
          inserted.rows[0].id,
          'create',
          actor,
          null,
        );
        result.inserted++;
      });
    } catch (err) {
      const e = err as { code?: string; constraint?: string; message?: string };
      result.skipped++;

      if (e.code === '23P01') {
        // Find what it clashed with so the message is actionable.
        const clashes = await findOverlappingMasters(v.cidr).catch(() => []);
        result.errors.push(
          `${label}: ${v.cidr} overlaps ${
            clashes.length
              ? clashes.map((c) => c.cidr).join(', ')
              : 'an existing master subnet'
          } — skipped.`,
        );
      } else if (e.code === '23503') {
        result.errors.push(
          `${label}: ${v.cidr} references country ${v.countryIso} which does not exist — skipped.`,
        );
      } else {
        result.errors.push(`${label}: ${e.message ?? String(err)}`);
      }
    }
  }

  return result;
}
