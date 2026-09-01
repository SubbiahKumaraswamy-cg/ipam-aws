/**
 * Cognito JWT verification and role resolution.
 *
 * Roles are driven by Cognito group membership. A user in the `Admin` group
 * gets the Admin role, `Editor` gets Editor, and everyone else is a Viewer.
 * This is what enforces "only specific users may modify rows".
 */

import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { AuthenticatedUser, Role } from '@ipam/shared';
import { canEdit, canAdminister } from '@ipam/shared';

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

/** Map Cognito groups to an application role, highest privilege wins. */
export function roleFromGroups(groups: string[] | undefined): Role {
  if (!groups || groups.length === 0) return 'Viewer';
  if (groups.includes('Admin')) return 'Admin';
  if (groups.includes('Editor')) return 'Editor';
  return 'Viewer';
}

/**
 * Verify the bearer token on the request and return the caller.
 * Throws HttpError(401) when the token is missing or invalid.
 */
export async function authenticate(
  event: APIGatewayProxyEventV2,
): Promise<AuthenticatedUser> {
  // Allow the API Gateway JWT authorizer to have already validated the token.
  const claimsFromAuthorizer = (
    event.requestContext as unknown as {
      authorizer?: { jwt?: { claims?: Record<string, unknown> } };
    }
  )?.authorizer?.jwt?.claims;

  if (claimsFromAuthorizer) {
    return userFromClaims(claimsFromAuthorizer);
  }

  const header =
    event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    throw new HttpError(401, 'Missing Authorization bearer token.');
  }

  try {
    const payload = await getVerifier().verify(token);
    return userFromClaims(payload as unknown as Record<string, unknown>);
  } catch (err) {
    console.warn('JWT verification failed', err);
    throw new HttpError(401, 'Invalid or expired token.');
  }
}

/** Build the authenticated user from verified JWT claims. */
function userFromClaims(claims: Record<string, unknown>): AuthenticatedUser {
  const rawGroups = claims['cognito:groups'];
  let groups: string[] | undefined;
  if (Array.isArray(rawGroups)) {
    groups = rawGroups.map(String);
  } else if (typeof rawGroups === 'string') {
    // API Gateway flattens the claim into a comma/space separated string.
    groups = rawGroups.replace(/^\[|\]$/g, '').split(/[,\s]+/).filter(Boolean);
  }

  const sub = String(claims.sub ?? '');
  const email = String(claims.email ?? claims['cognito:username'] ?? sub);

  return { sub, email, role: roleFromGroups(groups) };
}

/** Throw 403 unless the caller may modify data. */
export function requireEditor(user: AuthenticatedUser): void {
  if (!canEdit(user.role)) {
    throw new HttpError(
      403,
      'Your account has read-only access. Ask an administrator for the Editor role.',
    );
  }
}

/** Throw 403 unless the caller is an administrator. */
export function requireAdmin(user: AuthenticatedUser): void {
  if (!canAdminister(user.role)) {
    throw new HttpError(403, 'Administrator role required.');
  }
}
