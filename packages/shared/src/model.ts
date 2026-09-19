/**
 * Canonical domain model for the Cloud IPAM application.
 *
 * The model is built around a two-level subnet hierarchy:
 *
 *   Country (linked to a Region)
 *     └── Master Subnet        e.g. 10.20.0.0/16 allocated to Germany
 *           └── Child Subnet   e.g. 10.20.1.0/24 requested for a workload
 *
 * Allocated and available capacity within a master subnet is always derived
 * from its child subnets rather than stored, so the figures cannot drift.
 * Overlapping subnets are prevented by exclusion constraints in the database.
 */

/* -------------------------------------------------------------------------- */
/* Regions and countries                                                      */
/* -------------------------------------------------------------------------- */

export type RegionGroup =
  | 'EUROPE'
  | 'CAMEAT' // Central Africa, Middle East & Turkey
  | 'APAC'
  | 'LATAM'
  | 'NORTH AMERICA'
  | 'GROUP'; // Group-wide / global shared space

export const REGION_GROUPS: RegionGroup[] = [
  'NORTH AMERICA',
  'EUROPE',
  'CAMEAT',
  'APAC',
  'LATAM',
  'GROUP',
];

export const REGION_GROUP_LABELS: Record<RegionGroup, string> = {
  'NORTH AMERICA': 'North America',
  EUROPE: 'Europe',
  CAMEAT: 'Central Africa, Middle East & Turkey',
  APAC: 'Asia Pacific',
  LATAM: 'Latin America',
  GROUP: 'Group (global)',
};

/** A country (market), linked to exactly one region. */
export interface Country {
  iso: string;
  name: string;
  regionGroup: RegionGroup;
  active: boolean;
  remarks: string | null;
  /** Values for admin-defined custom columns. */
  attributes: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export type CountryInput = Omit<
  Country,
  'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy'
>;

/* -------------------------------------------------------------------------- */
/* Shared enumerations                                                        */
/* -------------------------------------------------------------------------- */

/** Where the subnet physically lives. */
export type ProviderLocation =
  | 'AWS'
  | 'Azure'
  | 'GCP'
  | 'On-prem'
  | 'Unit'
  | 'Branch';

export const PROVIDER_LOCATIONS: ProviderLocation[] = [
  'AWS',
  'Azure',
  'GCP',
  'On-prem',
  'Unit',
  'Branch',
];

/** Deployment environment of a child subnet. */
export type DeploymentEnvironment = 'Prod' | 'UAT' | 'Dev' | 'Test';

export const DEPLOYMENT_ENVIRONMENTS: DeploymentEnvironment[] = [
  'Prod',
  'UAT',
  'Dev',
  'Test',
];

/**
 * Lifecycle of a child subnet.
 *
 * `Reserved` and `Allocated` both consume address space; `Released` returns it
 * to the pool, which is why released ranges may be handed out again.
 */
export type SubnetStatus = 'Reserved' | 'Allocated' | 'Released';

export const SUBNET_STATUSES: SubnetStatus[] = [
  'Reserved',
  'Allocated',
  'Released',
];

/** True when a status consumes address space within its master subnet. */
export function consumesSpace(status: SubnetStatus): boolean {
  return status !== 'Released';
}

/* -------------------------------------------------------------------------- */
/* Master subnet                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A parent block from which child subnets are carved.
 * Master subnets can never overlap one another.
 */
export interface MasterSubnet {
  id: string;
  name: string | null;
  /** Canonical CIDR, e.g. "10.20.0.0/16". */
  cidr: string;
  regionGroup: RegionGroup;
  /** Null for a region-wide or Group-level master subnet. */
  countryIso: string | null;
  countryName: string | null;
  providerLocation: ProviderLocation | null;
  description: string | null;
  remarks: string | null;
  attributes: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;

