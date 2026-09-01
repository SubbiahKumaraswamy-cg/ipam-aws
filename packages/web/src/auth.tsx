/**
 * Cognito authentication via the OIDC authorization-code + PKCE flow.
 *
 * Roles are read from the `cognito:groups` claim on the ID token, mirroring
 * the server-side logic in packages/api/src/auth.ts.
 */

import { useMemo, type ReactNode } from 'react';
import { AuthProvider, useAuth } from 'react-oidc-context';
import { WebStorageStateStore } from 'oidc-client-ts';
import type { Role } from '@ipam/shared';
import { canEdit, canAdminister } from '@ipam/shared';
import { getConfig } from './config';
import { setTokenGetter } from './api';

export function IpamAuthProvider({ children }: { children: ReactNode }) {
  const config = getConfig();

  const oidcConfig = useMemo(
    () => ({
      authority: config.cognitoAuthority,
      client_id: config.cognitoClientId,
      redirect_uri: config.redirectUri,
      post_logout_redirect_uri: config.logoutUri,
      response_type: 'code',
      scope: 'openid email profile',
      // Keep the session across reloads rather than in memory only.
      userStore: new WebStorageStateStore({ store: window.localStorage }),
      automaticSilentRenew: true,
      // Remove ?code=&state= from the URL after the redirect completes.
      onSigninCallback: () => {
        window.history.replaceState({}, document.title, window.location.pathname);
      },
    }),
    [config],
  );

  return <AuthProvider {...oidcConfig}>{children}</AuthProvider>;
}

/** Derive the application role from the ID token's Cognito groups claim. */
export function roleFromProfile(profile: unknown): Role {
  const groups = (profile as Record<string, unknown> | undefined)?.[
    'cognito:groups'
  ];
  const list = Array.isArray(groups)
    ? groups.map(String)
    : typeof groups === 'string'
      ? groups.split(/[,\s]+/).filter(Boolean)
      : [];

  if (list.includes('Admin')) return 'Admin';
  if (list.includes('Editor')) return 'Editor';
  return 'Viewer';
}

/**
 * Convenience hook exposing the current session, role and permissions, and
 * wiring the API client to the live ID token.
 */
export function useSession() {
  const auth = useAuth();

  // Always read the token lazily so refreshes are picked up automatically.
  setTokenGetter(() => auth.user?.id_token);

  const role = auth.isAuthenticated ? roleFromProfile(auth.user?.profile) : 'Viewer';
  const email =
    (auth.user?.profile?.email as string | undefined) ??
    (auth.user?.profile?.['cognito:username'] as string | undefined) ??
    '';

  return {
    auth,
    isAuthenticated: auth.isAuthenticated,
    isLoading: auth.isLoading,
    error: auth.error,
    role: role as Role,
    email,
    canEdit: canEdit(role as Role),
    canAdminister: canAdminister(role as Role),
    signIn: () => auth.signinRedirect(),
    signOut: () => {
      const { cognitoDomain, cognitoClientId, logoutUri } = getConfig();
      // Cognito requires its own logout endpoint to clear the hosted session.
      void auth.removeUser();
      if (cognitoDomain) {
        window.location.href =
          `${cognitoDomain}/logout?client_id=${cognitoClientId}` +
          `&logout_uri=${encodeURIComponent(logoutUri)}`;
      }
    },
  };
}
