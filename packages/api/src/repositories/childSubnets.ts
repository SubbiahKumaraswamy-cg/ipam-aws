/**
 * Repository for child_subnet — individual allocations carved out of a master
 * subnet, together with the request trail that justifies them.
 *
 * Overlap prevention and containment are enforced by the database (an
 * exclusion constraint and a trigger); this layer turns those guarantees into
 * clear messages and performs the country-scoped permission checks.
 */

import type {
  ChildSubnet,
  ChildSubnetInput,
  RegionGroup,
  ProviderLocation,
  DeploymentEnvironment,
  SubnetStatus,
  AuthenticatedUser,
} from '@ipam/shared';
import {
  PROVIDER_LOCATIONS,
  DEPLOYMENT_ENVIRONMENTS,
  SUBNET_STATUSES,
  toCidrString,
  addressCount,
  usableHosts,
} from '@ipam/shared';
import { query, queryOne, withTransaction } from '../db';
import { HttpError, requireCountryWrite } from '../auth';
import { diff, recordAudit } from './audit';

interface ChildRow {
  id: string;
  master_subnet_id: string;
  cidr: string;
  name: string | null;
  requestor_name: string | null;
  request_date: Date | null;
  allocated_date: Date | null;
  justification: string | null;
  technical_owner: string | null;
  environment: DeploymentEnvironment | null;
  provider_location: ProviderLocation | null;
  status: SubnetStatus;
  remarks: string | null;
  attributes: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
  master_cidr: string | null;
  master_name: string | null;
  region_group: RegionGroup | null;
  country_iso: string | null;
  country_name: string | null;
}

const SELECT_CHILD = `
  SELECT
    ch.id,
    ch.master_subnet_id,
    host(ch.cidr) || '/' || masklen(ch.cidr) AS cidr,
    ch.name,
    ch.requestor_name,
    ch.request_date,
    ch.allocated_date,
    ch.justification,
    ch.technical_owner,
    ch.environment,
    ch.provider_location,
    ch.status,
    ch.remarks,
    ch.attributes,
    ch.created_at,
    ch.updated_at,
    ch.created_by,
    ch.updated_by,
    host(m.cidr) || '/' || masklen(m.cidr) AS master_cidr,
    m.name AS master_name,
    m.region_group,
    m.country_iso,
    c.name AS country_name
  FROM child_subnet ch
  JOIN master_subnet m ON m.id = ch.master_subnet_id
  LEFT JOIN country c ON c.iso = m.country_iso
`;

/** Render a date column as a plain ISO date (no time component). */
function toIsoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function toDomain(row: ChildRow): ChildSubnet {
  return {
    id: row.id,
    masterSubnetId: row.master_subnet_id,
    cidr: row.cidr,
    name: row.name,
    requestorName: row.requestor_name,
    requestDate: toIsoDate(row.request_date),
    allocatedDate: toIsoDate(row.allocated_date),
    justification: row.justification,
    technicalOwner: row.technical_owner,
    environment: row.environment,
    providerLocation: row.provider_location,
    status: row.status,
    remarks: row.remarks,
    attributes: row.attributes ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    masterCidr: row.master_cidr,
    masterName: row.master_name,
    regionGroup: row.region_group,
    countryIso: row.country_iso,
    countryName: row.country_name,
    totalAddresses: addressCount(row.cidr),
    usableHosts: usableHosts(row.cidr),
  };
}

