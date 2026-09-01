import { useEffect, useState } from 'react';
import type { AuditEntry } from '@ipam/shared';
import { api } from '../api';

/** Administrator view of the change history. */
export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listAudit(300)
      .then((data) => {
        if (!cancelled) setEntries(data);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const entityLabel: Record<string, string> = {
    cloud_allocation: 'Allocation',
    azure_subscription: 'Azure subscription',
    subnet_plan: 'Subnet plan',
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Audit trail</h2>
          <p>Every create, update and delete, most recent first.</p>
        </div>
      </div>

      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="centered">
          <div className="spinner" aria-label="Loading audit trail" />
        </div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Changes</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {new Date(entry.at).toLocaleString()}
                  </td>
                  <td>{entry.actor ?? <span className="muted">system</span>}</td>
                  <td>
                    <span
                      className={`pill ${
                        entry.action === 'delete'
                          ? 'pill-assigned'
                          : entry.action === 'create'
                            ? 'pill-used'
                            : 'pill-allocated'
                      }`}
                    >
                      {entry.action}
                    </span>
                  </td>
                  <td>
                    {entityLabel[entry.entityType] ?? entry.entityType}
                    <div className="muted" style={{ fontSize: 11 }}>
                      {entry.entityId}
                    </div>
                  </td>
                  <td>
                    {entry.changes ? (
                      <ChangeList changes={entry.changes} />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No changes recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ChangeList({
  changes,
}: {
  changes: Record<string, { from: unknown; to: unknown }>;
}) {
  const format = (value: unknown): string => {
    if (value === null || value === undefined) return '∅';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  const keys = Object.keys(changes).filter((k) => k !== 'deleted');
  if (keys.length === 0) return <span className="muted">—</span>;

  return (
    <ul style={{ margin: 0, paddingLeft: 16 }}>
      {keys.slice(0, 6).map((key) => (
        <li key={key} style={{ fontSize: 12 }}>
          <strong>{key}</strong>: <code>{format(changes[key].from)}</code> →{' '}
          <code>{format(changes[key].to)}</code>
        </li>
      ))}
      {keys.length > 6 && (
        <li className="muted" style={{ fontSize: 12 }}>
          +{keys.length - 6} more
        </li>
      )}
    </ul>
  );
}
