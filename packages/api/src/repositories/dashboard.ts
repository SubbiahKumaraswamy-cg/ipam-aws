/**
 * Dashboard aggregates. Address counts are computed in SQL from the mask
 * length so the numbers stay consistent with the stored CIDR values.
 */

import type {
  DashboardSummary,
  Environment,
  RegionGroup,
  AllocationStatus,
} from '@ipam/shared';
import { query } from '../db';

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const [
    totals,
    byEnvironment,
    byRegion,
    byStatus,
    azureCount,
    planCount,
  ] = await Promise.all([
    query<{ count: string; addresses: string | null }>(
      `SELECT COUNT(*)::text AS count,
              COALESCE(SUM(2 ^ (32 - masklen(cidr))), 0)::text AS addresses
         FROM cloud_allocation`,
    ),
    query<{ environment: Environment; count: string; addresses: string | null }>(
      `SELECT environment,
              COUNT(*)::text AS count,
              COALESCE(SUM(2 ^ (32 - masklen(cidr))), 0)::text AS addresses
         FROM cloud_allocation
        GROUP BY environment
        ORDER BY environment`,
    ),
    query<{ region_group: RegionGroup; count: string; addresses: string | null }>(
      `SELECT region_group,
              COUNT(*)::text AS count,
              COALESCE(SUM(2 ^ (32 - masklen(cidr))), 0)::text AS addresses
         FROM cloud_allocation
        GROUP BY region_group
        ORDER BY region_group`,
    ),
    query<{ status: AllocationStatus; count: string }>(
      `SELECT status, COUNT(*)::text AS count
         FROM cloud_allocation
        GROUP BY status
        ORDER BY status`,
    ),
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM azure_subscription`,
    ),
    query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM subnet_plan`),
  ]);

  const num = (value: string | null | undefined): number =>
    value ? Number(value) : 0;

  return {
    totalAllocations: num(totals[0]?.count),
    totalAddresses: num(totals[0]?.addresses),
    byEnvironment: byEnvironment.map((r) => ({
      environment: r.environment,
      count: num(r.count),
      addresses: num(r.addresses),
    })),
    byRegion: byRegion.map((r) => ({
      regionGroup: r.region_group,
      count: num(r.count),
      addresses: num(r.addresses),
    })),
    byStatus: byStatus.map((r) => ({
      status: r.status,
      count: num(r.count),
    })),
    azureSubscriptions: num(azureCount[0]?.count),
    subnetPlanEntries: num(planCount[0]?.count),
  };
}