/** Accept an ISO date string, rejecting anything unparseable. */
function normaliseDate(value: string | null | undefined, field: string): string | null {
  if (!value || String(value).trim() === '') return null;
  const raw = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!match) {
    throw new HttpError(
      400,
      `${field} must be an ISO date such as 2026-09-19 (received "${raw}").`,
    );
  }
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, `${field} "${raw}" is not a real date.`);
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function validate(input: ChildSubnetInput): ChildSubnetInput & { cidr: string } {
  if (!input.masterSubnetId) {
    throw new HttpError(400, 'masterSubnetId is required.');
  }
  const cidr = toCidrString(input.cidr);
  if (!cidr) {
    throw new HttpError(
      400,
      `"${input.cidr}" is not a valid IPv4 CIDR. Use a form such as 10.20.1.0/24.`,
    );
  }

  const status = input.status ?? 'Reserved';
  if (!SUBNET_STATUSES.includes(status)) {
    throw new HttpError(
      400,
      `status must be one of: ${SUBNET_STATUSES.join(', ')}.`,
    );
  }
  if (input.environment && !DEPLOYMENT_ENVIRONMENTS.includes(input.environment)) {
    throw new HttpError(
      400,
      `environment must be one of: ${DEPLOYMENT_ENVIRONMENTS.join(', ')}.`,
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

  const requestDate = normaliseDate(input.requestDate, 'requestDate');
  const allocatedDate = normaliseDate(input.allocatedDate, 'allocatedDate');

  if (requestDate && allocatedDate && allocatedDate < requestDate) {
    throw new HttpError(
      400,
      'allocatedDate cannot be earlier than requestDate.',
    );
  }

  return {
    ...input,
    cidr,
    status,
    name: input.name?.trim() || null,
    requestorName: input.requestorName?.trim() || null,
    requestDate,
    allocatedDate,
    justification: input.justification?.trim() || null,
    technicalOwner: input.technicalOwner?.trim() || null,
    remarks: input.remarks ?? null,
    attributes: input.attributes ?? {},
  };
}

/** Turn database guarantees into messages a requester can act on. */
function translateError(err: unknown, cidr: string): never {
  const e = err as { code?: string; constraint?: string; message?: string };

  if (e.code === '23P01' && e.constraint === 'child_subnet_no_overlap') {
    throw new HttpError(
      409,
      `${cidr} overlaps an existing Reserved or Allocated subnet. ` +
        'Use the "Suggest free range" action to pick an available block.',
    );
  }
  if (e.code === '23503') {
    throw new HttpError(400, 'The referenced master subnet does not exist.');
  }
  // Raised by the child_subnet_within_master trigger.
  if (e.code === 'P0001' && e.message) {
    throw new HttpError(409, e.message.replace(/^ERROR:\s*/, ''));
  }
  throw err as Error;
}

/** The country a child belongs to, via its master. Used for authorisation. */
async function countryOfMaster(masterSubnetId: string): Promise<string | null> {
  const row = await queryOne<{ country_iso: string | null }>(
    `SELECT country_iso FROM master_subnet WHERE id = $1`,
    [masterSubnetId],
  );
  if (!row) throw new HttpError(400, 'The referenced master subnet does not exist.');
  return row.country_iso;
}

export interface ChildFilters {
  masterSubnetId?: string;
  regionGroup?: string;
  countryIso?: string;
  status?: string;
  environment?: string;
  providerLocation?: string;
  technicalOwner?: string;
  requestorName?: string;
  search?: string;
  within?: string;
}

export async function listChildren(
  filters: ChildFilters = {},
): Promise<ChildSubnet[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  const eq = (column: string, value: string | undefined, upper = false) => {
    if (!value) return;
    params.push(upper ? value.toUpperCase() : value);
    conditions.push(`${column} = $${params.length}`);
  };

  eq('ch.master_subnet_id', filters.masterSubnetId);
  eq('m.region_group', filters.regionGroup);
  eq('m.country_iso', filters.countryIso, true);
  eq('ch.status', filters.status);
  eq('ch.environment', filters.environment);
  eq('ch.provider_location', filters.providerLocation);

  if (filters.technicalOwner) {
    params.push(`%${filters.technicalOwner}%`);
    conditions.push(`ch.technical_owner ILIKE $${params.length}`);
  }
  if (filters.requestorName) {
    params.push(`%${filters.requestorName}%`);
    conditions.push(`ch.requestor_name ILIKE $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const i = params.length;
    conditions.push(
      `(ch.name ILIKE $${i} OR ch.justification ILIKE $${i} ` +
        `OR ch.technical_owner ILIKE $${i} OR ch.requestor_name ILIKE $${i} ` +
        `OR ch.remarks ILIKE $${i} OR host(ch.cidr) ILIKE $${i} ` +
        `OR c.name ILIKE $${i})`,
    );
  }
  if (filters.within) {
    const normalised = toCidrString(filters.within);
    if (!normalised) throw new HttpError(400, '"within" must be a valid CIDR.');
    params.push(normalised);
    conditions.push(`ch.cidr <<= $${params.length}::cidr`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<ChildRow>(
    `${SELECT_CHILD} ${where} ORDER BY ch.cidr`,
    params,
  );
  return rows.map(toDomain);
}

export async function getChild(id: string): Promise<ChildSubnet> {
  const row = await queryOne<ChildRow>(`${SELECT_CHILD} WHERE ch.id = $1`, [id]);
  if (!row) throw new HttpError(404, 'Child subnet not found.');
  return toDomain(row);
}

export async function createChild(
  input: ChildSubnetInput,
  user: AuthenticatedUser,
): Promise<ChildSubnet> {
  const v = validate(input);

  // Authorise against the country that owns the parent master subnet.
  requireCountryWrite(user, await countryOfMaster(v.masterSubnetId));

  let id: string;
  try {
    id = await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO child_subnet
           (master_subnet_id, cidr, name, requestor_name, request_date,
            allocated_date, justification, technical_owner, environment,
            provider_location, status, remarks, attributes,
            created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
         RETURNING id`,
        [
          v.masterSubnetId,
          v.cidr,
          v.name,
          v.requestorName,
          v.requestDate,
          v.allocatedDate,
          v.justification,
          v.technicalOwner,
          v.environment,
          v.providerLocation,
          v.status,
          v.remarks,
          JSON.stringify(v.attributes ?? {}),
          user.email,
        ],
      );
      const newId = inserted.rows[0].id;
      await recordAudit(client, 'child_subnet', newId, 'create', user.email, null);
      return newId;
    });
  } catch (err) {
    return translateError(err, v.cidr);
  }
  return getChild(id);
}

