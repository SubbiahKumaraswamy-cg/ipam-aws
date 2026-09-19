import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import {
  REGION_GROUP_LABELS,
  formatAddressCount,
  formatPercent,
} from '@ipam/shared';
import { api } from '../api';

const STATUS_COLOURS: Record<string, string> = {
  Reserved: '#b26a00',
  Allocated: '#1d4ed8',
  Released: '#98a2b3',
};

const ENV_COLOURS: Record<string, string> = {
  Prod: '#c62828',
  UAT: '#b26a00',
  Dev: '#1d4ed8',
  Test: '#1b7f4b',
};

export function DashboardPage() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
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

  const overall =
    summary.totalAddresses > 0
      ? summary.allocatedAddresses / summary.totalAddresses
      : 0;

  const regionData = summary.byRegion.map((r) => ({
    name: r.regionGroup,
    label: REGION_GROUP_LABELS[r.regionGroup] ?? r.regionGroup,
    masters: r.masterSubnets,
    children: r.childSubnets,
    allocated: r.allocatedAddresses,
    available: r.availableAddresses,
  }));

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Dashboard</h2>
          <p>
            Address space across all regions. Allocated and available figures are
            derived from the child subnets, so they always reconcile.
          </p>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="stat-label">Master subnets</div>
          <div className="stat-value">{summary.masterSubnets}</div>
          <div className="stat-hint">across {summary.countries} countries</div>
        </div>
        <div className="stat">
          <div className="stat-label">Child subnets</div>
          <div className="stat-value">{summary.childSubnets}</div>
          <div className="stat-hint">individual allocations</div>
        </div>
        <div className="stat">
          <div className="stat-label">Addresses allocated</div>
          <div className="stat-value">
            {formatAddressCount(summary.allocatedAddresses)}
          </div>
          <div className="stat-hint">
            of {formatAddressCount(summary.totalAddresses)} ·{' '}
            {formatPercent(overall)}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Addresses available</div>
          <div className="stat-value">
            {formatAddressCount(summary.availableAddresses)}
          </div>
          <div className="stat-hint">
            {summary.availableAddresses.toLocaleString()} free
          </div>
        </div>
      </div>

      <div className="chart-grid">
        <div className="card">
          <h3>Address space by region</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={regionData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={formatAddressCount} tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(value: number, key: string) => [
                  value.toLocaleString(),
                  key === 'allocated' ? 'Allocated' : 'Available',
                ]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar
                dataKey="allocated"
                name="Allocated"
                stackId="a"
                fill="#1d4ed8"
              />
              <Bar
                dataKey="available"
                name="Available"
                stackId="a"
                fill="#cdd7ea"
                radius={[3, 3, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <h3>Subnets by region</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={regionData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="masters" name="Master subnets" fill="#0078d4" radius={[3, 3, 0, 0]} />
              <Bar dataKey="children" name="Child subnets" fill="#1b7f4b" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <h3>Allocation status</h3>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={summary.byStatus.map((s) => ({ name: s.status, value: s.count }))}
                dataKey="value"
                nameKey="name"
                innerRadius={60}
                outerRadius={100}
                paddingAngle={2}
                label={(e: { name?: string; value?: number }) =>
                  `${e.name}: ${e.value}`
                }
              >
                {summary.byStatus.map((s) => (
                  <Cell key={s.status} fill={STATUS_COLOURS[s.status] ?? '#98a2b3'} />
                ))}
              </Pie>
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <h3>Active subnets by environment</h3>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={summary.byEnvironment.map((e) => ({
                  name: e.environment ?? 'Unspecified',
                  value: e.count,
                }))}
                dataKey="value"
                nameKey="name"
                innerRadius={60}
                outerRadius={100}
                paddingAngle={2}
                label={(e: { name?: string; value?: number }) =>
                  `${e.name}: ${e.value}`
                }
              >
                {summary.byEnvironment.map((e) => (
                  <Cell
                    key={e.environment ?? 'none'}
                    fill={ENV_COLOURS[e.environment ?? ''] ?? '#98a2b3'}
                  />
                ))}
              </Pie>
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {summary.mostUtilised.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Master subnets closest to exhaustion</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Master subnet</th>
                <th>Country</th>
                <th>Region</th>
                <th>Utilisation</th>
                <th>Available</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {summary.mostUtilised.map((m) => {
                const tone =
                  m.utilisation >= 0.9
                    ? 'high'
                    : m.utilisation >= 0.7
                      ? 'medium'
                      : 'low';
                return (
                  <tr key={m.id}>
                    <td>
                      <code>{m.cidr}</code>
                      {m.name && <div className="muted" style={{ fontSize: 11 }}>{m.name}</div>}
                    </td>
                    <td>{m.countryName ?? <span className="muted">—</span>}</td>
                    <td className="muted">{m.regionGroup}</td>
                    <td style={{ width: 180 }}>
                      <div className="meter">
                        <div
                          className={`meter-fill meter-${tone}`}
                          style={{ width: `${Math.round(m.utilisation * 100)}%` }}
                        />
                        <span className="meter-label">
                          {formatPercent(m.utilisation)}
                        </span>
                      </div>
                    </td>
                    <td>{m.availableAddresses.toLocaleString()}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-link"
                        onClick={() => navigate(`/child-subnets?master=${m.id}`)}
                      >
                        View children
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Region breakdown</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Region</th>
              <th>Description</th>
              <th>Masters</th>
              <th>Children</th>
              <th>Allocated</th>
              <th>Available</th>
            </tr>
          </thead>
          <tbody>
            {regionData.map((r) => (
              <tr key={r.name}>
                <td>
                  <strong>{r.name}</strong>
                </td>
                <td className="muted">{r.label}</td>
                <td>{r.masters}</td>
                <td>{r.children}</td>
                <td>{r.allocated.toLocaleString()}</td>
                <td>{r.available.toLocaleString()}</td>
              </tr>
            ))}
            {regionData.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No master subnets yet — add countries, then master subnets, to
                  begin.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
