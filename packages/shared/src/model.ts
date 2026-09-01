/**
 * Canonical domain model for the Cloud IPAM application.
 *
 * The model reflects the structure of the source allocation spreadsheet:
 *  - AWS / Azure allocation tables grouped by region, with country rows
 *    (ISO, COUNTRY, CLOUD SPACE, MASK, Current Range, Remarks).
 *  - Azure subscription mappings split by portal type
 *    (Classic / Old Portal, ARM / New Portal a.k.a. "Azure New").
 *  - A hierarchical subnet plan (/12 -> /14 -> /16).
 */

/** Cloud environment an allocation belongs to. */
export type Environment = 'AWS' | 'Azure';
export const ENVIRONMENTS: Environment[] = ['AWS', 'Azure'];

/**
 * Region groupings used across the allocation tabs. These map to the
 * coloured region headers in the source spreadsheet.
 */
export type RegionGroup =
  | 'EUROPE'
  | 'CAMEAT' // Central Africa & Middle East
  | 'ASIA'
  | 'LATAM' // Latin America
  | 'AMERICA' // includes NORTH AMERICA
  | 'COMPASS GROUP';

export const REGION_GROUPS: RegionGroup[] = [
  'EUROPE',
  'CAMEAT',
  'ASIA',
  'LATAM',
  'AMERICA',
  'COMPASS GROUP',
];

/** Human-friendly descriptions for region groupings. */
export const REGION_GROUP_LABELS: Record<RegionGroup, string> = {
  EUROPE: 'Europe',
  CAMEAT: 'Central Africa & Middle East',
  ASIA: 'Asia',
  LATAM: 'Latin America',
  AMERICA: 'Americas / North America',
  'COMPASS GROUP': 'Compass Group (global)',
};

/**
 * Allocation lifecycle status. Not present as an explicit column in the
 * source sheet (usage was implied by Current Range) — added here so editors
 * can track lifecycle explicitly while utilisation is still computed.
 */
export type AllocationStatus = 'Available' | 'Allocated' | 'Assigned' | 'Used';
export const ALLOCATION_STATUSES: AllocationStatus[] = [
  'Available',
  'Allocated',
  'Assigned',
  'Used',
];

/** Azure portal type. "ARM (New Portal)" corresponds to the "Azure New" tab. */
export type AzurePortalType = 'Classic (Old Portal)' | 'ARM (New Portal)';
export const AZURE_PORTAL_TYPES: AzurePortalType[] = [
  'Classic (Old Portal)',
  'ARM (New Portal)',
];

/**
 * A cloud address-space allocation to a market (country/region).
 * Mirrors the AWS / Azure country tables: ISO | COUNTRY | CLOUD SPACE | MASK |
 * Current Range | Remarks. `currentRange` and `remarks` are optional because
 * some region blocks (e.g. NORTH AMERICA) omit them.
 */
export interface CloudAllocation {
  id: string;
  environment: Environment;
  regionGroup: RegionGroup;
  /** ISO country code, e.g. "DE", "GB". Null for group-level rows. */
  iso: string | null;
  country: string | null;
  /** Base network address of the allocated space, e.g. "10.20.0.0". */
  cloudSpace: string;
  /** Mask as written in the sheet, e.g. "/16" or "255.255.0.0". */
  mask: string;
  /**
   * Normalised CIDR derived from cloudSpace + mask, e.g. "10.20.0.0/16".
   * Used for containment / utilisation math (Postgres `cidr` type).
   */
  cidr: string | null;
  /** Actual in-use range within the allocation. */
  currentRange: string | null;
  status: AllocationStatus;
  remarks: string | null;
  /** Free-form key/value tags for extension without schema changes. */
  tags: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

/** Fields a client may send when creating/updating a cloud allocation. */
export type CloudAllocationInput = Omit<
  CloudAllocation,
  'id' | 'cidr' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy'
> & {
  /** Optional; server will derive from cloudSpace + mask if omitted. */
  cidr?: string | null;
};

/**
 * Azure subscription -> address space mapping. Reflects the two Azure
 * sub-tables: Azure - Classic (Old Portal) and Azure - ARM (New Portal),
 * each with Subscription | Address Space.
 */
export interface AzureSubscription {
  id: string;
  portalType: AzurePortalType;
  subscription: string;
  addressSpace: string;
  /** Normalised CIDR of addressSpace if parseable. */
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

/**
 * A row in the hierarchical subnet plan tab:
 * /16 SUBNETS | /14 (255.252.0.0) | /12 (255.240.0.0) |
 * Allocation | Remarks | Current usage | Change
 */
export interface SubnetPlanEntry {
  id: string;
  /** The /16 subnet label, e.g. "10.20.0.0/16". */
  subnet16: string | null;
  /** The parent /14 aggregate. */
  agg14: string | null;
  /** The parent /12 aggregate. */
  agg12: string | null;
  /** Who/what the block is allocated to. */
  allocation: string | null;
  remarks: string | null;
  /** Current usage note / percentage. */
  currentUsage: string | null;
  /** Recent change note. */
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

/** Roles map 1:1 to Cognito groups. */
export type Role = 'Viewer' | 'Editor' | 'Admin';
export const ROLES: Role[] = ['Viewer', 'Editor', 'Admin'];

export interface AuthenticatedUser {
  sub: string;
  email: string;
  role: Role;
}

/** True if the role is allowed to modify data (add/edit/delete rows). */
export function canEdit(role: Role): boolean {
  return role === 'Editor' || role === 'Admin';
}

/** True if the role is allowed to manage users/reference data. */
export function canAdminister(role: Role): boolean {
  return role === 'Admin';
}

/** Audit log record for any data mutation. */
export interface AuditEntry {
  id: string;
  entityType: 'cloud_allocation' | 'azure_subscription' | 'subnet_plan';
  entityId: string;
  action: 'create' | 'update' | 'delete';
  actor: string | null;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  at: string;
}

/** Dashboard aggregate returned by the API. */
export interface DashboardSummary {
  totalAllocations: number;
  byEnvironment: { environment: Environment; count: number; addresses: number }[];
  byRegion: { regionGroup: RegionGroup; count: number; addresses: number }[];
  byStatus: { status: AllocationStatus; count: number }[];
  /** Sum of usable addresses across all parseable CIDRs. */
  totalAddresses: number;
  azureSubscriptions: number;
  subnetPlanEntries: number;
}