export async function updateChild(
  id: string,
  input: ChildSubnetInput,
  user: AuthenticatedUser,
): Promise<ChildSubnet> {
  const v = validate(input);

  // The caller must be able to write both the current and the target country,
  // so a record cannot be moved out of (or into) a market they do not own.
  const current = await getChild(id);
  requireCountryWrite(user, current.countryIso);
  if (v.masterSubnetId !== current.masterSubnetId) {
    requireCountryWrite(user, await countryOfMaster(v.masterSubnetId));
  }

  try {
    await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT master_subnet_id, host(cidr)||'/'||masklen(cidr) AS cidr, name,
                requestor_name, request_date, allocated_date, justification,
                technical_owner, environment, provider_location, status,
                remarks, attributes
           FROM child_subnet WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (existing.rowCount === 0) {
        throw new HttpError(404, 'Child subnet not found.');
      }

      const updated = await client.query(
        `UPDATE child_subnet SET
           master_subnet_id = $2, cidr = $3, name = $4, requestor_name = $5,
           request_date = $6, allocated_date = $7, justification = $8,
           technical_owner = $9, environment = $10, provider_location = $11,
           status = $12, remarks = $13, attributes = $14, updated_by = $15
         WHERE id = $1
         RETURNING master_subnet_id, host(cidr)||'/'||masklen(cidr) AS cidr, name,
                   requestor_name, request_date, allocated_date, justification,
                   technical_owner, environment, provider_location, status,
                   remarks, attributes`,
        [
          id,
          v.masterSubnetId,
          v.cidr,
          v.name,
          v.requestorName,
          v.requestDate,
          v.allocatedDate,
          v.justification,
          v.technicalOwner,
          v.environment,
          v.providerLocation,
          v.status,
          v.remarks,
          JSON.stringify(v.attributes ?? {}),
          user.email,
        ],
      );

      await recordAudit(
        client,
        'child_subnet',
        id,
        'update',
        user.email,
        diff(
          existing.rows[0] as Record<string, unknown>,
          updated.rows[0] as Record<string, unknown>,
        ),
      );
    });
  } catch (err) {
    return translateError(err, v.cidr);
  }
  return getChild(id);
}

export async function deleteChild(
  id: string,
  user: AuthenticatedUser,
): Promise<void> {
  const current = await getChild(id);
  requireCountryWrite(user, current.countryIso);

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM child_subnet WHERE id = $1`, [id]);
    await recordAudit(client, 'child_subnet', id, 'delete', user.email, {
      cidr: { from: current.cidr, to: null },
      status: { from: current.status, to: null },
    });
  });
}

/**
 * Release a subnet, returning its space to the pool.
 * Preferred over deletion because it preserves the request history.
 */
export async function releaseChild(
  id: string,
  user: AuthenticatedUser,
): Promise<ChildSubnet> {
  const current = await getChild(id);
  requireCountryWrite(user, current.countryIso);

  if (current.status === 'Released') {
    throw new HttpError(409, `${current.cidr} is already released.`);
  }

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE child_subnet SET status = 'Released', updated_by = $2 WHERE id = $1`,
      [id, user.email],
    );
    await recordAudit(client, 'child_subnet', id, 'update', user.email, {
      status: { from: current.status, to: 'Released' },
    });
  });

  return getChild(id);
}

/** Active child subnets overlapping a candidate CIDR. */
export async function findOverlappingChildren(
  cidr: string,
  excludeId?: string,
): Promise<ChildSubnet[]> {
  const normalised = toCidrString(cidr);
  if (!normalised) throw new HttpError(400, 'A valid CIDR is required.');

  const params: unknown[] = [normalised];
  let extra = '';
  if (excludeId) {
    params.push(excludeId);
    extra = ` AND ch.id <> $${params.length}`;
  }

  const rows = await query<ChildRow>(
    `${SELECT_CHILD}
      WHERE ch.cidr && $1::cidr AND ch.status <> 'Released'${extra}
      ORDER BY ch.cidr`,
    params,
  );
  return rows.map(toDomain);
}
