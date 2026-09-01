/**
 * Repository for azure_subscription — the Azure Classic / ARM subscription
 * to address-space mappings.
 */

import type {
  AzureSubscription,
  AzureSubscriptionInput,
  AzurePortalType,
  RegionGroup,
} from '@ipam/shared';
import { AZURE_PORTAL_TYPES, REGION_GROUPS, toCidrString } from '@ipam/shared';
import { query, queryOne, withTransaction } from '../db';
import { HttpError } from '../auth';
import { diff, recordAudit } from './audit';

interface SubscriptionRow {
  id: string;
  portal_type: AzurePortalType;
  subscription: string;
  address_space: string;
  cidr: string | null;
  region_group: RegionGroup | null;
  remarks: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

const SELECT_COLUMNS = `
  id, portal_type, subscription, address_space,
  host(cidr) || '/' || masklen(cidr) AS cidr,
  region_group, remarks, created_at, updated_at, created_by, updated_by
`;

function toDomain(row: SubscriptionRow): AzureSubscription {
  return {
    id: row.id,
    portalType: row.portal_type,
    subscription: row.subscription,
    addressSpace: row.address_space,
    cidr: row.cidr,
    regionGroup: row.region_group,
    remarks: row.remarks,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

function validate(input: AzureSubscriptionInput): AzureSubscriptionInput & {
  cidr: string | null;
} {
  if (!AZURE_PORTAL_TYPES.includes(input.portalType)) {
    throw new HttpError(
      400,
      `portalType must be one of ${AZURE_PORTAL_TYPES.join(' | ')}.`,
    );
  }
  if (!String(input.subscription ?? '').trim()) {
    throw new HttpError(400, 'subscription is required.');
  }
  if (!String(input.addressSpace ?? '').trim()) {
    throw new HttpError(400, 'addressSpace is required.');
  }
  if (
    input.regionGroup &&
    !REGION_GROUPS.includes(input.regionGroup)
  ) {
    throw new HttpError(
      400,
      `regionGroup must be one of ${REGION_GROUPS.join(', ')}.`,
    );
  }

  const cidr =
    input.cidr !== undefined && input.cidr !== null
      ? toCidrString(input.cidr)
      : toCidrString(input.addressSpace);

  return {
    ...input,
    subscription: String(input.subscription).trim(),
    addressSpace: String(input.addressSpace).trim(),
    regionGroup: input.regionGroup ?? null,
    remarks: input.remarks ?? null,
    cidr,
  };
}

export interface SubscriptionFilters {
  portalType?: string;
  regionGroup?: string;
  search?: string;
}

export async function listSubscriptions(
  filters: SubscriptionFilters = {},
): Promise<AzureSubscription[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.portalType) {
    params.push(filters.portalType);
    conditions.push(`portal_type = $${params.length}`);
  }
  if (filters.regionGroup) {
    params.push(filters.regionGroup);
    conditions.push(`region_group = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const i = params.length;
    conditions.push(
      `(subscription ILIKE $${i} OR address_space ILIKE $${i} OR remarks ILIKE $${i})`,
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<SubscriptionRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM azure_subscription
       ${where}
      ORDER BY portal_type, subscription`,
    params,
  );
  return rows.map(toDomain);
}

export async function getSubscription(id: string): Promise<AzureSubscription> {
  const row = await queryOne<SubscriptionRow>(
    `SELECT ${SELECT_COLUMNS} FROM azure_subscription WHERE id = $1`,
    [id],
  );
  if (!row) throw new HttpError(404, 'Azure subscription not found.');
  return toDomain(row);
}

export async function createSubscription(
  input: AzureSubscriptionInput,
  actor: string,
): Promise<AzureSubscription> {
  const v = validate(input);
  return withTransaction(async (client) => {
    const result = await client.query<SubscriptionRow>(
      `INSERT INTO azure_subscription
         (portal_type, subscription, address_space, cidr, region_group,
          remarks, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       RETURNING ${SELECT_COLUMNS}`,
      [
        v.portalType,
        v.subscription,
        v.addressSpace,
        v.cidr,
        v.regionGroup,
        v.remarks,
        actor,
      ],
    );
    const row = result.rows[0];
    await recordAudit(client, 'azure_subscription', row.id, 'create', actor, null);
    return toDomain(row);
  });
}

export async function updateSubscription(
  id: string,
  input: AzureSubscriptionInput,
  actor: string,
): Promise<AzureSubscription> {
  const v = validate(input);
  return withTransaction(async (client) => {
    const existing = await client.query<SubscriptionRow>(
      `SELECT ${SELECT_COLUMNS} FROM azure_subscription WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (existing.rowCount === 0) {
      throw new HttpError(404, 'Azure subscription not found.');
    }

    const result = await client.query<SubscriptionRow>(
      `UPDATE azure_subscription SET
         portal_type = $2, subscription = $3, address_space = $4, cidr = $5,
         region_group = $6, remarks = $7, updated_by = $8
       WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [
        id,
        v.portalType,
        v.subscription,
        v.addressSpace,
        v.cidr,
        v.regionGroup,
        v.remarks,
        actor,
      ],
    );

    const changes = diff(
      existing.rows[0] as unknown as Record<string, unknown>,
      result.rows[0] as unknown as Record<string, unknown>,
    );
    await recordAudit(client, 'azure_subscription', id, 'update', actor, changes);
    return toDomain(result.rows[0]);
  });
}

export async function deleteSubscription(
  id: string,
  actor: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await client.query<SubscriptionRow>(
      `SELECT ${SELECT_COLUMNS} FROM azure_subscription WHERE id = $1`,
      [id],
    );
    if (existing.rowCount === 0) {
      throw new HttpError(404, 'Azure subscription not found.');
    }
    await client.query(`DELETE FROM azure_subscription WHERE id = $1`, [id]);
    await recordAudit(client, 'azure_subscription', id, 'delete', actor, {
      deleted: { from: existing.rows[0], to: null },
    });
  });
}

export async function bulkUpsertSubscriptions(
  inputs: AzureSubscriptionInput[],
  actor: string,
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;

  await withTransaction(async (client) => {
    for (const raw of inputs) {
      const v = validate(raw);
      const result = await client.query<{ id: string; was_insert: boolean }>(
        `INSERT INTO azure_subscription
           (portal_type, subscription, address_space, cidr, region_group,
            remarks, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         ON CONFLICT (portal_type, subscription, address_space)
         DO UPDATE SET
           cidr = EXCLUDED.cidr,
           region_group = EXCLUDED.region_group,
           remarks = EXCLUDED.remarks,
           updated_by = EXCLUDED.updated_by
         RETURNING id, (xmax = 0) AS was_insert`,
        [
          v.portalType,
          v.subscription,
          v.addressSpace,
          v.cidr,
          v.regionGroup,
          v.remarks,
          actor,
        ],
      );
      const row = result.rows[0];
      if (row.was_insert) inserted++;
      else updated++;
    }
  });

  return { inserted, updated };
}
