import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type {
  ColDef,
  CellValueChangedEvent,
  SelectionChangedEvent,
} from 'ag-grid-community';
import type {
  AzureSubscription,
  AzureSubscriptionInput,
  AzurePortalType,
} from '@ipam/shared';
import {
  AZURE_PORTAL_TYPES,
  REGION_GROUPS,
  toCidrString,
  addressCount,
} from '@ipam/shared';
import { api, downloadCsv } from '../api';
import { ImportDialog } from '../components/ImportDialog';
import { Modal } from '../components/Modal';

/**
 * Azure subscription → address space mappings, covering both the Classic
 * (Old Portal) and ARM (New Portal) tables from the spreadsheet.
 */
export function AzureSubscriptionsPage({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<AzureSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [portalFilter, setPortalFilter] = useState('');
  const [selected, setSelected] = useState<AzureSubscription[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(
        await api.listSubscriptions({
          portalType: portalFilter || undefined,
          search: search || undefined,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [portalFilter, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCellValueChanged = useCallback(
    async (event: CellValueChangedEvent<AzureSubscription>) => {
      const row = event.data;
      const input: AzureSubscriptionInput = {
        portalType: row.portalType,
        subscription: row.subscription,
        addressSpace: row.addressSpace,
        regionGroup: row.regionGroup,
        remarks: row.remarks,
      };
      try {
        const updated = await api.updateSubscription(row.id, input);
        setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        setNotice(`Saved ${updated.subscription}.`);
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
      selected.length === 1 ? selected[0].subscription : `${selected.length} rows`;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    try {
      await Promise.all(selected.map((r) => api.deleteSubscription(r.id)));
      setNotice(`Deleted ${label}.`);
      setSelected([]);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selected, load]);

  const columnDefs = useMemo<ColDef<AzureSubscription>[]>(
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
        field: 'portalType',
        headerName: 'Portal',
        width: 190,
        editable: canEdit,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: { values: AZURE_PORTAL_TYPES },
      },
      {
        field: 'subscription',
        headerName: 'Subscription',
        flex: 1,
        minWidth: 240,
        editable: canEdit,
      },
      {
        field: 'addressSpace',
        headerName: 'Address Space',
        width: 180,
        editable: canEdit,
        cellClass: (params) =>
          params.data && !toCidrString(params.data.addressSpace)
            ? 'cell-mono cell-invalid'
            : 'cell-mono',
      },
      {
        headerName: 'Addresses',
        colId: 'addresses',
        width: 120,
        type: 'numericColumn',
        editable: false,
        valueGetter: (params) => {
          const cidr =
            params.data?.cidr ?? toCidrString(params.data?.addressSpace);
          return cidr ? addressCount(cidr) : null;
        },
        valueFormatter: (params) =>
          typeof params.value === 'number' ? params.value.toLocaleString() : '—',
      },
      {
        field: 'regionGroup',
        headerName: 'Region',
        width: 150,
        editable: canEdit,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: { values: ['', ...REGION_GROUPS] },
      },
      {
        field: 'remarks',
        headerName: 'Remarks',
        flex: 1,
        minWidth: 180,
        editable: canEdit,
      },
      {
        field: 'updatedBy',
        headerName: 'Last edited by',
        width: 170,
        editable: false,
      },
    ],
    [canEdit],
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h2>
            Azure subscriptions{' '}
            <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
              ({rows.length} rows)
            </span>
          </h2>
          <p>
            Subscription to address-space mapping for both the Classic (Old
            Portal) and ARM (New Portal) estates.
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
          placeholder="Search subscription, address space…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 240 }}
          aria-label="Search subscriptions"
        />
        <select
          value={portalFilter}
          onChange={(e) => setPortalFilter(e.target.value)}
          aria-label="Filter by portal"
        >
          <option value="">All portals</option>
          {AZURE_PORTAL_TYPES.map((p) => (
            <option key={p} value={p}>
              {p}
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
              '/azure-subscriptions/export',
              'azure-subscriptions.csv',
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
        <AgGridReact<AzureSubscription>
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          getRowId={(params) => params.data.id}
          rowSelection={canEdit ? 'multiple' : undefined}
          suppressRowClickSelection
          onCellValueChanged={(e) => void onCellValueChanged(e)}
          onSelectionChanged={(e: SelectionChangedEvent<AzureSubscription>) =>
            setSelected(e.api.getSelectedRows())
          }
          animateRows
          enableCellTextSelection
          loading={loading}
          overlayNoRowsTemplate={
            '<span class="muted">No subscriptions match the current filters.</span>'
          }
        />
      </div>

      {showNew && (
        <NewSubscriptionDialog
          onClose={() => setShowNew(false)}
          onCreated={(row) => {
            setShowNew(false);
            setNotice(`Added ${row.subscription}.`);
            void load();
          }}
        />
      )}

      {showImport && (
        <ImportDialog
          title="Import Azure subscriptions"
          expectedHeaders={[
            'Portal',
            'Subscription',
            'Address Space',
            'Region',
            'Remarks',
          ]}
          onClose={() => {
            setShowImport(false);
            void load();
          }}
          onImport={(csv) => api.importSubscriptionsCsv(csv)}
        />
      )}
    </>
  );
}

function NewSubscriptionDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (row: AzureSubscription) => void;
}) {
  const [portalType, setPortalType] = useState<AzurePortalType>(
    'ARM (New Portal)',
  );
  const [subscription, setSubscription] = useState('');
  const [addressSpace, setAddressSpace] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!subscription.trim() || !addressSpace.trim()) {
      setError('Subscription and Address Space are both required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await api.createSubscription({
          portalType,
          subscription: subscription.trim(),
          addressSpace: addressSpace.trim(),
          regionGroup: null,
          remarks: remarks.trim() || null,
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
      title="Add Azure subscription"
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
            {busy ? 'Saving…' : 'Add subscription'}
          </button>
        </>
      }
    >
      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}
      <div className="field">
        <label htmlFor="portal">Portal</label>
        <select
          id="portal"
          value={portalType}
          onChange={(e) => setPortalType(e.target.value as AzurePortalType)}
        >
          {AZURE_PORTAL_TYPES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="sub">Subscription</label>
        <input
          id="sub"
          type="text"
          value={subscription}
          onChange={(e) => setSubscription(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="space">Address Space</label>
        <input
          id="space"
          type="text"
          value={addressSpace}
          placeholder="10.30.0.0/16"
          onChange={(e) => setAddressSpace(e.target.value)}
        />
        <p className="field-hint">
          {toCidrString(addressSpace) ? (
            <>
              Normalises to <code>{toCidrString(addressSpace)}</code>
            </>
          ) : (
            'Include the prefix, e.g. 10.30.0.0/16.'
          )}
        </p>
      </div>
      <div className="field">
        <label htmlFor="rem">Remarks</label>
        <textarea
          id="rem"
          rows={2}
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
        />
      </div>
    </Modal>
  );
}
