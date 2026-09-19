/**
 * Typed client for the IPAM REST API.
 *
 * The ID token is supplied by a getter so every request carries the current
 * (possibly silently refreshed) token from the OIDC session.
 */

import type {
  Country,
  CountryInput,
  MasterSubnet,
  MasterSubnetInput,
  ChildSubnet,
  ChildSubnetInput,
  CustomField,
  CustomFieldInput,
  CountryOwner,
  CountryOwnerInput,
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
      /* keep the default message */
    }
    throw new ApiError(response.status, message);
  }

  if (contentType.includes('application/json')) {
    return (await response.json()) as T;
  }
  return (await response.text()) as unknown as T;
}

/** Build a query string from defined, non-empty values. */
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

export interface MasterQuery {
  regionGroup?: string;
  countryIso?: string;
  providerLocation?: string;
  search?: string;
  within?: string;
}

export interface ChildQuery {
  masterSubnetId?: string;
  regionGroup?: string;
  countryIso?: string;
  status?: string;
  environment?: string;
  providerLocation?: string;
  technicalOwner?: string;
  requestorName?: string;
  search?: string;
  within?: string;
}

export interface FreeSpaceReport {
  masterId: string;
  masterCidr: string;
  prefix: number | null;
  suggestion: string | null;
  largestAvailablePrefix: number | null;
  usedCidrs: string[];
}

export const api = {
  me: () => request<AuthenticatedUser>('/me'),
  dashboard: () => request<DashboardSummary>('/dashboard'),

  /* ----------------------------- countries ----------------------------- */

  listCountries: (query: { regionGroup?: string; search?: string; activeOnly?: string } = {}) =>
    request<Country[]>(`/countries${qs(query)}`),

  createCountry: (input: CountryInput) =>
    request<Country>('/countries', { method: 'POST', body: JSON.stringify(input) }),

  updateCountry: (iso: string, input: CountryInput) =>
    request<Country>(`/countries/${iso}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  deleteCountry: (iso: string) =>
    request<void>(`/countries/${iso}`, { method: 'DELETE' }),

  importCountriesCsv: (csv: string) =>
    request<{ inserted: number; updated: number; total: number }>(
      '/countries/import',
      { method: 'POST', body: csv, headers: { 'content-type': 'text/csv' } },
    ),

  /* --------------------------- master subnets -------------------------- */

  listMasters: (query: MasterQuery = {}) =>
    request<MasterSubnet[]>(`/master-subnets${qs(query)}`),

  getMaster: (id: string) => request<MasterSubnet>(`/master-subnets/${id}`),

  createMaster: (input: MasterSubnetInput) =>
    request<MasterSubnet>('/master-subnets', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateMaster: (id: string, input: MasterSubnetInput) =>
    request<MasterSubnet>(`/master-subnets/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  deleteMaster: (id: string) =>
    request<void>(`/master-subnets/${id}`, { method: 'DELETE' }),

  importMastersCsv: (csv: string) =>
    request<{
      inserted: number;
      updated: number;
      skipped: number;
      total: number;
      errors: string[];
    }>('/master-subnets/import', {
      method: 'POST',
      body: csv,
      headers: { 'content-type': 'text/csv' },
    }),

  masterOverlaps: (cidr: string, excludeId?: string) =>
    request<MasterSubnet[]>(`/master-subnets/overlaps${qs({ cidr, excludeId })}`),

  freeSpace: (masterId: string, prefix?: number) =>
    request<FreeSpaceReport>(
      `/master-subnets/${masterId}/free-space${qs({ prefix })}`,
    ),

  masterChildren: (masterId: string) =>
    request<ChildSubnet[]>(`/master-subnets/${masterId}/children`),

  /* ---------------------------- child subnets -------------------------- */

  listChildren: (query: ChildQuery = {}) =>
    request<ChildSubnet[]>(`/child-subnets${qs(query)}`),

  createChild: (input: ChildSubnetInput) =>
    request<ChildSubnet>('/child-subnets', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateChild: (id: string, input: ChildSubnetInput) =>
    request<ChildSubnet>(`/child-subnets/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  deleteChild: (id: string) =>
    request<void>(`/child-subnets/${id}`, { method: 'DELETE' }),

  releaseChild: (id: string) =>
    request<ChildSubnet>(`/child-subnets/${id}/release`, { method: 'POST' }),

  childOverlaps: (cidr: string, excludeId?: string) =>
    request<ChildSubnet[]>(`/child-subnets/overlaps${qs({ cidr, excludeId })}`),

  /* ---------------------------- custom fields -------------------------- */

  listCustomFields: (entity?: string, includeInactive = false) =>
    request<CustomField[]>(
      `/custom-fields${qs({
        entity,
        includeInactive: includeInactive ? 'true' : undefined,
      })}`,
    ),

  createCustomField: (input: CustomFieldInput) =>
    request<CustomField>('/custom-fields', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateCustomField: (id: string, input: CustomFieldInput) =>
    request<CustomField>(`/custom-fields/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  deleteCustomField: (id: string) =>
    request<void>(`/custom-fields/${id}`, { method: 'DELETE' }),

  /* --------------------------- country owners -------------------------- */

  listCountryOwners: (query: { userEmail?: string; countryIso?: string } = {}) =>
    request<CountryOwner[]>(`/country-owners${qs(query)}`),

  ownerSummary: () =>
    request<{ userEmail: string; countries: string[] }[]>(
      '/country-owners?summary=true',
    ),

  createCountryOwner: (input: CountryOwnerInput) =>
    request<CountryOwner>('/country-owners', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  setCountryOwnerships: (userEmail: string, countries: string[]) =>
    request<CountryOwner[]>('/country-owners', {
      method: 'PUT',
      body: JSON.stringify({ userEmail, countries }),
    }),

  deleteCountryOwner: (id: string) =>
    request<void>(`/country-owners/${id}`, { method: 'DELETE' }),

  /* ------------------------- retained reference ------------------------ */

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
 * Trigger a CSV download. Uses fetch rather than a plain link so the
 * Authorization header is included.
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
