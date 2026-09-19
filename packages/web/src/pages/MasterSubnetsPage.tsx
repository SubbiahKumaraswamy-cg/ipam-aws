import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { useNavigate } from 'react-router-dom';
import type {
  ColDef,
  CellValueChangedEvent,
  SelectionChangedEvent,
  ICellRendererParams,
  ValueGetterParams,
} from 'ag-grid-community';
import type { Country, MasterSubnet, MasterSubnetInput } from '@ipam/shared';
import {
  REGION_GROUPS,
  PROVIDER_LOCATIONS,
  formatAddressCount,
  formatPercent,
  masterUtilisation,
} from '@ipam/shared';
import { api, downloadCsv } from '../api';
import { useCustomFields } from '../useCustomFields';
import { MasterSubnetDialog } from '../components/MasterSubnetDialog';
import { ImportDialog } from '../components/ImportDialog';
import type { Session } from '../auth';

/**
 * Master subnets with live capacity figures. Allocated and available counts
 * are derived from the child subnets, so they cannot drift.
 */
export function MasterSubnetsPage({ session }: { session: Session }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<MasterSubnet[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [regionFilter, setRegionFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [selected, setSelected] = useState<MasterSubnet[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editing, setEditing] = useState<MasterSubnet | null>(null);

  const custom = useCustomFields('master_subnet');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(
        await api.listMasters({
          regionGroup: regionFilter || undefined,
          countryIso: countryFilter || undefined,
          search: search || undefined,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [regionFilter, countryFilter, search]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .listCountries({ activeOnly: 'true' })
      .then(setCountries)
      .catch(() => setCountries([]));
  }, []);

  /** Persist an inline edit, reverting the cell if the API rejects it. */
  const onCellValueChanged = useCallback(
    async (event: CellValueChangedEvent<MasterSubnet>) => {
      const row = event.data;
      const input: MasterSubnetInput = {
        name: row.name,
        cidr: row.cidr,
        regionGroup: row.regionGroup,
        countryIso: row.countryIso,
        providerLocation: row.providerLocation,
        description: row.description,
        remarks: row.remarks,
        attributes: row.attributes ?? {},
      };
      try {
        const updated = await api.updateMaster(row.id, input);
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

  const onDelete = useCallback(async () => {
    if (selected.length === 0) return;
    const label =
      selected.length === 1 ? selected[0].cidr : `${selected.length} master subnets`;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    try {
      for (const row of selected) await api.deleteMaster(row.id);
      setNotice(`Deleted ${label}.`);
      setSelected([]);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selected, load]);

  /** Editable only where the signed-in user owns the record's country. */
  const editableIf = useCallback(
    (params: { data?: MasterSubnet }) =>
      params.data ? session.canEditCountry(params.data.countryIso) : false,
    [session],
  );

  const columnDefs = useMemo<ColDef<MasterSubnet>[]>(() => {
    const base: ColDef<MasterSubnet>[] = [
      {
        headerName: '',
        colId: 'select',
        checkboxSelection: (p) => editableIf(p as { data?: MasterSubnet }),
        headerCheckboxSelection: false,
        width: 42,
        pinned: 'left',
        editable: false,
        sortable: false,
        filter: false,
        resizable: false,
      },
      {
        field: 'cidr',
        headerName: 'Master Subnet',
        width: 160,
        pinned: 'left',
        editable: editableIf,
        cellClass: 'cell-mono',
      },
      {
        field: 'name',
        headerName: 'Name',
        width: 170,
        pinned: 'left',
        editable: editableIf,
      },
      {
        field: 'regionGroup',
        headerName: 'Region',
        width: 150,
        editable: editableIf,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: { values: REGION_GROUPS },
      },
      {
        field: 'countryIso',
        headerName: 'ISO',
        width: 80,
        editable: editableIf,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: () => ({
          values: ['', ...countries.map((c) => c.iso)],
        }),
      },
      { field: 'countryName', headerName: 'Country', width: 150, editable: false },
      {
        field: 'providerLocation',
        headerName: 'Provider / Location',
        width: 150,
        editable: editableIf,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: { values: ['', ...PROVIDER_LOCATIONS] },
      },
      {
        headerName: 'Total',
        colId: 'total',
        width: 100,
        editable: false,
        type: 'numericColumn',
        valueGetter: (p: ValueGetterParams<MasterSubnet>) =>
          p.data?.totalAddresses ?? 0,
        valueFormatter: (p) => formatAddressCount(Number(p.value)),
        headerTooltip: 'Total addresses in the master subnet',
      },
      {
        headerName: 'Allocated',
        colId: 'allocated',
        width: 110,
        editable: false,
        type: 'numericColumn',
        valueGetter: (p: ValueGetterParams<MasterSubnet>) =>
          p.data?.allocatedAddresses ?? 0,
        valueFormatter: (p) => formatAddressCount(Number(p.value)),
        headerTooltip: 'Consumed by Reserved and Allocated child subnets',
      },
      {
        headerName: 'Available',
        colId: 'available',
        width: 110,
        editable: false,
        type: 'numericColumn',
        valueGetter: (p: ValueGetterParams<MasterSubnet>) =>
          p.data?.availableAddresses ?? 0,
        valueFormatter: (p) => formatAddressCount(Number(p.value)),
      },
      {
        headerName: 'Utilisation',
        colId: 'utilisation',
        width: 150,
        editable: false,
        valueGetter: (p: ValueGetterParams<MasterSubnet>) =>
          p.data ? masterUtilisation(p.data) : 0,
        cellRenderer: (p: ICellRendererParams<MasterSubnet>) => {
          const fraction = Number(p.value ?? 0);
          const percent = Math.round(fraction * 100);
          const tone =
            fraction >= 0.9 ? 'high' : fraction >= 0.7 ? 'medium' : 'low';
          return (
            <div className="meter" title={formatPercent(fraction)}>
              <div className={`meter-fill meter-${tone}`} style={{ width: `${percent}%` }} />
              <span className="meter-label">{formatPercent(fraction)}</span>
            </div>
          );
        },
      },
      {
        headerName: 'Children',
        colId: 'children',
        width: 150,
        editable: false,
        valueGetter: (p: ValueGetterParams<MasterSubnet>) =>
          p.data?.totalChildren ?? 0,
        cellRenderer: (p: ICellRendererParams<MasterSubnet>) => {
          const d = p.data;
          if (!d) return null;
          return (
            <span>
              <span className="pill pill-allocated">{d.allocatedChildren} alloc</span>{' '}
              <span className="pill pill-reserved">{d.reservedChildren} resv</span>
              {d.releasedChildren > 0 && (
                <>
                  {' '}
                  <span className="pill pill-released">{d.releasedChildren} rel</span>
                </>
              )}
            </span>
          );
        },
      },
      {
        headerName: '',
        colId: 'actions',
        width: 160,
        editable: false,
        sortable: false,
        filter: false,
        cellRenderer: (p: ICellRendererParams<MasterSubnet>) => {
          const d = p.data;
          if (!d) return null;
          return (
            <span className="row-actions">
              <button
                type="button"
                className="btn btn-link"
                onClick={() => navigate(`/child-subnets?master=${d.id}`)}
              >
                Children
              </button>
              {session.canEditCountry(d.countryIso) && (
                <button
                  type="button"
                  className="btn btn-link"
                  onClick={() => setEditing(d)}
                >
                  Edit
                </button>
              )}
            </span>
          );
        },
      },
      {
        field: 'description',
        headerName: 'Description',
        flex: 1,
        minWidth: 160,
        editable: editableIf,
      },
      {
        field: 'remarks',
        headerName: 'Remarks',
        flex: 1,
        minWidth: 160,
        editable: editableIf,
      },
    ];

    // Administrator-defined columns appear after the built-in ones.
    const extra = custom.columns.map((c) => ({
      ...c,
      editable: editableIf,
    })) as ColDef<MasterSubnet>[];

    return [...base, ...extra];
  }, [editableIf, countries, custom.columns, navigate, session]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          total: acc.total + r.totalAddresses,
          allocated: acc.allocated + r.allocatedAddresses,
          available: acc.available + r.availableAddresses,
        }),
        { total: 0, allocated: 0, available: 0 },
      ),
    [rows],
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h2>
            Master subnets{' '}
            <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
              ({rows.length})
            </span>
          </h2>
          <p>
            Parent blocks allocated to each country. Master subnets can never
            overlap, and capacity is calculated from their child subnets.
          </p>
        </div>
        <div className="head-stats">
          <span>
            <strong>{formatAddressCount(totals.total)}</strong> total
          </span>
          <span>
            <strong>{formatAddressCount(totals.allocated)}</strong> allocated
          </span>
          <span>
            <strong>{formatAddressCount(totals.available)}</strong> available
          </span>
        </div>
      </div>

      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}
      {notice && !error && <div className="banner-success">{notice}</div>}

      <div className="toolbar">
        <input
          type="search"
          placeholder="Search subnet, name, country…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 230 }}
          aria-label="Search master subnets"
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
          value={countryFilter}
          onChange={(e) => setCountryFilter(e.target.value)}
          aria-label="Filter by country"
        >
          <option value="">All countries</option>
          {countries.map((c) => (
            <option key={c.iso} value={c.iso}>
              {c.iso} — {c.name}
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
              + Add master subnet
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
        {session.canEditAll && (
          <button type="button" className="btn" onClick={() => setShowImport(true)}>
            Import CSV
          </button>
        )}
        <button
          type="button"
          className="btn"
          onClick={() =>
            void downloadCsv('/master-subnets/export', 'master-subnets.csv').catch(
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
        <AgGridReact<MasterSubnet>
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          getRowId={(p) => p.data.id}
          rowSelection={session.canEditSomething ? 'multiple' : undefined}
          suppressRowClickSelection
          onCellValueChanged={(e) => void onCellValueChanged(e)}
          onSelectionChanged={(e: SelectionChangedEvent<MasterSubnet>) =>
            setSelected(e.api.getSelectedRows())
          }
          animateRows
          enableCellTextSelection
          tooltipShowDelay={300}
          loading={loading}
          overlayNoRowsTemplate={
            '<span class="muted">No master subnets yet. Add one to start allocating.</span>'
          }
        />
      </div>

      {showImport && (
        <ImportDialog
          title="Import master subnets"
          expectedHeaders={[
            'Master Subnet',
            'Name',
            'Region',
            'ISO',
            'Provider / Location',
            'Description',
            'Remarks',
          ]}
          onClose={() => {
            setShowImport(false);
            void load();
          }}
          onImport={(csv) => api.importMastersCsv(csv)}
        />
      )}

      {(showNew || editing) && (
        <MasterSubnetDialog
          existing={editing}
          countries={countries}
          session={session}
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
