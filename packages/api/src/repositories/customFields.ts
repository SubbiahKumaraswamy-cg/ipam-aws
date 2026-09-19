/**
 * Repository for custom_field — administrator-defined extra columns.
 *
 * Values live in the owning record's `attributes` JSONB map, so adding a
 * column never requires a schema migration.
 */

import type {
  CustomField,
  CustomFieldInput,
  CustomFieldEntity,
  CustomFieldType,
} from '@ipam/shared';
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPES,
  isValidFieldKey,
} from '@ipam/shared';
import { query, queryOne, withTransaction } from '../db';
import { HttpError } from '../auth';
import { diff, recordAudit } from './audit';

interface FieldRow {
  id: string;
  entity: CustomFieldEntity;
  field_key: string;
  label: string;
  data_type: CustomFieldType;
  options: string[];
  position: number;
  required: boolean;
  active: boolean;
  help_text: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

const SELECT_COLUMNS = `
  id, entity, field_key, label, data_type, options, position, required,
  active, help_text, created_at, updated_at, created_by, updated_by
`;

function toDomain(row: FieldRow): CustomField {
  return {
    id: row.id,
    entity: row.entity,
    fieldKey: row.field_key,
    label: row.label,
    dataType: row.data_type,
    options: row.options ?? [],
    position: row.position,
    required: row.required,
    active: row.active,
    helpText: row.help_text,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

function validate(input: CustomFieldInput): CustomFieldInput {
  if (!CUSTOM_FIELD_ENTITIES.includes(input.entity)) {
    throw new HttpError(
      400,
      `entity must be one of: ${CUSTOM_FIELD_ENTITIES.join(', ')}.`,
    );
  }
  const fieldKey = String(input.fieldKey ?? '').trim().toLowerCase();
  if (!isValidFieldKey(fieldKey)) {
    throw new HttpError(
      400,
      'fieldKey must start with a lower-case letter and contain only ' +
        'lower-case letters, digits and underscores (max 49 characters).',
    );
  }
  if (!String(input.label ?? '').trim()) {
    throw new HttpError(400, 'label is required.');
  }
  const dataType = input.dataType ?? 'text';
  if (!CUSTOM_FIELD_TYPES.includes(dataType)) {
    throw new HttpError(
      400,
      `dataType must be one of: ${CUSTOM_FIELD_TYPES.join(', ')}.`,
    );
  }

  const options = (input.options ?? [])
    .map((o) => String(o).trim())
    .filter(Boolean);

  if (dataType === 'select' && options.length === 0) {
    throw new HttpError(
      400,
      'A "select" field needs at least one option.',
    );
  }

  return {
    entity: input.entity,
    fieldKey,
    label: String(input.label).trim(),
    dataType,
    options,
    position: Number.isFinite(input.position) ? Number(input.position) : 0,
    required: input.required ?? false,
    active: input.active ?? true,
    helpText: input.helpText?.trim() || null,
  };
}

export async function listCustomFields(
  entity?: string,
  includeInactive = false,
): Promise<CustomField[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (entity) {
    if (!CUSTOM_FIELD_ENTITIES.includes(entity as CustomFieldEntity)) {
      throw new HttpError(
        400,
        `entity must be one of: ${CUSTOM_FIELD_ENTITIES.join(', ')}.`,
      );
    }
    params.push(entity);
    conditions.push(`entity = $${params.length}`);
  }
  if (!includeInactive) conditions.push('active');

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<FieldRow>(
    `SELECT ${SELECT_COLUMNS} FROM custom_field ${where}
      ORDER BY entity, position, label`,
    params,
  );
  return rows.map(toDomain);
}

export async function getCustomField(id: string): Promise<CustomField> {
  const row = await queryOne<FieldRow>(
    `SELECT ${SELECT_COLUMNS} FROM custom_field WHERE id = $1`,
    [id],
  );
  if (!row) throw new HttpError(404, 'Custom field not found.');
  return toDomain(row);
}

export async function createCustomField(
  input: CustomFieldInput,
  actor: string,
): Promise<CustomField> {
  const v = validate(input);
  return withTransaction(async (client) => {
    try {
      const result = await client.query<FieldRow>(
        `INSERT INTO custom_field
           (entity, field_key, label, data_type, options, position, required,
            active, help_text, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
         RETURNING ${SELECT_COLUMNS}`,
        [
          v.entity,
          v.fieldKey,
          v.label,
          v.dataType,
          v.options,
          v.position,
          v.required,
          v.active,
          v.helpText,
          actor,
        ],
      );
      const row = result.rows[0];
      await recordAudit(client, 'custom_field', row.id, 'create', actor, null);
      return toDomain(row);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new HttpError(
          409,
          `A field with key "${v.fieldKey}" already exists for ${v.entity}.`,
        );
      }
      throw err;
    }
  });
}

export async function updateCustomField(
  id: string,
  input: CustomFieldInput,
  actor: string,
): Promise<CustomField> {
  const v = validate(input);
  return withTransaction(async (client) => {
    const existing = await client.query<FieldRow>(
      `SELECT ${SELECT_COLUMNS} FROM custom_field WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (existing.rowCount === 0) {
      throw new HttpError(404, 'Custom field not found.');
    }

    // Changing the key would orphan values already stored under the old key.
    if (existing.rows[0].field_key !== v.fieldKey) {
      throw new HttpError(
        409,
        `The field key cannot be changed (existing values are stored under ` +
          `"${existing.rows[0].field_key}"). Create a new field instead.`,
      );
    }

    const result = await client.query<FieldRow>(
      `UPDATE custom_field SET
         label = $2, data_type = $3, options = $4, position = $5,
         required = $6, active = $7, help_text = $8, updated_by = $9
       WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [
        id,
        v.label,
        v.dataType,
        v.options,
        v.position,
        v.required,
        v.active,
        v.helpText,
        actor,
      ],
    );

    await recordAudit(
      client,
      'custom_field',
      id,
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

/**
 * Delete a field definition. Stored values are left untouched in the
 * `attributes` maps; deactivating instead of deleting is usually preferable.
 */
export async function deleteCustomField(
  id: string,
  actor: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await client.query<FieldRow>(
      `SELECT ${SELECT_COLUMNS} FROM custom_field WHERE id = $1`,
      [id],
    );
    if (existing.rowCount === 0) {
      throw new HttpError(404, 'Custom field not found.');
    }
    await client.query(`DELETE FROM custom_field WHERE id = $1`, [id]);
    await recordAudit(client, 'custom_field', id, 'delete', actor, {
      field_key: { from: existing.rows[0].field_key, to: null },
    });
  });
}

/**
 * Validate a record's custom attribute values against the active definitions
 * for its entity. Unknown keys are dropped so stale client payloads cannot
 * write arbitrary data.
 */
export async function sanitiseAttributes(
  entity: CustomFieldEntity,
  attributes: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const definitions = await listCustomFields(entity);
  if (definitions.length === 0) return {};

  const input = attributes ?? {};
  const output: Record<string, unknown> = {};

  for (const field of definitions) {
    const raw = input[field.fieldKey];
    const missing = raw === undefined || raw === null || raw === '';

    if (missing) {
      if (field.required) {
        throw new HttpError(400, `"${field.label}" is required.`);
      }
      continue;
    }

    switch (field.dataType) {
      case 'number': {
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          throw new HttpError(400, `"${field.label}" must be a number.`);
        }
        output[field.fieldKey] = value;
        break;
      }
      case 'boolean': {
        output[field.fieldKey] =
          raw === true || raw === 'true' || raw === 1 || raw === '1';
        break;
      }
      case 'date': {
        const text = String(raw).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
          throw new HttpError(
            400,
            `"${field.label}" must be an ISO date such as 2026-09-19.`,
          );
        }
        output[field.fieldKey] = text;
        break;
      }
      case 'select': {
        const text = String(raw).trim();
        if (!field.options.includes(text)) {
          throw new HttpError(
            400,
            `"${field.label}" must be one of: ${field.options.join(', ')}.`,
          );
        }
        output[field.fieldKey] = text;
        break;
      }
      default:
        output[field.fieldKey] = String(raw);
    }
  }

  return output;
}
