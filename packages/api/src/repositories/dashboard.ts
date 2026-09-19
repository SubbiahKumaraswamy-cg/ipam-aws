/**
 * Dashboard aggregates.
 *
 * Capacity figures are read from the master_subnet_utilisation view so the
 * dashboard, the grids and the API all report identical numbers.
 */

import type {
  DashboardSummary,
  RegionGroup,
  SubnetStatus,
  DeploymentEnvironment,
  ProviderLocation,
} from '@ipam/shared';
import { query } from './../db';

const num = (value: string | null | undefined): number =>
  value ? Number(value) : 0;

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const [
    totals,
    byRegion,
    byStatus,
    byEnvironment,
    byProvider,
    mostUtilised,
    extras,
  ] = await Promise.all([
    query<{
      masters: string;
      children: string;
      countries: string;
      total: string | null;
      allocated: string | null;
      available: string | null;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM master_subnet)                AS masters,
         (SELECT COUNT(*)::text FROM child_subnet)                 AS children,
         (SELECT COUNT(*)::text FROM country)                      AS countries,
         (SELECT COALESCE(SUM(total_addresses),0)::text     FROM master_subnet_utilisation) AS total,
         (SELECT COALESCE(SUM(allocated_addresses),0)::text FROM master_subnet_utilisation) AS allocated,
         (SELECT COALESCE(SUM(available_addresses),0)::text FROM master_subnet_utilisation) AS available`,
    ),

    query<{
      region_group: RegionGroup;
      masters: string;
      children: string;
      total: string | null;
      allocated: string | null;
      available: string | null;
    }>(
      `SELECT
         u.region_group,
         COUNT(*)::text                                    AS masters,
         COALESCE(SUM(u.total_children),0)::text           AS children,
         COALESCE(SUM(u.total_addresses),0)::text          AS total,
         COALESCE(SUM(u.allocated_addresses),0)::text      AS allocated,
         COALESCE(SUM(u.available_addresses),0)::text      AS available
       FROM master_subnet_utilisation u
       GROUP BY u.region_group
       ORDER BY u.region_group`,
    ),

    query<{ status: SubnetStatus; count: string }>(
      `SELECT status, COUNT(*)::text AS count
         FROM child_subnet GROUP BY status ORDER BY status`,
    ),

    query<{ environment: DeploymentEnvironment | null; count: string }>(
      `SELECT environment, COUNT(*)::text AS count
         FROM child_subnet
        WHERE status <> 'Released'
        GROUP BY environment
        ORDER BY environment NULLS LAST`,
    ),

    query<{ provider_location: ProviderLocation | null; count: string }>(
      `SELECT provider_location, COUNT(*)::text AS count
         FROM child_subnet
        WHERE status <> 'Released'
        GROUP BY provider_location
        ORDER BY provider_location NULLS LAST`,
    ),

    query<{
      id: string;
      cidr: string;
      name: string | null;
      country_name: string | null;
      region_group: RegionGroup;
      total_addresses: string;
      allocated_addresses: string;
      available_addresses: string;
    }>(
      `SELECT id, cidr, name, country_name, region_group,
              total_addresses::text, allocated_addresses::text,
              available_addresses::text
         FROM master_subnet_utilisation
        WHERE total_addresses > 0 AND allocated_addresses > 0
        ORDER BY (allocated_addresses::numeric / total_addresses::numeric) DESC
        LIMIT 10`,
    ),

    query<{ subscriptions: string; plan: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM azure_subscription) AS subscriptions,
         (SELECT COUNT(*)::text FROM subnet_plan)        AS plan`,
    ),
  ]);

  return {
    masterSubnets: num(totals[0]?.masters),
    childSubnets: num(totals[0]?.children),
    countries: num(totals[0]?.countries),
    totalAddresses: num(totals[0]?.total),
    allocatedAddresses: num(totals[0]?.allocated),
    availableAddresses: num(totals[0]?.available),

    byRegion: byRegion.map((r) => ({
      regionGroup: r.region_group,
      masterSubnets: num(r.masters),
      childSubnets: num(r.children),
      totalAddresses: num(r.total),
      allocatedAddresses: num(r.allocated),
      availableAddresses: num(r.available),
    })),

    byStatus: byStatus.map((r) => ({
      status: r.status,
      count: num(r.count),
    })),

    byEnvironment: byEnvironment.map((r) => ({
      environment: r.environment,
      count: num(r.count),
    })),

    byProvider: byProvider.map((r) => ({
      providerLocation: r.provider_location,
      count: num(r.count),
    })),

    mostUtilised: mostUtilised.map((r) => ({
      id: r.id,
      cidr: r.cidr,
      name: r.name,
      countryName: r.country_name,
      regionGroup: r.region_group,
      utilisation:
        num(r.total_addresses) > 0
          ? num(r.allocated_addresses) / num(r.total_addresses)
          : 0,
      availableAddresses: num(r.available_addresses),
    })),

    azureSubscriptions: num(extras[0]?.subscriptions),
    subnetPlanEntries: num(extras[0]?.plan),
  };
}
