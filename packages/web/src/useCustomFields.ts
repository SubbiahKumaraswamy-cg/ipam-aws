/**
 * Loads administrator-defined custom fields and turns them into AG Grid
 * columns bound to each record's `attributes` map.
 *
 * This is what lets an administrator add a column without a code change.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ColDef, ValueGetterParams, ValueSetterParams } from 'ag-grid-community';
import type { CustomField, CustomFieldEntity } from '@ipam/shared';
import { api } from './api';

/** A record that carries custom attribute values. */
interface WithAttributes {
  attributes?: Record<string, unknown>;
}

export function useCustomFields(entity: CustomFieldEntity) {
  const [fields, setFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setFields(await api.listCustomFields(entity));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [entity]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Grid columns for the active custom fields.
   *
   * Values are read from and written back into `attributes`, so the normal
   * row-update path persists them with no special handling.
   */
  const columns = useMemo<ColDef[]>(
    () =>
      fields.map((field) => {
        const column: ColDef = {
          colId: `attr_${field.fieldKey}`,
          headerName: field.label,
          width: 150,
          editable: false, // Pages opt in by overriding this.
          headerTooltip:
            field.helpText ??
            `Custom ${field.dataType} column (${field.fieldKey})`,
          valueGetter: (params: ValueGetterParams) => {
            const data = params.data as WithAttributes | undefined;
            return data?.attributes?.[field.fieldKey] ?? null;
          },
          valueSetter: (params: ValueSetterParams) => {
            const data = params.data as WithAttributes;
            const next = { ...(data.attributes ?? {}) };
            if (
              params.newValue === null ||
              params.newValue === undefined ||
              params.newValue === ''
            ) {
              delete next[field.fieldKey];
            } else {
              next[field.fieldKey] = params.newValue;
            }
            data.attributes = next;
            return true;
          },
        };

        if (field.dataType === 'select') {
          column.cellEditor = 'agSelectCellEditor';
          column.cellEditorParams = { values: ['', ...field.options] };
        }
        if (field.dataType === 'number') {
          column.type = 'numericColumn';
        }
        if (field.dataType === 'boolean') {
          column.cellEditor = 'agSelectCellEditor';
          column.cellEditorParams = { values: ['', 'true', 'false'] };
        }

        return column;
      }),
    [fields],
  );

  /** Same columns, but editable — used when the viewer has write rights. */
  const editableColumns = useMemo<ColDef[]>(
    () => columns.map((c) => ({ ...c, editable: true })),
    [columns],
  );

  return { fields, columns, editableColumns, loading, error, reload };
}
