import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type {
  ColDef,
  CellValueChangedEvent,
  SelectionChangedEvent,
} from 'ag-grid-community';
import type { SubnetPlanEntry, SubnetPlanEntryInput } from '@ipam/shared';
import { toCidrString, addressCount, prefixToMask } from '@ipam/shared';
import { api, downloadCsv } from '../api';
import { ImportDialog } from '../components/ImportDialog';
import { Modal } from '../components/Modal';

/**
 * The hierarchical subnet plan: /16 subnets rolled up into /14 (255.252.0.0)
 * and /12 (255.240.0.0) aggregates, with allocation, usage and change notes.
 */
export function SubnetPlanPage({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<SubnetPlanEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<SubnetPlanEntry[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await api.listPlanEntries({ search: search || undefined }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCellValueChanged = useCallback(
    async (event: CellValueChangedEvent<SubnetPlanEntry>) => {
      const row = event.data;
      const input: SubnetPlanEntryInput = {
        subnet16: row.subnet16,
        agg14: row.agg14,
        agg12: row.agg12,
        allocation: row.allocation,
        remarks: row.remarks,
        currentUsage: row.currentUsage,
        change: row.change,
      };
      try {
        const updated = await api.updatePlanEntry(row.id, input);
        setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        setNotice(`Saved ${updated.subnet16 ?? updated.allocation ?? 'row'}.`);
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
      selected.length === 1
        ? (selected[0].subnet16 ?? 'this row')
        : `${selected.length} rows`;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    try {
      await Promise.all(selected.map((r) => api.deletePlanEntry(r.id)));
      setNotice(`Deleted ${label}.`);
      setSelected([]);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selected, load]);

  const columnDefs = useMemo<ColDef<SubnetPlanEntry>[]>(
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
        field: 'subnet16',
        headerName: '/16 SUBNETS',
        width: 170,
        editable: canEdit,
        cellClass: 'cell-mono',
      },
      {
        field: 'agg14',
        headerName: `/14 ${prefixToMask(14) ?? ''}`,
        width: 170,
        editable: canEdit,
        cellClass: 'cell-mono',
      },
      {
        field: 'agg12',
        headerName: `/12 ${prefixToMask(12) ?? ''}`,
        width: 170,
        editable: canEdit,
        cellClass: 'cell-mono',
      },
      {
        headerName: 'Addresses (/16)',
        colId: 'addresses',
        width: 140,
        type: 'numericColumn',
        editable: false,
        valueGetter: (params) =>
          params.data?.subnet16 ? addressCount(params.data.subnet16) : null,
        valueFormatter: (params) =>
          typeof params.value === 'number' ? params.value.toLocaleString() : '—',
      },
      {
        field: 'allocation',
        headerName: 'Allocation',
        flex: 1,
        minWidth: 180,
        editable: canEdit,
      },
      {
        field: 'currentUsage',
        headerName: 'Current usage',
        width: 160,
        editable: canEdit,
      },
      {
        field: 'remarks',
        headerName: 'Remarks',
        flex: 1,
        minWidth: 180,
        editable: canEdit,
      },
      {
        field: 'change',
        headerName: 'Change',
        width: 160,
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
            Subnet plan{' '}
            <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
              ({rows.length} rows)
            </span>
          </h2>
          <p>
            Hierarchical address plan — /16 subnets rolled up into /14 (
            <code>255.252.0.0</code>) and /12 (<code>255.240.0.0</code>)
            aggregates.
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
          placeholder="Search allocation, remarks, usage…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 260 }}
          aria-label="Search subnet plan"
        />
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
            void downloadCsv('/subnet-plan/export', 'subnet-plan.csv').catch(
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
        <AgGridReact<SubnetPlanEntry>
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          getRowId={(params) => params.data.id}
          rowSelection={canEdit ? 'multiple' : undefined}
          suppressRowClickSelection
          onCellValueChanged={(e) => void onCellValueChanged(e)}
          onSelectionChanged={(e: SelectionChangedEvent<SubnetPlanEntry>) =>
            setSelected(e.api.getSelectedRows())
          }
          animateRows
          enableCellTextSelection
          loading={loading}
          overlayNoRowsTemplate={
            '<span class="muted">No subnet plan entries yet.</span>'
          }
        />
      </div>

      {showNew && (
        <NewPlanEntryDialog
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            setNotice('Row added.');
            void load();
          }}
        />
      )}

      {showImport && (
        <ImportDialog
          title="Import subnet plan"
          expectedHeaders={[
            '/16 SUBNETS',
            '/14 255.252.0.0',
            '/12 255.240.0.0',
            'Allocation',
            'Remarks',
            'Current usage',
            'Change',
          ]}
          onClose={() => {
            setShowImport(false);
            void load();
          }}
          onImport={(csv) => api.importPlanCsv(csv)}
        />
      )}
    </>
  );
}

function NewPlanEntryDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [subnet16, setSubnet16] = useState('');
  const [agg14, setAgg14] = useState('');
  const [agg12, setAgg12] = useState('');
  const [allocation, setAllocation] = useState('');
  const [currentUsage, setCurrentUsage] = useState('');
  const [remarks, setRemarks] = useState('');
  const [change, setChange] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.createPlanEntry({
        subnet16: subnet16.trim() || null,
        agg14: agg14.trim() || null,
        agg12: agg12.trim() || null,
        allocation: allocation.trim() || null,
        currentUsage: currentUsage.trim() || null,
        remarks: remarks.trim() || null,
        change: change.trim() || null,
      });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add subnet plan entry"
      subtitle="Provide at least one CIDR or an allocation label."
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
            {busy ? 'Saving…' : 'Add row'}
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
        <label htmlFor="s16">/16 subnet</label>
        <input
          id="s16"
          type="text"
          value={subnet16}
          placeholder="10.20.0.0/16"
          onChange={(e) => setSubnet16(e.target.value)}
        />
        {subnet16 && !toCidrString(subnet16) && (
          <p className="field-hint" style={{ color: 'var(--danger)' }}>
            Not a valid IPv4 CIDR.
          </p>
        )}
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="a14">/14 aggregate</label>
          <input
            id="a14"
            type="text"
            value={agg14}
            placeholder="10.20.0.0/14"
            onChange={(e) => setAgg14(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="a12">/12 aggregate</label>
          <input
            id="a12"
            type="text"
            value={agg12}
            placeholder="10.16.0.0/12"
            onChange={(e) => setAgg12(e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="alloc">Allocation</label>
        <input
          id="alloc"
          type="text"
          value={allocation}
          onChange={(e) => setAllocation(e.target.value)}
        />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="usage">Current usage</label>
          <input
            id="usage"
            type="text"
            value={currentUsage}
            onChange={(e) => setCurrentUsage(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="chg">Change</label>
          <input
            id="chg"
            type="text"
            value={change}
            onChange={(e) => setChange(e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="rmk">Remarks</label>
        <textarea
          id="rmk"
          rows={2}
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
        />
      </div>
    </Modal>
  );
}
