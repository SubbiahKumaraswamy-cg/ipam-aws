import { useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { DashboardSummary } from '@ipam/shared';
import { REGION_GROUP_LABELS } from '@ipam/shared';
import { api } from '../api';

const STATUS_COLOURS: Record<string, string> = {
  Available: '#98a2b3',
  Allocated: '#1d4ed8',
  Assigned: '#b26a00',
  Used: '#1b7f4b',
};

const ENV_COLOURS: Record<string, string> = {
  AWS: '#ff9900',
  Azure: '#0078d4',
};

/** Format large address counts compactly, e.g. 1048576 -> "1.0M". */
function formatCount(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .dashboard()
      .then((data) => {
        if (!cancelled) setSummary(data);
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

  if (loading) {
    return (
      <div className="centered">
        <div className="spinner" aria-label="Loading dashboard" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="banner-error" role="alert">
        Could not load the dashboard: {error}
      </div>
    );
  }

  if (!summary) return null;

  const regionData = summary.byRegion.map((r) => ({
    name: r.regionGroup,
    label: REGION_GROUP_LABELS[r.regionGroup] ?? r.regionGroup,
    allocations: r.count,
    addresses: r.addresses,
  }));

  const envData = summary.byEnvironment.map((e) => ({
    name: e.environment,
    allocations: e.count,
    addresses: e.addresses,
  }));

  const statusData = summary.byStatus.map((s) => ({
    name: s.status,
    value: s.count,
  }));

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Dashboard</h2>
          <p>
            Address space allocated to markets across AWS and Azure, by region
            grouping and lifecycle status.
          </p>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="stat-label">Total allocations</div>
          <div className="stat-value">{summary.totalAllocations}</div>
          <div className="stat-hint">rows across AWS &amp; Azure</div>
        </div>
        <div className="stat">
          <div className="stat-label">Addresses allocated</div>
          <div className="stat-value">{formatCount(summary.totalAddresses)}</div>
          <div className="stat-hint">
            {summary.totalAddresses.toLocaleString()} IPv4 addresses
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Azure subscriptions</div>
          <div className="stat-value">{summary.azureSubscriptions}</div>
          <div className="stat-hint">Classic + ARM portals</div>
        </div>
        <div className="stat">
          <div className="stat-label">Subnet plan entries</div>
          <div className="stat-value">{summary.subnetPlanEntries}</div>
          <div className="stat-hint">/12 → /14 → /16 hierarchy</div>
        </div>
      </div>

      <div className="chart-grid">
        <div className="card">
          <h3>Allocations by region grouping</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={regionData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip
                formatter={(value: number, key: string) =>
                  key === 'addresses'
                    ? [value.toLocaleString(), 'Addresses']
                    : [value, 'Allocations']
                }
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar
                dataKey="allocations"
                name="Allocations"
                fill="#1d4ed8"
                radius={[3, 3, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <h3>Address space by region grouping</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={regionData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={formatCount} tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(value: number) => [
                  value.toLocaleString(),
                  'IPv4 addresses',
                ]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar
                dataKey="addresses"
                name="IPv4 addresses"
                fill="#0078d4"
                radius={[3, 3, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <h3>Allocations by cloud</h3>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={envData}
                dataKey="allocations"
                nameKey="name"
                innerRadius={60}
                outerRadius={100}
                paddingAngle={2}
                label={(entry: { name?: string; allocations?: number }) =>
                  `${entry.name}: ${entry.allocations}`
                }
              >
                {envData.map((entry) => (
                  <Cell
                    key={entry.name}
                    fill={ENV_COLOURS[entry.name] ?? '#98a2b3'}
                  />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <h3>Lifecycle status</h3>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={statusData}
                dataKey="value"
                nameKey="name"
                innerRadius={60}
                outerRadius={100}
                paddingAngle={2}
                label={(entry: { name?: string; value?: number }) =>
                  `${entry.name}: ${entry.value}`
                }
              >
                {statusData.map((entry) => (
                  <Cell
                    key={entry.name}
                    fill={STATUS_COLOURS[entry.name] ?? '#98a2b3'}
                  />
                ))}
              </Pie>
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Region breakdown</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Region grouping</th>
              <th>Description</th>
              <th>Allocations</th>
              <th>IPv4 addresses</th>
            </tr>
          </thead>
          <tbody>
            {regionData.map((r) => (
              <tr key={r.name}>
                <td>
                  <strong>{r.name}</strong>
                </td>
                <td className="muted">{r.label}</td>
                <td>{r.allocations}</td>
                <td>{r.addresses.toLocaleString()}</td>
              </tr>
            ))}
            {regionData.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No allocations yet — import your spreadsheet to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
