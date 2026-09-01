/**
 * Typed client for the IPAM REST API.
 *
 * The access token is supplied by a getter so the client always sends the
 * current (possibly silently refreshed) token from the OIDC session.
 */

import type {
  CloudAllocation,
  CloudAllocationInput,
  AzureSubscription,
  AzureSubscriptionInput,
  SubnetPlanEntry,
  SubnetPlanEntryInput,
  DashboardSummary,
  AuditEntry,
  AuthenticatedUser,
} from '@ipam/shared';
import { getConfig } from './config';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let tokenGetter: () => string | undefined = () => undefined;

/** Register the function used to obtain the current ID token. */
export function setTokenGetter(fn: () => string | undefined): void {
  tokenGetter = fn;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { apiBaseUrl } = getConfig();
  const token = tokenGetter();

  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      if (contentType.includes('application/json')) {
        const body = (await response.json()) as { error?: string };
        if (body.error) message = body.error;
      } else {
        const raw = await response.text();
        if (raw) message = raw;
      }
    } catch {
      // Keep the default message.
    }
    throw new ApiError(response.status, message);
  }

  if (contentType.includes('application/json')) {
    return (await response.json()) as T;
  }
  return (await response.text()) as unknown as T;
}

/**
 * Build a query string from defined, non-empty values. Accepts any object so
 * callers can pass typed filter interfaces directly.
 */
function qs(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}

export interface AllocationQuery {
  environment?: string;
  regionGroup?: string;
  status?: string;
  iso?: string;
  search?: string;
  within?: string;
}

export const api = {
  me: () => request<AuthenticatedUser>('/me'),

  dashboard: () => request<DashboardSummary>('/dashboard'),

  listAllocations: (query: AllocationQuery = {}) =>
    request<CloudAllocation[]>(`/allocations${qs(query)}`),

  createAllocation: (input: CloudAllocationInput) =>
    request<CloudAllocation>('/allocations', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateAllocation: (id: string, input: CloudAllocationInput) =>
    request<CloudAllocation>(`/allocations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  deleteAllocation: (id: string) =>
    request<void>(`/allocations/${id}`, { method: 'DELETE' }),

  findOverlaps: (cidr: string, excludeId?: string) =>
    request<CloudAllocation[]>(`/allocations/overlaps${qs({ cidr, excludeId })}`),

  importAllocationsCsv: (csv: string, environment?: string) =>
    request<{ inserted: number; updated: number; total: number }>(
      `/allocations/import${qs({ environment })}`,
      { method: 'POST', body: csv, headers: { 'content-type': 'text/csv' } },
    ),

  listSubscriptions: (query: { portalType?: string; search?: string } = {}) =>
    request<AzureSubscription[]>(`/azure-subscriptions${qs(query)}`),

  createSubscription: (input: AzureSubscriptionInput) =>
    request<AzureSubscription>('/azure-subscriptions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateSubscription: (id: string, input: AzureSubscriptionInput) =>
    request<AzureSubscription>(`/azure-subscriptions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  deleteSubscription: (id: string) =>
    request<void>(`/azure-subscriptions/${id}`, { method: 'DELETE' }),

  importSubscriptionsCsv: (csv: string, portalType?: string) =>
    request<{ inserted: number; updated: number; total: number }>(
      `/azure-subscriptions/import${qs({ portalType })}`,
      { method: 'POST', body: csv, headers: { 'content-type': 'text/csv' } },
    ),

  listPlanEntries: (query: { search?: string; within?: string } = {}) =>
    request<SubnetPlanEntry[]>(`/subnet-plan${qs(query)}`),

  createPlanEntry: (input: SubnetPlanEntryInput) =>
    request<SubnetPlanEntry>('/subnet-plan', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updatePlanEntry: (id: string, input: SubnetPlanEntryInput) =>
    request<SubnetPlanEntry>(`/subnet-plan/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  deletePlanEntry: (id: string) =>
    request<void>(`/subnet-plan/${id}`, { method: 'DELETE' }),

  importPlanCsv: (csv: string) =>
    request<{ inserted: number; total: number }>('/subnet-plan/import', {
      method: 'POST',
      body: csv,
      headers: { 'content-type': 'text/csv' },
    }),

  listAudit: (limit = 200) =>
    request<AuditEntry[]>(`/audit${qs({ limit: String(limit) })}`),
};

/**
 * Trigger a CSV download for the given export endpoint. Uses fetch (rather
 * than a plain link) so the Authorization header is included.
 */
export async function downloadCsv(
  path: string,
  filename: string,
): Promise<void> {
  const { apiBaseUrl } = getConfig();
  const token = tokenGetter();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new ApiError(response.status, `Export failed (${response.status}).`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
