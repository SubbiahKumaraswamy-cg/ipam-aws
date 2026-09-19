/**
 * Repository for country — the markets that master subnets are allocated to,
 * each linked to exactly one region.
 */

import type { Country, CountryInput, RegionGroup } from '@ipam/shared';
import { REGION_GROUPS } from '@ipam/shared';
import { query, queryOne, withTransaction } from '../db';
import { HttpError } from '../auth';
import { diff, recordAudit } from './audit';

interface CountryRow {
  iso: string;
  name: string;
  region_group: RegionGroup;
  active: boolean;
  remarks: string | null;
  attributes: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

const SELECT_COLUMNS = `
  iso, name, region_group, active, remarks, attributes,
  created_at, updated_at, created_by, updated_by
`;

function toDomain(row: CountryRow): Country {
  return {
    iso: row.iso,
    name: row.name,
    regionGroup: row.region_group,
    active: row.active,
    remarks: row.remarks,
    attributes: row.attributes ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

function validate(input: CountryInput): CountryInput {
  const iso = String(input.iso ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(iso)) {
    throw new HttpError(
      400,
      'iso must be 2–8 letters or digits, e.g. "DE" or "GB".',
    );
  }
  if (!String(input.name ?? '').trim()) {
    throw new HttpError(400, 'name is required.');
  }
  if (!REGION_GROUPS.includes(input.regionGroup)) {
    throw new HttpError(
      400,
      `regionGroup must be one of: ${REGION_GROUPS.join(', ')}.`,
    );
  }

  return {
    iso,
    name: String(input.name).trim(),
    regionGroup: input.regionGroup,
    active: input.active ?? true,
    remarks: input.remarks ?? null,
    attributes: input.attributes ?? {},
  };
}

export interface CountryFilters {
  regionGroup?: string;
  search?: string;
  /** When 'true', only active countries are returned. */
  activeOnly?: string;
}

export async function listCountries(
  filters: CountryFilters = {},
): Promise<Country[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.regionGroup) {
    params.push(filters.regionGroup);
    conditions.push(`region_group = $${params.length}`);
  }
  if (filters.activeOnly === 'true') {
    conditions.push('active');
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const i = params.length;
    conditions.push(`(name ILIKE $${i} OR iso ILIKE $${i} OR remarks ILIKE $${i})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<CountryRow>(
    `SELECT ${SELECT_COLUMNS} FROM country ${where} ORDER BY region_group, name`,
    params,
  );
  return rows.map(toDomain);
}

export async function getCountry(iso: string): Promise<Country> {
  const row = await queryOne<CountryRow>(
    `SELECT ${SELECT_COLUMNS} FROM country WHERE iso = upper($1)`,
    [iso],
  );
  if (!row) throw new HttpError(404, 'Country not found.');
  return toDomain(row);
}

export async function createCountry(
  input: CountryInput,
  actor: string,
): Promise<Country> {
  const v = validate(input);
  return withTransaction(async (client) => {
    try {
      const result = await client.query<CountryRow>(
        `INSERT INTO country
           (iso, name, region_group, active, remarks, attributes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         RETURNING ${SELECT_COLUMNS}`,
        [
          v.iso,
          v.name,
          v.regionGroup,
          v.active,
          v.remarks,
          JSON.stringify(v.attributes ?? {}),
          actor,
        ],
      );
      const row = result.rows[0];
      await recordAudit(client, 'country', row.iso, 'create', actor, null);
      return toDomain(row);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new HttpError(409, `Country ${v.iso} already exists.`);
      }
      throw err;
    }
  });
}

export async function updateCountry(
  iso: string,
  input: CountryInput,
  actor: string,
): Promise<Country> {
  const v = validate({ ...input, iso });
  return withTransaction(async (client) => {
    const existing = await client.query<CountryRow>(
      `SELECT ${SELECT_COLUMNS} FROM country WHERE iso = upper($1) FOR UPDATE`,
      [iso],
    );
    if (existing.rowCount === 0) throw new HttpError(404, 'Country not found.');

    const result = await client.query<CountryRow>(
      `UPDATE country SET
         name = $2, region_group = $3, active = $4, remarks = $5,
         attributes = $6, updated_by = $7
       WHERE iso = upper($1)
       RETURNING ${SELECT_COLUMNS}`,
      [
        iso,
        v.name,
        v.regionGroup,
        v.active,
        v.remarks,
        JSON.stringify(v.attributes ?? {}),
        actor,
      ],
    );

    await recordAudit(
      client,
      'country',
      v.iso,
      'update',
      actor,
      diff(
        existing.rows[0] as unknown as Record<string, unknown>,
        result.rows[0] as unknown as Record<string, unknown>,
      ),
    );
    return toDomain(result.rows[0]);
  });
}

export async function deleteCountry(iso: string, actor: string): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await client.query<{ iso: string; masters: string }>(
      `SELECT iso,
              (SELECT COUNT(*)::text FROM master_subnet WHERE country_iso = c.iso) AS masters
         FROM country c WHERE iso = upper($1)`,
      [iso],
    );
    if (existing.rowCount === 0) throw new HttpError(404, 'Country not found.');

    if (Number(existing.rows[0].masters) > 0) {
      throw new HttpError(
        409,
        `${existing.rows[0].iso} still has ${existing.rows[0].masters} master subnet(s). ` +
          'Reassign or delete them first, or mark the country inactive instead.',
      );
    }

    await client.query(`DELETE FROM country WHERE iso = upper($1)`, [iso]);
    await recordAudit(client, 'country', existing.rows[0].iso, 'delete', actor, null);
  });
}

/** Bulk upsert, used by the CSV importer. */
export async function bulkUpsertCountries(
  inputs: CountryInput[],
  actor: string,
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;

  await withTransaction(async (client) => {
    for (const raw of inputs) {
      const v = validate(raw);
      const result = await client.query<{ was_insert: boolean }>(
        `INSERT INTO country
           (iso, name, region_group, active, remarks, attributes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         ON CONFLICT (iso) DO UPDATE SET
           name = EXCLUDED.name,
           region_group = EXCLUDED.region_group,
           active = EXCLUDED.active,
           remarks = COALESCE(EXCLUDED.remarks, country.remarks),
           updated_by = EXCLUDED.updated_by
         RETURNING (xmax = 0) AS was_insert`,
        [
          v.iso,
          v.name,
          v.regionGroup,
          v.active,
          v.remarks,
          JSON.stringify(v.attributes ?? {}),
          actor,
        ],
      );
      if (result.rows[0].was_insert) inserted++;
      else updated++;
    }
  });

  return { inserted, updated };
}
