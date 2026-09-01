import type { useSession } from '../auth';

export function SignIn({ session }: { session: ReturnType<typeof useSession> }) {
  return (
    <div className="centered">
      <div className="signin-card">
        <h1>Cloud IPAM</h1>
        <p>
          IP address allocation management for AWS and Azure across all markets.
        </p>

        {session.error && (
          <div className="banner-error" role="alert">
            {session.error.message}
          </div>
        )}

        <button
          type="button"
          className="btn btn-primary"
          onClick={() => session.signIn()}
        >
          Sign in with corporate account
        </button>

        <p className="field-hint" style={{ marginTop: 16 }}>
          Access is controlled by your administrator. Viewers can browse
          allocations; editors can modify them.
        </p>
      </div>
    </div>
  );
}
