import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type {
  ColDef,
  CellValueChangedEvent,
  GridReadyEvent,
  SelectionChangedEvent,
  ICellRendererParams,
  ValueGetterParams,
} from 'ag-grid-community';
import type {
  CloudAllocation,
  CloudAllocationInput,
  Environment,
} from '@ipam/shared';
import {
  REGION_GROUPS,
  ALLOCATION_STATUSES,
  toCidrString,
  addressCount,
  utilisation,
  formatPercent,
  isValidCidr,
} from '@ipam/shared';
import { api, downloadCsv } from '../api';
import { ImportDialog } from '../components/ImportDialog';
import { NewAllocationDialog } from '../components/NewAllocationDialog';

interface Props {
  environment: Environment;
  canEdit: boolean;
}

/**
 * Spreadsheet-style view of the cloud allocation table for one environment.
 * Mirrors the source columns (ISO, COUNTRY, CLOUD SPACE, MASK, Current Range,
 * Remarks) and adds derived CIDR / size / utilisation columns.
 */
export function AllocationsPage({ environment, canEdit }: Props) {
  const gridRef = useRef<AgGridReact<CloudAllocation>>(null);
  const [rows, setRows] = useState<CloudAllocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [regionFilter, setRegionFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<CloudAllocation[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listAllocations({
        environment,
        regionGroup: regionFilter || undefined,
        status: statusFilter || undefined,
        search: search || undefined,
      });
      setRows(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [environment, regionFilter, statusFilter, search]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Persist an inline cell edit, reverting the grid if the API rejects it. */
  const onCellValueChanged = useCallback(
    async (event: CellValueChangedEvent<CloudAllocation>) => {
      const row = event.data;
      const input: CloudAllocationInput = {
        environment: row.environment,
        regionGroup: row.regionGroup,
        iso: row.iso,
        country: row.country,
        cloudSpace: row.cloudSpace,
        mask: row.mask,
        currentRange: row.currentRange,
        status: row.status,
        remarks: row.remarks,
        tags: row.tags ?? {},
      };
      try {
        const updated = await api.updateAllocation(row.id, input);
        // Refresh the row so server-derived fields (cidr, updatedAt) show.
        setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        setNotice(`Saved ${updated.country ?? updated.cloudSpace}.`);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
        // Roll the cell back to the previous value.
        event.node.setDataValue(event.column.getColId(), event.oldValue);
      }
    },
    [],
  );

  const onDelete = useCallback(async () => {
    if (selected.length === 0) return;
    const label =
      selected.length === 1
        ? (selected[0].country ?? selected[0].cloudSpace)
        : `${selected.length} rows`;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;

    try {
      await Promise.all(selected.map((r) => api.deleteAllocation(r.id)));
      setNotice(`Deleted ${label}.`);
      setSelected([]);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selected, load]);

  const columnDefs = useMemo<ColDef<CloudAllocation>[]>(
    () => [
      {
        headerName: '',
        colId: 'select',
        checkboxSelection: canEdit,
        headerCheckboxSelection: canEdit,
        width: 42,
        pinned: 'left',
        editable: false,
        sortable: false,
        filter: false,
        resizable: false,
      },
      {
        field: 'regionGroup',
        headerName: 'Region',
        width: 140,
        editable: canEdit,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: { values: REGION_GROUPS },
        pinned: 'left',
      },
      {
        field: 'iso',
        headerName: 'ISO',
        width: 80,
        editable: canEdit,
        pinned: 'left',
      },
      {
        field: 'country',
        headerName: 'COUNTRY',
        width: 170,
        editable: canEdit,
        pinned: 'left',
      },
      {
        field: 'cloudSpace',
        headerName: 'CLOUD SPACE',
        width: 150,
        editable: canEdit,
        cellClass: (params) =>
          params.data && !toCidrString(params.data.cloudSpace, params.data.mask)
            ? 'cell-mono cell-invalid'
            : 'cell-mono',
        tooltipValueGetter: (params) =>
          params.data && !toCidrString(params.data.cloudSpace, params.data.mask)
            ? 'This network + mask combination is not a valid IPv4 CIDR.'
            : undefined,
      },
      {
        field: 'mask',
        headerName: 'MASK',
        width: 130,
        editable: canEdit,
        cellClass: 'cell-mono',
        tooltipValueGetter: () =>
          'Accepts /16, 16 or 255.255.0.0 — all are normalised.',
      },
      {
        field: 'cidr',
        headerName: 'CIDR (derived)',
        width: 150,
        editable: false,
        cellClass: 'cell-mono',
        valueGetter: (params: ValueGetterParams<CloudAllocation>) =>
          params.data?.cidr ??
          toCidrString(params.data?.cloudSpace, params.data?.mask) ??
          '',
      },
      {
        headerName: 'Addresses',
        colId: 'addresses',
        width: 120,
        editable: false,
        type: 'numericColumn',
        valueGetter: (params: ValueGetterParams<CloudAllocation>) => {
          const cidr =
            params.data?.cidr ??
            toCidrString(params.data?.cloudSpace, params.data?.mask);
          return cidr ? addressCount(cidr) : null;
        },
        valueFormatter: (params) =>
          typeof params.value === 'number' ? params.value.toLocaleString() : '—',
      },
      {
        field: 'currentRange',
        headerName: 'Current Range',
        width: 190,
        editable: canEdit,
        cellClass: 'cell-mono',
      },
      {
        headerName: 'Utilisation',
        colId: 'utilisation',
        width: 110,
        editable: false,
        valueGetter: (params: ValueGetterParams<CloudAllocation>) => {
          const cidr =
            params.data?.cidr ??
            toCidrString(params.data?.cloudSpace, params.data?.mask);
          return utilisation(cidr, params.data?.currentRange);
        },
        valueFormatter: (params) =>
          formatPercent(typeof params.value === 'number' ? params.value : null),
      },
      {
        field: 'status',
        headerName: 'Status',
        width: 130,
        editable: canEdit,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: { values: ALLOCATION_STATUSES },
        cellRenderer: (params: ICellRendererParams<CloudAllocation>) => {
          const status = String(params.value ?? '');
          return (
            <span className={`pill pill-${status.toLowerCase()}`}>{status}</span>
          );
        },
      },
      {
        field: 'remarks',
        headerName: 'Remarks',
        flex: 1,
        minWidth: 200,
        editable: canEdit,
      },
      {
        field: 'updatedBy',
        headerName: 'Last edited by',
        width: 180,
        editable: false,
      },
      {
        field: 'updatedAt',
        headerName: 'Updated',
        width: 160,
        editable: false,
        valueFormatter: (params) =>
          params.value ? new Date(String(params.value)).toLocaleString() : '',
      },
    ],
    [canEdit],
  );

  const defaultColDef = useMemo<ColDef>(
    () => ({
      sortable: true,
      filter: true,
      resizable: true,
      floatingFilter: false,
      singleClickEdit: false,
      tooltipComponent: undefined,
    }),
    [],
  );

  const onGridReady = useCallback((event: GridReadyEvent) => {
    event.api.sizeColumnsToFit();
  }, []);

  const invalidCount = rows.filter(
    (r) => !isValidCidr(r.cidr ?? toCidrString(r.cloudSpace, r.mask)),
  ).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h2>
            {environment} allocations{' '}
            <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
              ({rows.length} rows)
            </span>
          </h2>
          <p>
            Address space allocated to each market. {canEdit
              ? 'Double-click any cell to edit; changes save automatically.'
              : 'You have read-only access to this table.'}
          </p>
        </div>
      </div>

      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}
      {notice && !error && <div className="banner-success">{notice}</div>}
      {invalidCount > 0 && (
        <div className="banner-error">
          {invalidCount} row(s) have a CLOUD SPACE / MASK combination that is not a
          valid IPv4 CIDR — they are highlighted in red and excluded from address
          totals.
        </div>
      )}

      <div className="toolbar">
        <input
          type="search"
          placeholder="Search country, network, remarks…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 240 }}
          aria-label="Search allocations"
        />

        <select
          value={regionFilter}
          onChange={(e) => setRegionFilter(e.target.value)}
          aria-label="Filter by region"
        >
          <option value="">All regions</option>
          {REGION_GROUPS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {ALLOCATION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <span className="spacer" />

        {canEdit && (
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setShowNew(true)}
            >
              + Add row
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={onDelete}
              disabled={selected.length === 0}
            >
              Delete{selected.length > 0 ? ` (${selected.length})` : ''}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setShowImport(true)}
            >
              Import CSV
            </button>
          </>
        )}

        <button
          type="button"
          className="btn"
          onClick={() =>
            void downloadCsv(
              `/allocations/export?environment=${environment}`,
              `${environment.toLowerCase()}-allocations.csv`,
            ).catch((err) => setError((err as Error).message))
          }
        >
          Export CSV
        </button>

        <button type="button" className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <div className="grid-wrap ag-theme-quartz">
        <AgGridReact<CloudAllocation>
          ref={gridRef}
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={(params) => params.data.id}
          rowSelection={canEdit ? 'multiple' : undefined}
          suppressRowClickSelection
          onCellValueChanged={(e) => void onCellValueChanged(e)}
          onSelectionChanged={(e: SelectionChangedEvent<CloudAllocation>) =>
            setSelected(e.api.getSelectedRows())
          }
          onGridReady={onGridReady}
          animateRows
          enableCellTextSelection
          tooltipShowDelay={300}
          loading={loading}
          overlayNoRowsTemplate={
            '<span class="muted">No allocations match the current filters.</span>'
          }
        />
      </div>

      {showNew && (
        <NewAllocationDialog
          environment={environment}
          onClose={() => setShowNew(false)}
          onCreated={(row) => {
            setShowNew(false);
            setNotice(`Added ${row.country ?? row.cloudSpace}.`);
            void load();
          }}
        />
      )}

      {showImport && (
        <ImportDialog
          title={`Import ${environment} allocations`}
          expectedHeaders={[
            'Region',
            'ISO',
            'COUNTRY',
            'CLOUD SPACE',
            'MASK',
            'Current Range',
            'Status',
            'Remarks',
          ]}
          onClose={() => {
            setShowImport(false);
            void load();
          }}
          onImport={(csv) => api.importAllocationsCsv(csv, environment)}
        />
      )}
    </>
  );
}