  /* Derived capacity figures, supplied by the API. */
  totalAddresses: number;
  usableHosts: number;
  allocatedAddresses: number;
  availableAddresses: number;
  allocatedChildren: number;
  reservedChildren: number;
  releasedChildren: number;
  totalChildren: number;
}

export type MasterSubnetInput = Pick<
  MasterSubnet,
  | 'name'
  | 'cidr'
  | 'regionGroup'
  | 'countryIso'
  | 'providerLocation'
  | 'description'
  | 'remarks'
> & { attributes?: Record<string, unknown> };

/** Fraction of a master subnet that is consumed, between 0 and 1. */
export function masterUtilisation(master: MasterSubnet): number {
  if (!master.totalAddresses) return 0;
  return Math.min(master.allocatedAddresses / master.totalAddresses, 1);
}

/* -------------------------------------------------------------------------- */
/* Child subnet                                                               */
/* -------------------------------------------------------------------------- */

/** An allocation carved out of a master subnet, with its request trail. */
export interface ChildSubnet {
  id: string;
  masterSubnetId: string;
  cidr: string;
  name: string | null;

  /* Request tracking */
  requestorName: string | null;
  /** ISO date, e.g. "2026-09-19". */
  requestDate: string | null;
  allocatedDate: string | null;
  justification: string | null;
  technicalOwner: string | null;
  environment: DeploymentEnvironment | null;
  providerLocation: ProviderLocation | null;
  status: SubnetStatus;

  remarks: string | null;
  attributes: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;

  /* Denormalised context, supplied by the API for display and authorisation. */
  masterCidr: string | null;
  masterName: string | null;
  regionGroup: RegionGroup | null;
  countryIso: string | null;
  countryName: string | null;
  totalAddresses: number;
  usableHosts: number;
}

export type ChildSubnetInput = Pick<
  ChildSubnet,
  | 'masterSubnetId'
  | 'cidr'
  | 'name'
  | 'requestorName'
  | 'requestDate'
  | 'allocatedDate'
  | 'justification'
  | 'technicalOwner'
  | 'environment'
  | 'providerLocation'
  | 'status'
  | 'remarks'
> & { attributes?: Record<string, unknown> };

/* -------------------------------------------------------------------------- */
/* Custom fields — admin-defined columns for future use                       */
/* -------------------------------------------------------------------------- */

export type CustomFieldEntity = 'master_subnet' | 'child_subnet' | 'country';

export const CUSTOM_FIELD_ENTITIES: CustomFieldEntity[] = [
  'master_subnet',
  'child_subnet',
  'country',
];

export const CUSTOM_FIELD_ENTITY_LABELS: Record<CustomFieldEntity, string> = {
  master_subnet: 'Master subnets',
  child_subnet: 'Child subnets',
  country: 'Countries',
};

export type CustomFieldType = 'text' | 'number' | 'date' | 'select' | 'boolean';

export const CUSTOM_FIELD_TYPES: CustomFieldType[] = [
  'text',
  'number',
  'date',
  'select',
  'boolean',
];

/**
 * Definition of an extra column. Values are stored in the owning record's
 * `attributes` map, keyed by `fieldKey`, so new columns need no schema change.
 */
export interface CustomField {
  id: string;
  entity: CustomFieldEntity;
  /** Lower-case identifier used as the key inside `attributes`. */
  fieldKey: string;
  label: string;
  dataType: CustomFieldType;
  /** Permitted values when dataType is 'select'. */
  options: string[];
  position: number;
  required: boolean;
  active: boolean;
  helpText: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export type CustomFieldInput = Pick<
  CustomField,
  | 'entity'
  | 'fieldKey'
  | 'label'
  | 'dataType'
  | 'options'
  | 'position'
  | 'required'
  | 'active'
  | 'helpText'
>;

/** Field keys must be lower-case identifiers; mirrors the DB check constraint. */
export const CUSTOM_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,48}$/;

export function isValidFieldKey(key: string): boolean {
  return CUSTOM_FIELD_KEY_PATTERN.test(key);
}

/** Turn a label into a candidate field key, e.g. "Cost Centre" -> "cost_centre". */
export function toFieldKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'f$1')
    .slice(0, 49);
}

/* -------------------------------------------------------------------------- */
/* Authorisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Roles map to Cognito groups.
 *
 *  - `Admin`        — full access, manages custom fields, countries and owners.
 *  - `Author`       — the global team; may modify any country's data.
 *  - `CountryOwner` — may modify only the countries assigned to them.
 *  - `Viewer`       — read-only.
 */
export type Role = 'Viewer' | 'CountryOwner' | 'Author' | 'Admin';

export const ROLES: Role[] = ['Viewer', 'CountryOwner', 'Author', 'Admin'];

