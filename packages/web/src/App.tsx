import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ROLE_LABELS } from '@ipam/shared';
import { useSession } from './auth';
import { DashboardPage } from './pages/DashboardPage';
import { MasterSubnetsPage } from './pages/MasterSubnetsPage';
import { ChildSubnetsPage } from './pages/ChildSubnetsPage';
import { CountriesPage } from './pages/CountriesPage';
import { AzureSubscriptionsPage } from './pages/AzureSubscriptionsPage';
import { SubnetPlanPage } from './pages/SubnetPlanPage';
import { AuditPage } from './pages/AuditPage';
import { AdminPage } from './pages/AdminPage';
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
            <p className="brand-sub">IP address management · Compass Group</p>
          </div>
        </div>

        <nav className="app-nav" aria-label="Main navigation">
          <NavLink to="/dashboard">Dashboard</NavLink>
          <NavLink to="/master-subnets">Master subnets</NavLink>
          <NavLink to="/child-subnets">Child subnets</NavLink>
          <NavLink to="/countries">Countries</NavLink>
          <NavLink to="/subnet-plan">Subnet plan</NavLink>
          <NavLink to="/azure-subscriptions">Azure subs</NavLink>
          {session.canAdminister && <NavLink to="/admin">Admin</NavLink>}
          {session.canAdminister && <NavLink to="/audit">Audit</NavLink>}
        </nav>

        <div className="user-box">
          <div className="user-meta">
            <span className="user-email">{session.email}</span>
            <span
              className={`role-badge role-${session.role.toLowerCase()}`}
              title={ROLE_LABELS[session.role]}
            >
              {session.role}
            </span>
          </div>
          <button type="button" className="btn btn-ghost" onClick={session.signOut}>
            Sign out
          </button>
        </div>
      </header>

      {!session.canEditSomething && (
        <div className="banner banner-info">
          You have <strong>read-only</strong> access. An administrator can grant
          you the <strong>Author</strong> role for global editing, or make you the
          owner of specific countries.
        </div>
      )}

      {session.role === 'CountryOwner' && session.countries.length > 0 && (
        <div className="banner banner-info">
          You can edit data for{' '}
          <strong>{session.countries.join(', ')}</strong>. Other countries and
          Group-level records are read-only for you.
        </div>
      )}

      <main className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route
            path="/master-subnets"
            element={<MasterSubnetsPage session={session} />}
          />
          <Route
            path="/child-subnets"
            element={<ChildSubnetsPage session={session} />}
          />
          <Route path="/countries" element={<CountriesPage session={session} />} />
          <Route
            path="/subnet-plan"
            element={<SubnetPlanPage canEdit={session.canEditAll} />}
          />
          <Route
            path="/azure-subscriptions"
            element={<AzureSubscriptionsPage canEdit={session.canEditAll} />}
          />
          <Route
            path="/admin"
            element={
              session.canAdminister ? (
                <AdminPage />
              ) : (
                <Navigate to="/dashboard" replace />
              )
            }
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
