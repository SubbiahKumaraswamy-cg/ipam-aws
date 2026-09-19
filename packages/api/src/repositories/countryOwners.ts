/**
 * Repository for country_owner — delegates write access over a single market.
 *
 * A user in the Cognito `CountryOwner` group may modify master and child
 * subnets for the countries listed here, and nothing else.
 */

import type { CountryOwner, CountryOwnerInput, RegionGroup } from '@ipam/shared';
import { query, queryOne, withTransaction } from '../db';
import { HttpError } from '../auth';
import { recordAudit } from './audit';

interface OwnerRow {
  id: string;
  user_email: string;
  country_iso: string;
  country_name: string | null;
  region_group: RegionGroup | null;
  created_at: Date;
  created_by: string | null;
}

const SELECT_OWNER = `
  SELECT o.id, o.user_email, o.country_iso, c.name AS country_name,
         c.region_group, o.created_at, o.created_by
    FROM country_owner o
    LEFT JOIN country c ON c.iso = o.country_iso
`;

function toDomain(row: OwnerRow): CountryOwner {
  return {
    id: row.id,
    userEmail: row.user_email,
    countryIso: row.country_iso,
    countryName: row.country_name,
    regionGroup: row.region_group,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
  };
}

function validate(input: CountryOwnerInput): CountryOwnerInput {
  const email = String(input.userEmail ?? '').trim().toLowerCase();
  // Deliberately permissive: enough to catch typos without rejecting valid
  // corporate addresses.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, `"${input.userEmail}" is not a valid email address.`);
  }
  const countryIso = String(input.countryIso ?? '').trim().toUpperCase();
  if (!countryIso) throw new HttpError(400, 'countryIso is required.');

  return { userEmail: email, countryIso };
}

export async function listCountryOwners(
  userEmail?: string,
  countryIso?: string,
): Promise<CountryOwner[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (userEmail) {
    params.push(userEmail.toLowerCase());
    conditions.push(`o.user_email = $${params.length}`);
  }
  if (countryIso) {
    params.push(countryIso.toUpperCase());
    conditions.push(`o.country_iso = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<OwnerRow>(
    `${SELECT_OWNER} ${where} ORDER BY o.user_email, o.country_iso`,
    params,
  );
  return rows.map(toDomain);
}

export async function createCountryOwner(
  input: CountryOwnerInput,
  actor: string,
): Promise<CountryOwner> {
  const v = validate(input);

  return withTransaction(async (client) => {
    try {
      const result = await client.query<{ id: string }>(
        `INSERT INTO country_owner (user_email, country_iso, created_by)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [v.userEmail, v.countryIso, actor],
      );
      const id = result.rows[0].id;
      await recordAudit(client, 'country_owner', id, 'create', actor, {
        user_email: { from: null, to: v.userEmail },
        country_iso: { from: null, to: v.countryIso },
      });

      const row = await client.query<OwnerRow>(`${SELECT_OWNER} WHERE o.id = $1`, [
        id,
      ]);
      return toDomain(row.rows[0]);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        throw new HttpError(
          409,
          `${v.userEmail} already owns ${v.countryIso}.`,
        );
      }
      if (code === '23503') {
        throw new HttpError(
          400,
          `Country ${v.countryIso} does not exist. Add the country first.`,
        );
      }
      throw err;
    }
  });
}

export async function deleteCountryOwner(
  id: string,
  actor: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await client.query<OwnerRow>(
      `${SELECT_OWNER} WHERE o.id = $1`,
      [id],
    );
    if (existing.rowCount === 0) {
      throw new HttpError(404, 'Country ownership record not found.');
    }
    await client.query(`DELETE FROM country_owner WHERE id = $1`, [id]);
    await recordAudit(client, 'country_owner', id, 'delete', actor, {
      user_email: { from: existing.rows[0].user_email, to: null },
      country_iso: { from: existing.rows[0].country_iso, to: null },
    });
  });
}

/** Replace a user's entire set of owned countries in one operation. */
export async function setCountryOwnerships(
  userEmail: string,
  countryIsos: string[],
  actor: string,
): Promise<CountryOwner[]> {
  const email = String(userEmail ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, `"${userEmail}" is not a valid email address.`);
  }
  const isos = [
    ...new Set(countryIsos.map((c) => String(c).trim().toUpperCase()).filter(Boolean)),
  ];

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM country_owner WHERE user_email = $1`, [email]);
    for (const iso of isos) {
      try {
        await client.query(
          `INSERT INTO country_owner (user_email, country_iso, created_by)
           VALUES ($1,$2,$3)`,
          [email, iso, actor],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23503') {
          throw new HttpError(400, `Country ${iso} does not exist.`);
        }
        throw err;
      }
    }
  });

  return listCountryOwners(email);
}

/** Distinct owners with their country lists, for the admin screen. */
export async function summariseOwners(): Promise<
  { userEmail: string; countries: string[] }[]
> {
  const rows = await query<{ user_email: string; countries: string[] }>(
    `SELECT user_email, array_agg(country_iso ORDER BY country_iso) AS countries
       FROM country_owner
      GROUP BY user_email
      ORDER BY user_email`,
  );
  return rows.map((r) => ({ userEmail: r.user_email, countries: r.countries }));
}

/** Countries a specific user may write. */
export async function countriesForUser(userEmail: string): Promise<string[]> {
  const row = await queryOne<{ countries: string[] }>(
    `SELECT COALESCE(array_agg(country_iso ORDER BY country_iso), '{}') AS countries
       FROM country_owner WHERE user_email = lower($1)`,
    [userEmail],
  );
  return row?.countries ?? [];
}
