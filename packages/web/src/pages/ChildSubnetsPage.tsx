import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AgGridReact } from 'ag-grid-react';
import type {
  ColDef,
  CellValueChangedEvent,
  SelectionChangedEvent,
  ICellRendererParams,
} from 'ag-grid-community';
import type { ChildSubnet, ChildSubnetInput, MasterSubnet } from '@ipam/shared';
import {
  REGION_GROUPS,
  PROVIDER_LOCATIONS,
  DEPLOYMENT_ENVIRONMENTS,
  SUBNET_STATUSES,
} from '@ipam/shared';
import { api, downloadCsv } from '../api';
import { useCustomFields } from '../useCustomFields';
import { ChildSubnetDialog } from '../components/ChildSubnetDialog';
import type { Session } from '../auth';

/**
 * Child subnet allocations, including the full request trail.
 * Editing is permitted only for countries the signed-in user owns.
 */
export function ChildSubnetsPage({ session }: { session: Session }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const masterParam = searchParams.get('master') ?? '';

  const [rows, setRows] = useState<ChildSubnet[]>([]);
  const [masters, setMasters] = useState<MasterSubnet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [regionFilter, setRegionFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [envFilter, setEnvFilter] = useState('');
  const [selected, setSelected] = useState<ChildSubnet[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<ChildSubnet | null>(null);

  const custom = useCustomFields('child_subnet');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(
        await api.listChildren({
          masterSubnetId: masterParam || undefined,
          regionGroup: regionFilter || undefined,
          status: statusFilter || undefined,
          environment: envFilter || undefined,
          search: search || undefined,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [masterParam, regionFilter, statusFilter, envFilter, search]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api.listMasters().then(setMasters).catch(() => setMasters([]));
  }, []);

  const onCellValueChanged = useCallback(
    async (event: CellValueChangedEvent<ChildSubnet>) => {
      const row = event.data;
      const input: ChildSubnetInput = {
        masterSubnetId: row.masterSubnetId,
        cidr: row.cidr,
        name: row.name,
        requestorName: row.requestorName,
        requestDate: row.requestDate,
        allocatedDate: row.allocatedDate,
        justification: row.justification,
        technicalOwner: row.technicalOwner,
        environment: row.environment,
        providerLocation: row.providerLocation,
        status: row.status,
        remarks: row.remarks,
        attributes: row.attributes ?? {},
      };
      try {
        const updated = await api.updateChild(row.id, input);
        setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        setNotice(`Saved ${updated.cidr}.`);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
        event.node.setDataValue(event.column.getColId(), event.oldValue);
      }
    },
    [],
  );

  /** Releasing preserves the request history, unlike deleting. */
  const onRelease = useCallback(async () => {
    const targets = selected.filter((r) => r.status !== 'Released');
    if (targets.length === 0) return;
    if (
      !window.confirm(
        `Release ${
          targets.length === 1 ? targets[0].cidr : `${targets.length} subnets`
        }? The address space returns to the pool and can be re-allocated.`,
      )
    ) {
      return;
    }
    try {
      for (const row of targets) await api.releaseChild(row.id);
      setNotice(`Released ${targets.length} subnet(s).`);
      setSelected([]);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selected, load]);

  const onDelete = useCallback(async () => {
    if (selected.length === 0) return;
    const label =
      selected.length === 1 ? selected[0].cidr : `${selected.length} subnets`;
    if (
      !window.confirm(
        `Permanently delete ${label}? Releasing is usually preferable because it keeps the request history.`,
      )
    ) {
      return;
    }
    try {
      for (const row of selected) await api.deleteChild(row.id);
      setNotice(`Deleted ${label}.`);
      setSelected([]);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selected, load]);

  const editableIf = useCallback(
    (params: { data?: ChildSubnet }) =>
      params.data ? session.canEditCountry(params.data.countryIso) : false,
    [session],
  );

  const columnDefs = useMemo<ColDef<ChildSubnet>[]>(() => {
    const base: ColDef<ChildSubnet>[] = [
      {
        headerName: '',
        colId: 'select',
        checkboxSelection: (p) => editableIf(p as { data?: ChildSubnet }),
        width: 42,
        pinned: 'left',
        editable: false,
        sortable: false,
        filter: false,
        resizable: false,
      },
      {
        field: 'cidr',
        headerName: 'Child Subnet',
        width: 150,
        pinned: 'left',
        editable: editableIf,
        cellClass: 'cell-mono',
      },
      {
        field: 'name',
        headerName: 'Name',
        width: 160,
        pinned: 'left',
        editable: editableIf,
      },
      {
        field: 'status',
        headerName: 'Status',
        width: 120,
        editable: editableIf,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: { values: SUBNET_STATUSES },
        cellRenderer: (p: ICellRendererParams<ChildSubnet>) => {
          const status = String(p.value ?? '');
          return (
            <span className={`pill pill-${status.toLowerCase()}`}>{status}</span>
          );
        },
      },
      {
        field: 'masterCidr',
        headerName: 'Master Subnet',
        width: 150,
        editable: false,
        cellClass: 'cell-mono',
      },
      { field: 'regionGroup', headerName: 'Region', width: 140, editable: false },
      { field: 'countryIso', headerName: 'ISO', width: 75, editable: false },
      { field: 'countryName', headerName: 'Country', width: 140, editable: false },
      {
        field: 'environment',
        headerName: 'Environment',
        width: 130,
        editable: editableIf,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: { values: ['', ...DEPLOYMENT_ENVIRONMENTS] },
      },
      {
        field: 'providerLocation',
        headerName: 'Provider / Location',
        width: 150,
        editable: editableIf,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: { values: ['', ...PROVIDER_LOCATIONS] },
      },
      {
        field: 'requestorName',
        headerName: 'Requestor Name',
        width: 160,
        editable: editableIf,
      },
      {
        field: 'requestDate',
        headerName: 'Request Date',
        width: 130,
        editable: editableIf,
        headerTooltip: 'ISO format, e.g. 2026-09-19',
      },
      {
        field: 'allocatedDate',
        headerName: 'Allocated Date',
        width: 135,
        editable: editableIf,
        headerTooltip: 'ISO format, e.g. 2026-09-19',
      },
      {
        field: 'technicalOwner',
        headerName: 'Technical Owner',
        width: 170,
        editable: editableIf,
      },
      {
        field: 'justification',
        headerName: 'Justification / Purpose',
        flex: 1,
        minWidth: 200,
        editable: editableIf,
      },
      {
        field: 'usableHosts',
        headerName: 'Hosts',
        width: 90,
        editable: false,
        type: 'numericColumn',
        valueFormatter: (p) =>
          typeof p.value === 'number' ? p.value.toLocaleString() : '—',
        headerTooltip: 'Usable host addresses (total minus network and broadcast)',
      },
      {
        field: 'remarks',
        headerName: 'Remarks',
        flex: 1,
        minWidth: 160,
        editable: editableIf,
      },
      {
        headerName: '',
        colId: 'actions',
        width: 80,
        editable: false,
        sortable: false,
        filter: false,
        cellRenderer: (p: ICellRendererParams<ChildSubnet>) => {
          const d = p.data;
          if (!d || !session.canEditCountry(d.countryIso)) return null;
          return (
            <button
              type="button"
              className="btn btn-link"
              onClick={() => setEditing(d)}
            >
              Edit
            </button>
          );
        },
      },
      {
        field: 'updatedBy',
        headerName: 'Last edited by',
        width: 170,
        editable: false,
      },
    ];

    const extra = custom.columns.map((c) => ({
      ...c,
      editable: editableIf,
    })) as ColDef<ChildSubnet>[];

    return [...base, ...extra];
  }, [editableIf, custom.columns, session]);

  const activeMaster = masters.find((m) => m.id === masterParam);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>
            Child subnets{' '}
            <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
              ({rows.length})
            </span>
          </h2>
          <p>
            Individual allocations carved from a master subnet, with the request
            trail. Overlapping ranges are rejected automatically.
          </p>
        </div>
      </div>

      {activeMaster && (
        <div className="banner banner-info">
          Filtered to master subnet <code>{activeMaster.cidr}</code>
          {activeMaster.countryName ? ` (${activeMaster.countryName})` : ''} —{' '}
          {activeMaster.availableAddresses.toLocaleString()} addresses available.{' '}
          <button
            type="button"
            className="btn btn-link"
            onClick={() => setSearchParams({})}
          >
            Clear filter
          </button>
        </div>
      )}

      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}
      {notice && !error && <div className="banner-success">{notice}</div>}

      <div className="toolbar">
        <input
          type="search"
          placeholder="Search subnet, owner, requestor, purpose…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 250 }}
          aria-label="Search child subnets"
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
          {SUBNET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={envFilter}
          onChange={(e) => setEnvFilter(e.target.value)}
          aria-label="Filter by environment"
        >
          <option value="">All environments</option>
          {DEPLOYMENT_ENVIRONMENTS.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>

        <span className="spacer" />

        {session.canEditSomething && (
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setShowNew(true)}
            >
              + Request subnet
            </button>
            <button
              type="button"
              className="btn"
              onClick={onRelease}
              disabled={selected.every((r) => r.status === 'Released')}
            >
              Release
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={onDelete}
              disabled={selected.length === 0}
            >
              Delete{selected.length > 0 ? ` (${selected.length})` : ''}
            </button>
          </>
        )}
        <button
          type="button"
          className="btn"
          onClick={() =>
            void downloadCsv('/child-subnets/export', 'child-subnets.csv').catch(
              (err) => setError((err as Error).message),
            )
          }
        >
          Export CSV
        </button>
        <button type="button" className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <div className="grid-wrap ag-theme-quartz">
        <AgGridReact<ChildSubnet>
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          getRowId={(p) => p.data.id}
          rowSelection={session.canEditSomething ? 'multiple' : undefined}
          suppressRowClickSelection
          onCellValueChanged={(e) => void onCellValueChanged(e)}
          onSelectionChanged={(e: SelectionChangedEvent<ChildSubnet>) =>
            setSelected(e.api.getSelectedRows())
          }
          rowClassRules={{
            'row-released': (p) => p.data?.status === 'Released',
          }}
          animateRows
          enableCellTextSelection
          tooltipShowDelay={300}
          loading={loading}
          overlayNoRowsTemplate={
            '<span class="muted">No child subnets match the current filters.</span>'
          }
        />
      </div>

      {(showNew || editing) && (
        <ChildSubnetDialog
          existing={editing}
          masters={masters}
          session={session}
          defaultMasterId={masterParam || undefined}
          onClose={() => {
            setShowNew(false);
            setEditing(null);
          }}
          onSaved={(row) => {
            setShowNew(false);
            setEditing(null);
            setNotice(`Saved ${row.cidr}.`);
            void load();
          }}
        />
      )}
    </>
  );
}
