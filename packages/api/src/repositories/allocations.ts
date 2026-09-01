/**
 * Repository for cloud_allocation — the AWS / Azure country allocation rows.
 */

import type {
  CloudAllocation,
  CloudAllocationInput,
  Environment,
  RegionGroup,
  AllocationStatus,
} from '@ipam/shared';
import {
  ENVIRONMENTS,
  REGION_GROUPS,
  ALLOCATION_STATUSES,
  toCidrString,
} from '@ipam/shared';
import { query, queryOne, withTransaction } from '../db';
import { HttpError } from '../auth';
import { diff, recordAudit } from './audit';

interface AllocationRow {
  id: string;
  environment: Environment;
  region_group: RegionGroup;
  iso: string | null;
  country: string | null;
  cloud_space: string;
  mask: string;
  cidr: string | null;
  current_range: string | null;
  status: AllocationStatus;
  remarks: string | null;
  tags: Record<string, string>;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

const SELECT_COLUMNS = `
  id, environment, region_group, iso, country, cloud_space, mask,
  host(cidr) || '/' || masklen(cidr) AS cidr,
  current_range, status, remarks, tags,
  created_at, updated_at, created_by, updated_by
`;

function toDomain(row: AllocationRow): CloudAllocation {
  return {
    id: row.id,
    environment: row.environment,
    regionGroup: row.region_group,
    iso: row.iso,
    country: row.country,
    cloudSpace: row.cloud_space,
    mask: row.mask,
    cidr: row.cidr,
    currentRange: row.current_range,
    status: row.status,
    remarks: row.remarks,
    tags: row.tags ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

export interface AllocationFilters {
  environment?: string;
  regionGroup?: string;
  status?: string;
  iso?: string;
  /** Free-text search across country, cloud space, remarks. */
  search?: string;
  /** Return only allocations contained within this CIDR. */
  within?: string;
}

/** Validate and normalise a client-supplied allocation payload. */
function validate(input: CloudAllocationInput): CloudAllocationInput & {
  cidr: string | null;
} {
  if (!ENVIRONMENTS.includes(input.environment)) {
    throw new HttpError(400, `environment must be one of ${ENVIRONMENTS.join(', ')}.`);
  }
  if (!REGION_GROUPS.includes(input.regionGroup)) {
    throw new HttpError(
      400,
      `regionGroup must be one of ${REGION_GROUPS.join(', ')}.`,
    );
  }
  const status = input.status ?? 'Allocated';
  if (!ALLOCATION_STATUSES.includes(status)) {
    throw new HttpError(
      400,
      `status must be one of ${ALLOCATION_STATUSES.join(', ')}.`,
    );
  }
  if (!String(input.cloudSpace ?? '').trim()) {
    throw new HttpError(400, 'cloudSpace is required.');
  }
  if (!String(input.mask ?? '').trim()) {
    throw new HttpError(400, 'mask is required.');
  }

  // Derive the canonical CIDR. A null result is tolerated (the row is still
  // stored) so imperfect source data can be corrected in the UI, but an
  // explicitly supplied invalid CIDR is rejected.
  const derived = toCidrString(input.cloudSpace, input.mask);
  const cidr = input.cidr !== undefined && input.cidr !== null
    ? toCidrString(input.cidr) ?? null
    : derived;

  if (input.cidr && !cidr) {
    throw new HttpError(400, `cidr "${input.cidr}" is not a valid IPv4 CIDR.`);
  }

  return {
    ...input,
    status,
    iso: input.iso ? String(input.iso).trim().toUpperCase() : null,
    country: input.country ? String(input.country).trim() : null,
    cloudSpace: String(input.cloudSpace).trim(),
    mask: String(input.mask).trim(),
    currentRange: input.currentRange ? String(input.currentRange).trim() : null,
    remarks: input.remarks ?? null,
    tags: input.tags ?? {},
    cidr,
  };
}

export async function listAllocations(
  filters: AllocationFilters = {},
): Promise<CloudAllocation[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.environment) {
    params.push(filters.environment);
    conditions.push(`environment = $${params.length}`);
  }
  if (filters.regionGroup) {
    params.push(filters.regionGroup);
    conditions.push(`region_group = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filters.iso) {
    params.push(filters.iso.toUpperCase());
    conditions.push(`iso = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const i = params.length;
    conditions.push(
      `(country ILIKE $${i} OR cloud_space ILIKE $${i} OR remarks ILIKE $${i} OR iso ILIKE $${i})`,
    );
  }
  if (filters.within) {
    const normalised = toCidrString(filters.within);
    if (!normalised) {
      throw new HttpError(400, `"within" must be a valid CIDR.`);
    }
    params.push(normalised);
    conditions.push(`cidr <<= $${params.length}::cidr`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<AllocationRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM cloud_allocation
       ${where}
      ORDER BY region_group, country NULLS LAST, cidr NULLS LAST`,
    params,
  );
  return rows.map(toDomain);
}

export async function getAllocation(id: string): Promise<CloudAllocation> {
  const row = await queryOne<AllocationRow>(
    `SELECT ${SELECT_COLUMNS} FROM cloud_allocation WHERE id = $1`,
    [id],
  );
  if (!row) throw new HttpError(404, 'Allocation not found.');
  return toDomain(row);
}

export async function createAllocation(
  input: CloudAllocationInput,
  actor: string,
): Promise<CloudAllocation> {
  const v = validate(input);
  return withTransaction(async (client) => {
    const result = await client.query<AllocationRow>(
      `INSERT INTO cloud_allocation
         (environment, region_group, iso, country, cloud_space, mask, cidr,
          current_range, status, remarks, tags, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
       RETURNING ${SELECT_COLUMNS}`,
      [
        v.environment,
        v.regionGroup,
        v.iso,
        v.country,
        v.cloudSpace,
        v.mask,
        v.cidr,
        v.currentRange,
        v.status,
        v.remarks,
        JSON.stringify(v.tags ?? {}),
        actor,
      ],
    );
    const row = result.rows[0];
    await recordAudit(client, 'cloud_allocation', row.id, 'create', actor, null);
    return toDomain(row);
  });
}

export async function updateAllocation(
  id: string,
  input: CloudAllocationInput,
  actor: string,
): Promise<CloudAllocation> {
  const v = validate(input);
  return withTransaction(async (client) => {
    const existing = await client.query<AllocationRow>(
      `SELECT ${SELECT_COLUMNS} FROM cloud_allocation WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (existing.rowCount === 0) {
      throw new HttpError(404, 'Allocation not found.');
    }

    const result = await client.query<AllocationRow>(
      `UPDATE cloud_allocation SET
         environment = $2, region_group = $3, iso = $4, country = $5,
         cloud_space = $6, mask = $7, cidr = $8, current_range = $9,
         status = $10, remarks = $11, tags = $12, updated_by = $13
       WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [
        id,
        v.environment,
        v.regionGroup,
        v.iso,
        v.country,
        v.cloudSpace,
        v.mask,
        v.cidr,
        v.currentRange,
        v.status,
        v.remarks,
        JSON.stringify(v.tags ?? {}),
        actor,
      ],
    );

    const changes = diff(
      existing.rows[0] as unknown as Record<string, unknown>,
      result.rows[0] as unknown as Record<string, unknown>,
    );
    await recordAudit(client, 'cloud_allocation', id, 'update', actor, changes);
    return toDomain(result.rows[0]);
  });
}

export async function deleteAllocation(id: string, actor: string): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await client.query<AllocationRow>(
      `SELECT ${SELECT_COLUMNS} FROM cloud_allocation WHERE id = $1`,
      [id],
    );
    if (existing.rowCount === 0) {
      throw new HttpError(404, 'Allocation not found.');
    }
    await client.query(`DELETE FROM cloud_allocation WHERE id = $1`, [id]);
    await recordAudit(client, 'cloud_allocation', id, 'delete', actor, {
      deleted: { from: existing.rows[0], to: null },
    });
  });
}

/**
 * Bulk upsert used by the importer. Rows that already exist for the same
 * (environment, region_group, cloud_space, mask, iso) are updated in place.
 */
export async function bulkUpsertAllocations(
  inputs: CloudAllocationInput[],
  actor: string,
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;

  await withTransaction(async (client) => {
    for (const raw of inputs) {
      const v = validate(raw);
      const result = await client.query<{ id: string; was_insert: boolean }>(
        `INSERT INTO cloud_allocation
           (environment, region_group, iso, country, cloud_space, mask, cidr,
            current_range, status, remarks, tags, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
         ON CONFLICT (environment, region_group, cloud_space, mask, COALESCE(iso, ''))
         DO UPDATE SET
           country = EXCLUDED.country,
           cidr = EXCLUDED.cidr,
           current_range = EXCLUDED.current_range,
           status = EXCLUDED.status,
           remarks = EXCLUDED.remarks,
           tags = EXCLUDED.tags,
           updated_by = EXCLUDED.updated_by
         RETURNING id, (xmax = 0) AS was_insert`,
        [
          v.environment,
          v.regionGroup,
          v.iso,
          v.country,
          v.cloudSpace,
          v.mask,
          v.cidr,
          v.currentRange,
          v.status,
          v.remarks,
          JSON.stringify(v.tags ?? {}),
          actor,
        ],
      );
      const row = result.rows[0];
      if (row.was_insert) inserted++;
      else updated++;
      await recordAudit(
        client,
        'cloud_allocation',
        row.id,
        row.was_insert ? 'create' : 'update',
        actor,
        null,
      );
    }
  });

  return { inserted, updated };
}

/** Find allocations that overlap a candidate CIDR — conflict detection. */
export async function findOverlaps(
  cidr: string,
  excludeId?: string,
): Promise<CloudAllocation[]> {
  const normalised = toCidrString(cidr);
  if (!normalised) throw new HttpError(400, 'A valid CIDR is required.');

  const params: unknown[] = [normalised];
  let extra = '';
  if (excludeId) {
    params.push(excludeId);
    extra = ` AND id <> $${params.length}`;
  }

  const rows = await query<AllocationRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM cloud_allocation
      WHERE cidr && $1::cidr${extra}
      ORDER BY cidr`,
    params,
  );
  return rows.map(toDomain);
}
