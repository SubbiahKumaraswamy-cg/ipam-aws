/**
 * Cognito authentication via the OIDC authorization-code + PKCE flow.
 *
 * The role comes from the `cognito:groups` claim, mirroring the server-side
 * logic. For a country owner the writable country list lives in the database,
 * so it is fetched from /me rather than inferred from the token.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AuthProvider, useAuth } from 'react-oidc-context';
import { WebStorageStateStore } from 'oidc-client-ts';
import type { AuthenticatedUser, Role } from '@ipam/shared';
import { canEditAll, canAdminister, canEditCountry } from '@ipam/shared';
import { getConfig } from './config';
import { api, setTokenGetter } from './api';

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
      userStore: new WebStorageStateStore({ store: window.localStorage }),
      automaticSilentRenew: true,
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
  if (list.includes('Author')) return 'Author';
  if (list.includes('Editor')) return 'Author'; // legacy alias
  if (list.includes('CountryOwner')) return 'CountryOwner';
  return 'Viewer';
}

export interface Session {
  isAuthenticated: boolean;
  isLoading: boolean;
  error: Error | undefined;
  email: string;
  role: Role;
  /** ISO codes this user may write (country owners only). */
  countries: string[];
  /** True when the user may write every country. */
  canEditAll: boolean;
  canAdminister: boolean;
  /** True when the user can write at least one country. */
  canEditSomething: boolean;
  /** Per-record check used to enable inline editing. */
  canEditCountry: (iso: string | null | undefined) => boolean;
  signIn: () => void;
  signOut: () => void;
}

/**
 * Current session, role and permissions. Also wires the API client to the
 * live ID token.
 */
export function useSession(): Session {
  const auth = useAuth();
  const [countries, setCountries] = useState<string[]>([]);

  // Always read the token lazily so refreshes are picked up automatically.
  setTokenGetter(() => auth.user?.id_token);

  const tokenRole = auth.isAuthenticated
    ? roleFromProfile(auth.user?.profile)
    : 'Viewer';

  // Country ownership is stored server-side; ask the API who we are.
  useEffect(() => {
    if (!auth.isAuthenticated || tokenRole !== 'CountryOwner') {
      setCountries([]);
      return;
    }
    let cancelled = false;
    api
      .me()
      .then((me: AuthenticatedUser) => {
        if (!cancelled) setCountries(me.countries ?? []);
      })
      .catch(() => {
        // Fail closed: without the list the user gets no write access.
        if (!cancelled) setCountries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.isAuthenticated, tokenRole, auth.user?.id_token]);

  const email =
    (auth.user?.profile?.email as string | undefined) ??
    (auth.user?.profile?.['cognito:username'] as string | undefined) ??
    '';

  const user: AuthenticatedUser = {
    sub: auth.user?.profile?.sub ?? '',
    email,
    role: tokenRole,
    countries,
  };

  return {
    isAuthenticated: auth.isAuthenticated,
    isLoading: auth.isLoading,
    error: auth.error,
    email,
    role: tokenRole,
    countries,
    canEditAll: canEditAll(tokenRole),
    canAdminister: canAdminister(tokenRole),
    canEditSomething: canEditAll(tokenRole) || countries.length > 0,
    canEditCountry: (iso) => canEditCountry(user, iso),
    signIn: () => auth.signinRedirect(),
    signOut: () => {
      const { cognitoDomain, cognitoClientId, logoutUri } = getConfig();
      void auth.removeUser();
      if (cognitoDomain) {
        window.location.href =
          `${cognitoDomain}/logout?client_id=${cognitoClientId}` +
          `&logout_uri=${encodeURIComponent(logoutUri)}`;
      }
    },
  };
}
