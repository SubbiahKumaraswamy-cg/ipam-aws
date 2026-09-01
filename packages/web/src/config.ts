/**
 * Runtime configuration.
 *
 * Values come from Vite environment variables at build time, but can be
 * overridden at runtime by a `/config.json` file written during deployment.
 * That lets the same built bundle be promoted between environments.
 */

export interface AppConfig {
  apiBaseUrl: string;
  cognitoAuthority: string;
  cognitoClientId: string;
  cognitoDomain: string;
  redirectUri: string;
  logoutUri: string;
}

const fromEnv: AppConfig = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
  cognitoAuthority: import.meta.env.VITE_COGNITO_AUTHORITY ?? '',
  cognitoClientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? '',
  cognitoDomain: import.meta.env.VITE_COGNITO_DOMAIN ?? '',
  redirectUri: import.meta.env.VITE_REDIRECT_URI ?? window.location.origin,
  logoutUri: import.meta.env.VITE_LOGOUT_URI ?? window.location.origin,
};

let resolved: AppConfig = fromEnv;

/**
 * Attempt to load /config.json. Deployment writes this file so the bundle is
 * environment-agnostic; if it is absent we fall back to build-time values.
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const response = await fetch('/config.json', { cache: 'no-store' });
    if (response.ok) {
      const overrides = (await response.json()) as Partial<AppConfig>;
      resolved = { ...fromEnv, ...stripEmpty(overrides) };
    }
  } catch {
    // No config.json — use build-time environment values.
  }
  return resolved;
}

function stripEmpty(input: Partial<AppConfig>): Partial<AppConfig> {
  const out: Partial<AppConfig> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null && value !== '') {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

export function getConfig(): AppConfig {
  return resolved;
}
