import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type {
  ColDef,
  CellValueChangedEvent,
  SelectionChangedEvent,
} from 'ag-grid-community';
import type { Country, CountryInput, RegionGroup } from '@ipam/shared';
import { REGION_GROUPS, REGION_GROUP_LABELS } from '@ipam/shared';
import { api, downloadCsv } from '../api';
import { useCustomFields } from '../useCustomFields';
import { ImportDialog } from '../components/ImportDialog';
import { Modal } from '../components/Modal';
import type { Session } from '../auth';

/** Countries (markets), each linked to exactly one region. */
export function CountriesPage({ session }: { session: Session }) {
  const [rows, setRows] = useState<Country[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [regionFilter, setRegionFilter] = useState('');
  const [selected, setSelected] = useState<Country[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const custom = useCustomFields('country');
  // Reference data is managed globally, not per country.
  const canEdit = session.canEditAll;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(
        await api.listCountries({
          regionGroup: regionFilter || undefined,
          search: search || undefined,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [regionFilter, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCellValueChanged = useCallback(
    async (event: CellValueChangedEvent<Country>) => {
      const row = event.data;
      const input: CountryInput = {
        iso: row.iso,
        name: row.name,
        regionGroup: row.regionGroup,
        active: row.active,
        remarks: row.remarks,
        attributes: row.attributes ?? {},
      };
      try {
        const updated = await api.updateCountry(row.iso, input);
        setRows((prev) => prev.map((r) => (r.iso === updated.iso ? updated : r)));
        setNotice(`Saved ${updated.name}.`);
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
      selected.length === 1 ? selected[0].name : `${selected.length} countries`;
    if (!window.confirm(`Delete ${label}?`)) return;
    try {
      for (const row of selected) await api.deleteCountry(row.iso);
      setNotice(`Deleted ${label}.`);
      setSelected([]);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selected, load]);

  const columnDefs = useMemo<ColDef<Country>[]>(() => {
    const base: ColDef<Country>[] = [
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
      { field: 'iso', headerName: 'ISO', width: 90, editable: false, pinned: 'left' },
      {
        field: 'name',
        headerName: 'Country',
        width: 220,
        editable: canEdit,
        pinned: 'left',
      },
      {
        field: 'regionGroup',
        headerName: 'Region',
        width: 160,
        editable: canEdit,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: { values: REGION_GROUPS },
      },
      {
        headerName: 'Region description',
        colId: 'regionLabel',
        width: 250,
        editable: false,
        valueGetter: (p) =>
          p.data ? REGION_GROUP_LABELS[p.data.regionGroup] : '',
      },
      {
        field: 'active',
        headerName: 'Active',
        width: 100,
        editable: canEdit,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: { values: [true, false] },
      },
      {
        field: 'remarks',
        headerName: 'Remarks',
        flex: 1,
        minWidth: 180,
        editable: canEdit,
      },
    ];

    const extra = custom.columns.map((c) => ({
      ...c,
      editable: canEdit,
    })) as ColDef<Country>[];

    return [...base, ...extra];
  }, [canEdit, custom.columns]);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>
            Countries{' '}
            <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
              ({rows.length})
            </span>
          </h2>
          <p>
            Markets that subnets are allocated to. Each country belongs to one
            region, and country owners are assigned on the Admin page.
          </p>
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
          placeholder="Search country or ISO…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 220 }}
          aria-label="Search countries"
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

        <span className="spacer" />

        {canEdit && (
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setShowNew(true)}
            >
              + Add country
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={onDelete}
              disabled={selected.length === 0}
            >
              Delete{selected.length > 0 ? ` (${selected.length})` : ''}
            </button>
            <button type="button" className="btn" onClick={() => setShowImport(true)}>
              Import CSV
            </button>
          </>
        )}
        <button
          type="button"
          className="btn"
          onClick={() =>
            void downloadCsv('/countries/export', 'countries.csv').catch((err) =>
              setError((err as Error).message),
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
        <AgGridReact<Country>
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          getRowId={(p) => p.data.iso}
          rowSelection={canEdit ? 'multiple' : undefined}
          suppressRowClickSelection
          onCellValueChanged={(e) => void onCellValueChanged(e)}
          onSelectionChanged={(e: SelectionChangedEvent<Country>) =>
            setSelected(e.api.getSelectedRows())
          }
          animateRows
          enableCellTextSelection
          loading={loading}
          overlayNoRowsTemplate={
            '<span class="muted">No countries yet. Add one, or import a CSV.</span>'
          }
        />
      </div>

      {showNew && (
        <NewCountryDialog
          onClose={() => setShowNew(false)}
          onCreated={(c) => {
            setShowNew(false);
            setNotice(`Added ${c.name}.`);
            void load();
          }}
        />
      )}

      {showImport && (
        <ImportDialog
          title="Import countries"
          expectedHeaders={['ISO', 'Country', 'Region', 'Active', 'Remarks']}
          onClose={() => {
            setShowImport(false);
            void load();
          }}
          onImport={(csv) => api.importCountriesCsv(csv)}
        />
      )}
    </>
  );
}

function NewCountryDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (c: Country) => void;
}) {
  const [iso, setIso] = useState('');
  const [name, setName] = useState('');
  const [regionGroup, setRegionGroup] = useState<RegionGroup>('EUROPE');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await api.createCountry({
          iso: iso.trim().toUpperCase(),
          name: name.trim(),
          regionGroup,
          active: true,
          remarks: remarks.trim() || null,
          attributes: {},
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add a country"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Add country'}
          </button>
        </>
      }
    >
      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}
      <div className="field-row">
        <div className="field">
          <label htmlFor="ciso">ISO code</label>
          <input
            id="ciso"
            type="text"
            value={iso}
            maxLength={8}
            placeholder="DE"
            onChange={(e) => setIso(e.target.value.toUpperCase())}
          />
        </div>
        <div className="field">
          <label htmlFor="cname">Country name</label>
          <input
            id="cname"
            type="text"
            value={name}
            placeholder="Germany"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="cregion">Region</label>
        <select
          id="cregion"
          value={regionGroup}
          onChange={(e) => setRegionGroup(e.target.value as RegionGroup)}
        >
          {REGION_GROUPS.map((r) => (
            <option key={r} value={r}>
              {r} — {REGION_GROUP_LABELS[r]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="cremarks">Remarks</label>
        <textarea
          id="cremarks"
          rows={2}
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
        />
      </div>
    </Modal>
  );
}
