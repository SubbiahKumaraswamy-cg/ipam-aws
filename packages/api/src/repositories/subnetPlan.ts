/**
 * Repository for subnet_plan — the hierarchical /12 -> /14 -> /16 planning
 * table, including Allocation / Remarks / Current usage / Change columns.
 */

import type { SubnetPlanEntry, SubnetPlanEntryInput } from '@ipam/shared';
import { toCidrString } from '@ipam/shared';
import { query, queryOne, withTransaction } from '../db';
import { HttpError } from '../auth';
import { diff, recordAudit } from './audit';

interface PlanRow {
  id: string;
  subnet_16: string | null;
  agg_14: string | null;
  agg_12: string | null;
  allocation: string | null;
  remarks: string | null;
  current_usage: string | null;
  change: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

const SELECT_COLUMNS = `
  id,
  CASE WHEN subnet_16 IS NULL THEN NULL ELSE host(subnet_16) || '/' || masklen(subnet_16) END AS subnet_16,
  CASE WHEN agg_14    IS NULL THEN NULL ELSE host(agg_14)    || '/' || masklen(agg_14)    END AS agg_14,
  CASE WHEN agg_12    IS NULL THEN NULL ELSE host(agg_12)    || '/' || masklen(agg_12)    END AS agg_12,
  allocation, remarks, current_usage, change,
  created_at, updated_at, created_by, updated_by
`;

function toDomain(row: PlanRow): SubnetPlanEntry {
  return {
    id: row.id,
    subnet16: row.subnet_16,
    agg14: row.agg_14,
    agg12: row.agg_12,
    allocation: row.allocation,
    remarks: row.remarks,
    currentUsage: row.current_usage,
    change: row.change,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

/**
 * Normalise the three CIDR columns. Each is optional, but when present it
 * must parse; an unparseable value is a client error rather than silently
 * discarded data.
 */
function validate(input: SubnetPlanEntryInput): {
  subnet16: string | null;
  agg14: string | null;
  agg12: string | null;
  allocation: string | null;
  remarks: string | null;
  currentUsage: string | null;
  change: string | null;
} {
  const normalise = (value: string | null, field: string): string | null => {
    if (value === null || value === undefined || String(value).trim() === '') {
      return null;
    }
    const cidr = toCidrString(String(value));
    if (!cidr) {
      throw new HttpError(400, `${field} "${value}" is not a valid IPv4 CIDR.`);
    }
    return cidr;
  };

  const subnet16 = normalise(input.subnet16, 'subnet16');
  const agg14 = normalise(input.agg14, 'agg14');
  const agg12 = normalise(input.agg12, 'agg12');

  if (!subnet16 && !agg14 && !agg12 && !input.allocation) {
    throw new HttpError(
      400,
      'At least one of subnet16, agg14, agg12 or allocation must be provided.',
    );
  }

  return {
    subnet16,
    agg14,
    agg12,
    allocation: input.allocation ? String(input.allocation).trim() : null,
    remarks: input.remarks ?? null,
    currentUsage: input.currentUsage ?? null,
    change: input.change ?? null,
  };
}

export interface PlanFilters {
  search?: string;
  /** Return rows whose /16 falls inside this CIDR. */
  within?: string;
}

export async function listPlanEntries(
  filters: PlanFilters = {},
): Promise<SubnetPlanEntry[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.search) {
    params.push(`%${filters.search}%`);
    const i = params.length;
    conditions.push(
      `(allocation ILIKE $${i} OR remarks ILIKE $${i} OR current_usage ILIKE $${i} OR change ILIKE $${i})`,
    );
  }
  if (filters.within) {
    const normalised = toCidrString(filters.within);
    if (!normalised) throw new HttpError(400, '"within" must be a valid CIDR.');
    params.push(normalised);
    conditions.push(`subnet_16 <<= $${params.length}::cidr`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<PlanRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM subnet_plan
       ${where}
      ORDER BY agg_12 NULLS LAST, agg_14 NULLS LAST, subnet_16 NULLS LAST`,
    params,
  );
  return rows.map(toDomain);
}

export async function getPlanEntry(id: string): Promise<SubnetPlanEntry> {
  const row = await queryOne<PlanRow>(
    `SELECT ${SELECT_COLUMNS} FROM subnet_plan WHERE id = $1`,
    [id],
  );
  if (!row) throw new HttpError(404, 'Subnet plan entry not found.');
  return toDomain(row);
}

export async function createPlanEntry(
  input: SubnetPlanEntryInput,
  actor: string,
): Promise<SubnetPlanEntry> {
  const v = validate(input);
  return withTransaction(async (client) => {
    const result = await client.query<PlanRow>(
      `INSERT INTO subnet_plan
         (subnet_16, agg_14, agg_12, allocation, remarks, current_usage,
          change, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
       RETURNING ${SELECT_COLUMNS}`,
      [
        v.subnet16,
        v.agg14,
        v.agg12,
        v.allocation,
        v.remarks,
        v.currentUsage,
        v.change,
        actor,
      ],
    );
    const row = result.rows[0];
    await recordAudit(client, 'subnet_plan', row.id, 'create', actor, null);
    return toDomain(row);
  });
}

export async function updatePlanEntry(
  id: string,
  input: SubnetPlanEntryInput,
  actor: string,
): Promise<SubnetPlanEntry> {
  const v = validate(input);
  return withTransaction(async (client) => {
    const existing = await client.query<PlanRow>(
      `SELECT ${SELECT_COLUMNS} FROM subnet_plan WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (existing.rowCount === 0) {
      throw new HttpError(404, 'Subnet plan entry not found.');
    }

    const result = await client.query<PlanRow>(
      `UPDATE subnet_plan SET
         subnet_16 = $2, agg_14 = $3, agg_12 = $4, allocation = $5,
         remarks = $6, current_usage = $7, change = $8, updated_by = $9
       WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [
        id,
        v.subnet16,
        v.agg14,
        v.agg12,
        v.allocation,
        v.remarks,
        v.currentUsage,
        v.change,
        actor,
      ],
    );

    const changes = diff(
      existing.rows[0] as unknown as Record<string, unknown>,
      result.rows[0] as unknown as Record<string, unknown>,
    );
    await recordAudit(client, 'subnet_plan', id, 'update', actor, changes);
    return toDomain(result.rows[0]);
  });
}

export async function deletePlanEntry(id: string, actor: string): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await client.query<PlanRow>(
      `SELECT ${SELECT_COLUMNS} FROM subnet_plan WHERE id = $1`,
      [id],
    );
    if (existing.rowCount === 0) {
      throw new HttpError(404, 'Subnet plan entry not found.');
    }
    await client.query(`DELETE FROM subnet_plan WHERE id = $1`, [id]);
    await recordAudit(client, 'subnet_plan', id, 'delete', actor, {
      deleted: { from: existing.rows[0], to: null },
    });
  });
}

export async function bulkUpsertPlanEntries(
  inputs: SubnetPlanEntryInput[],
  actor: string,
): Promise<{ inserted: number }> {
  let inserted = 0;
  await withTransaction(async (client) => {
    for (const raw of inputs) {
      const v = validate(raw);
      await client.query(
        `INSERT INTO subnet_plan
           (subnet_16, agg_14, agg_12, allocation, remarks, current_usage,
            change, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [
          v.subnet16,
          v.agg14,
          v.agg12,
          v.allocation,
          v.remarks,
          v.currentUsage,
          v.change,
          actor,
        ],
      );
      inserted++;
    }
  });
  return { inserted };
}