export const ROLE_LABELS: Record<Role, string> = {
  Admin: 'Administrator',
  Author: 'Author (global)',
  CountryOwner: 'Country owner',
  Viewer: 'Viewer (read-only)',
};

export interface AuthenticatedUser {
  sub: string;
  email: string;
  role: Role;
  /** ISO codes this user may write, when their role is CountryOwner. */
  countries: string[];
}

/** True when the role may modify data for every country. */
export function canEditAll(role: Role): boolean {
  return role === 'Author' || role === 'Admin';
}

/** True when the role may manage reference data, custom fields and users. */
export function canAdminister(role: Role): boolean {
  return role === 'Admin';
}

/** True when the role can modify at least something. */
export function canEditSomething(user: AuthenticatedUser): boolean {
  return canEditAll(user.role) || user.countries.length > 0;
}

/**
 * True when the user may modify records belonging to the given country.
 *
 * A null country means the record sits at region or Group level, which only
 * global authors and administrators may change.
 */
export function canEditCountry(
  user: AuthenticatedUser,
  countryIso: string | null | undefined,
): boolean {
  if (canEditAll(user.role)) return true;
  if (!countryIso) return false;
  return user.countries.includes(countryIso.toUpperCase());
}

/* -------------------------------------------------------------------------- */
/* Azure subscriptions (retained reference data)                              */
/* -------------------------------------------------------------------------- */

export type AzurePortalType = 'Classic (Old Portal)' | 'ARM (New Portal)';

export const AZURE_PORTAL_TYPES: AzurePortalType[] = [
  'Classic (Old Portal)',
  'ARM (New Portal)',
];

export interface AzureSubscription {
  id: string;
  portalType: AzurePortalType;
  subscription: string;
  addressSpace: string;
  cidr: string | null;
  regionGroup: RegionGroup | null;
  remarks: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export type AzureSubscriptionInput = Omit<
  AzureSubscription,
  'id' | 'cidr' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy'
> & { cidr?: string | null };

/* -------------------------------------------------------------------------- */
/* Subnet plan (retained supernet planning reference)                         */
/* -------------------------------------------------------------------------- */

export interface SubnetPlanEntry {
  id: string;
  subnet16: string | null;
  agg14: string | null;
  agg12: string | null;
  allocation: string | null;
  remarks: string | null;
  currentUsage: string | null;
  change: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export type SubnetPlanEntryInput = Omit<
  SubnetPlanEntry,
  'id' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy'
>;

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

export type AuditEntityType =
  | 'master_subnet'
  | 'child_subnet'
  | 'country'
  | 'custom_field'
  | 'country_owner'
  | 'azure_subscription'
  | 'subnet_plan';

export interface AuditEntry {
  id: string;
  entityType: AuditEntityType;
  entityId: string;
  action: 'create' | 'update' | 'delete';
  actor: string | null;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  at: string;
}

/* -------------------------------------------------------------------------- */
/* Country owners                                                             */
/* -------------------------------------------------------------------------- */

export interface CountryOwner {
  id: string;
  userEmail: string;
  countryIso: string;
  countryName: string | null;
  regionGroup: RegionGroup | null;
  createdAt: string;
  createdBy: string | null;
}

export interface CountryOwnerInput {
  userEmail: string;
  countryIso: string;
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

export interface DashboardSummary {
  masterSubnets: number;
  childSubnets: number;
  countries: number;
  totalAddresses: number;
  allocatedAddresses: number;
  availableAddresses: number;
  byRegion: {
    regionGroup: RegionGroup;
    masterSubnets: number;
    childSubnets: number;
    totalAddresses: number;
    allocatedAddresses: number;
    availableAddresses: number;
  }[];
  byStatus: { status: SubnetStatus; count: number }[];
  byEnvironment: { environment: DeploymentEnvironment | null; count: number }[];
  byProvider: { providerLocation: ProviderLocation | null; count: number }[];
  /** Master subnets closest to exhaustion, most utilised first. */
  mostUtilised: {
    id: string;
    cidr: string;
    name: string | null;
    countryName: string | null;
    regionGroup: RegionGroup;
    utilisation: number;
    availableAddresses: number;
  }[];
  azureSubscriptions: number;
  subnetPlanEntries: number;
}
