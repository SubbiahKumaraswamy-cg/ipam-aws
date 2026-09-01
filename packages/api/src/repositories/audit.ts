/**
 * Audit trail writer. Every mutation records who changed what and when.
 */

import type { PoolClient } from 'pg';
import type { AuditEntry } from '@ipam/shared';
import { query } from '../db';

type EntityType = AuditEntry['entityType'];
type Action = AuditEntry['action'];

/** Compute a field-level diff between two records. */
export function diff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  for (const key of keys) {
    if (key === 'updated_at' || key === 'created_at') continue;
    const from = before?.[key] ?? null;
    const to = after?.[key] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      changes[key] = { from, to };
    }
  }
  return changes;
}

/** Insert an audit row using an existing transaction client. */
export async function recordAudit(
  client: PoolClient,
  entityType: EntityType,
  entityId: string,
  action: Action,
  actor: string | null,
  changes: Record<string, { from: unknown; to: unknown }> | null,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, changes)
     VALUES ($1, $2, $3, $4, $5)`,
    [entityType, entityId, action, actor, changes ? JSON.stringify(changes) : null],
  );
}

interface AuditRow {
  id: string;
  entity_type: string;
  entity_id: string;
  action: Action;
  actor: string | null;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  at: Date;
}

/** List recent audit entries, most recent first. */
export async function listAudit(limit = 200): Promise<AuditEntry[]> {
  const rows = await query<AuditRow>(
    `SELECT id, entity_type, entity_id, action, actor, changes, at
       FROM audit_log
      ORDER BY at DESC
      LIMIT $1`,
    [Math.min(limit, 1000)],
  );
  return rows.map((r) => ({
    id: r.id,
    entityType: r.entity_type as EntityType,
    entityId: r.entity_id,
    action: r.action,
    actor: r.actor,
    changes: r.changes,
    at: r.at.toISOString(),
  }));
}
