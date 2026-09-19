/**
 * Cognito JWT verification and authorisation.
 *
 * Roles come from Cognito group membership:
 *   Admin        — full access, manages reference data and custom fields
 *   Author       — the global team; may modify any country's data
 *   CountryOwner — may modify only the countries assigned to them
 *   Viewer       — read-only
 *
 * For a country owner the writable country list is read from the
 * `country_owner` table, so administrators can delegate a market without
 * touching Cognito beyond adding the user to the CountryOwner group.
 */

import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { AuthenticatedUser, Role } from '@ipam/shared';
import { canEditAll, canAdminister, canEditCountry } from '@ipam/shared';
import { query } from './db';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getVerifier() {
  if (verifier) return verifier;

  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID;
  if (!userPoolId || !clientId) {
    throw new Error(
      'COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID must be configured.',
    );
  }

  verifier = CognitoJwtVerifier.create({
    userPoolId,
    clientId,
    tokenUse: 'id',
  });
  return verifier;
}

/** Map Cognito groups to an application role; highest privilege wins. */
export function roleFromGroups(groups: string[] | undefined): Role {
  if (!groups || groups.length === 0) return 'Viewer';
  if (groups.includes('Admin')) return 'Admin';
  if (groups.includes('Author')) return 'Author';
  // 'Editor' is accepted as a legacy alias for Author.
  if (groups.includes('Editor')) return 'Author';
  if (groups.includes('CountryOwner')) return 'CountryOwner';
  return 'Viewer';
}

/**
 * Verify the caller's token and resolve their effective permissions.
 * Throws HttpError(401) when the token is missing or invalid.
 */
export async function authenticate(
  event: APIGatewayProxyEventV2,
): Promise<AuthenticatedUser> {
  // The API Gateway JWT authorizer validates the token before we run, so its
  // claims can be trusted when present.
  const claimsFromAuthorizer = (
    event.requestContext as unknown as {
      authorizer?: { jwt?: { claims?: Record<string, unknown> } };
    }
  )?.authorizer?.jwt?.claims;

  let claims: Record<string, unknown>;

  if (claimsFromAuthorizer) {
    claims = claimsFromAuthorizer;
  } else {
    const header =
      event.headers?.authorization ?? event.headers?.Authorization ?? '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      throw new HttpError(401, 'Missing Authorization bearer token.');
    }
    try {
      claims = (await getVerifier().verify(token)) as unknown as Record<
        string,
        unknown
      >;
    } catch (err) {
      console.warn('JWT verification failed', err);
      throw new HttpError(401, 'Invalid or expired token.');
    }
  }

  const rawGroups = claims['cognito:groups'];
  let groups: string[] | undefined;
  if (Array.isArray(rawGroups)) {
    groups = rawGroups.map(String);
  } else if (typeof rawGroups === 'string') {
    // API Gateway flattens the claim into a delimited string.
    groups = rawGroups.replace(/^\[|\]$/g, '').split(/[,\s]+/).filter(Boolean);
  }

  const role = roleFromGroups(groups);
  const sub = String(claims.sub ?? '');
  const email = String(claims.email ?? claims['cognito:username'] ?? sub);

  // Only country owners need the lookup; global roles already write everywhere.
  const countries =
    role === 'CountryOwner' ? await loadOwnedCountries(email) : [];

  return { sub, email, role, countries };
}

/** ISO codes the given user has been made owner of. */
async function loadOwnedCountries(email: string): Promise<string[]> {
  if (!email) return [];
  try {
    const rows = await query<{ country_iso: string }>(
      `SELECT country_iso FROM country_owner WHERE user_email = lower($1)`,
      [email],
    );
    return rows.map((r) => r.country_iso.toUpperCase());
  } catch (err) {
    // Fail closed: no rows means no write access rather than blanket access.
    console.error('Could not load country ownership', err);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

/** Require a role that may modify every country's data. */
export function requireGlobalAuthor(user: AuthenticatedUser): void {
  if (!canEditAll(user.role)) {
    throw new HttpError(
      403,
      'This action requires the Author or Admin role.',
    );
  }
}

/** Require administrator rights. */
export function requireAdmin(user: AuthenticatedUser): void {
  if (!canAdminister(user.role)) {
    throw new HttpError(403, 'Administrator role required.');
  }
}

/**
 * Require write access to a specific country.
 *
 * A null country identifies a region-wide or Group-level record, which only
 * global authors and administrators may change.
 */
export function requireCountryWrite(
  user: AuthenticatedUser,
  countryIso: string | null | undefined,
): void {
  if (canEditCountry(user, countryIso)) return;

  if (user.role === 'Viewer') {
    throw new HttpError(
      403,
      'Your account has read-only access. Ask an administrator for write rights.',
    );
  }

  if (!countryIso) {
    throw new HttpError(
      403,
      'Region-wide and Group-level records can only be changed by a global Author or Admin.',
    );
  }

  throw new HttpError(
    403,
    `You do not own ${countryIso}. You may only modify: ${
      user.countries.length ? user.countries.join(', ') : '(no countries assigned)'
    }.`,
  );
}
