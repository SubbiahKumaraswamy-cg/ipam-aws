import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './auth';
import { DashboardPage } from './pages/DashboardPage';
import { AllocationsPage } from './pages/AllocationsPage';
import { AzureSubscriptionsPage } from './pages/AzureSubscriptionsPage';
import { SubnetPlanPage } from './pages/SubnetPlanPage';
import { AuditPage } from './pages/AuditPage';
import { SignIn } from './components/SignIn';

export function App() {
  const session = useSession();

  if (session.isLoading) {
    return (
      <div className="centered">
        <div className="spinner" aria-label="Loading" />
        <p>Signing you in…</p>
      </div>
    );
  }

  if (!session.isAuthenticated) {
    return <SignIn session={session} />;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ◧
          </span>
          <div>
            <h1>Cloud IPAM</h1>
            <p className="brand-sub">IP address allocations · AWS &amp; Azure</p>
          </div>
        </div>

        <nav className="app-nav" aria-label="Main navigation">
          <NavLink to="/dashboard">Dashboard</NavLink>
          <NavLink to="/allocations/aws">AWS</NavLink>
          <NavLink to="/allocations/azure">Azure</NavLink>
          <NavLink to="/azure-subscriptions">Subscriptions</NavLink>
          <NavLink to="/subnet-plan">Subnet plan</NavLink>
          {session.canAdminister && <NavLink to="/audit">Audit</NavLink>}
        </nav>

        <div className="user-box">
          <div className="user-meta">
            <span className="user-email">{session.email}</span>
            <span className={`role-badge role-${session.role.toLowerCase()}`}>
              {session.role}
            </span>
          </div>
          <button type="button" className="btn btn-ghost" onClick={session.signOut}>
            Sign out
          </button>
        </div>
      </header>

      {!session.canEdit && (
        <div className="banner banner-info">
          You have <strong>read-only</strong> access. Ask an administrator for the
          <strong> Editor</strong> role to modify allocations.
        </div>
      )}

      <main className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route
            path="/allocations/aws"
            element={<AllocationsPage environment="AWS" canEdit={session.canEdit} />}
          />
          <Route
            path="/allocations/azure"
            element={
              <AllocationsPage environment="Azure" canEdit={session.canEdit} />
            }
          />
          <Route
            path="/azure-subscriptions"
            element={<AzureSubscriptionsPage canEdit={session.canEdit} />}
          />
          <Route
            path="/subnet-plan"
            element={<SubnetPlanPage canEdit={session.canEdit} />}
          />
          <Route
            path="/audit"
            element={
              session.canAdminister ? (
                <AuditPage />
              ) : (
                <Navigate to="/dashboard" replace />
              )
            }
          />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  );
}
