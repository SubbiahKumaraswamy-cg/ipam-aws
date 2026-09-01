/**
 * Lambda entry point. Implements a small REST router over API Gateway
 * HTTP API events (payload format 2.0).
 *
 * Routes
 *   GET    /health
 *   GET    /me
 *   GET    /dashboard
 *   GET    /allocations                       ?environment&regionGroup&status&iso&search&within
 *   POST   /allocations                       (Editor+)
 *   GET    /allocations/export                -> CSV
 *   POST   /allocations/import                (Editor+) CSV or JSON array
 *   GET    /allocations/overlaps              ?cidr&excludeId
 *   GET    /allocations/{id}
 *   PUT    /allocations/{id}                  (Editor+)
 *   DELETE /allocations/{id}                  (Editor+)
 *   GET    /azure-subscriptions               ?portalType&regionGroup&search
 *   POST   /azure-subscriptions               (Editor+)
 *   GET    /azure-subscriptions/export        -> CSV
 *   POST   /azure-subscriptions/import        (Editor+)
 *   GET    /azure-subscriptions/{id}
 *   PUT    /azure-subscriptions/{id}          (Editor+)
 *   DELETE /azure-subscriptions/{id}          (Editor+)
 *   GET    /subnet-plan                       ?search&within
 *   POST   /subnet-plan                       (Editor+)
 *   GET    /subnet-plan/export                -> CSV
 *   POST   /subnet-plan/import                (Editor+)
 *   GET    /subnet-plan/{id}
 *   PUT    /subnet-plan/{id}                  (Editor+)
 *   DELETE /subnet-plan/{id}                  (Editor+)
 *   GET    /audit                             (Admin) ?limit
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import type {
  CloudAllocationInput,
  AzureSubscriptionInput,
  SubnetPlanEntryInput,
} from '@ipam/shared';
import { authenticate, requireEditor, requireAdmin, HttpError } from './auth';
import {
  ok,
  created,
  noContent,
  text,
  errorResponse,
  parseBody,
  queryParam,
  json,
} from './http';
import * as allocations from './repositories/allocations';
import * as subscriptions from './repositories/azureSubscriptions';
import * as plan from './repositories/subnetPlan';
import { getDashboardSummary } from './repositories/dashboard';
import { listAudit } from './repositories/audit';
import { toCsv, parseCsv, pick } from './csv';

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.requestContext?.http?.path ?? event.rawPath ?? '/';
  // Strip a stage prefix if the API is deployed with one.
  const path = rawPath.replace(/\/+$/, '') || '/';

  try {
    // CORS preflight — no auth required.
    if (method === 'OPTIONS') return noContent();

    // Health check is unauthenticated so infrastructure probes work.
    if (method === 'GET' && path.endsWith('/health')) {
      return ok({ status: 'ok', time: new Date().toISOString() });
    }

    const user = await authenticate(event);
    const segments = path.split('/').filter(Boolean);

    if (method === 'GET' && segments[0] === 'me') {
      return ok(user);
    }

    if (method === 'GET' && segments[0] === 'dashboard') {
      return ok(await getDashboardSummary());
    }

    if (segments[0] === 'allocations') {
      return await routeAllocations(event, method, segments, user.email, user);
    }

    if (segments[0] === 'azure-subscriptions') {
      return await routeSubscriptions(event, method, segments, user.email, user);
    }

    if (segments[0] === 'subnet-plan') {
      return await routePlan(event, method, segments, user.email, user);
    }

    if (method === 'GET' && segments[0] === 'audit') {
      requireAdmin(user);
      const limit = Number(queryParam(event, 'limit') ?? 200);
      return ok(await listAudit(Number.isFinite(limit) ? limit : 200));
    }

    return json(404, { error: `No route for ${method} ${path}` });
  } catch (err) {
    return errorResponse(err);
  }
}

type User = Awaited<ReturnType<typeof authenticate>>;

/* -------------------------------------------------------------------------- */
/* /allocations                                                               */
/* -------------------------------------------------------------------------- */

async function routeAllocations(
  event: APIGatewayProxyEventV2,
  method: string,
  segments: string[],
  actor: string,
  user: User,
): Promise<APIGatewayProxyResultV2> {
  const sub = segments[1];

  if (method === 'GET' && sub === 'export') {
    const rows = await allocations.listAllocations(readAllocationFilters(event));
    const csv = toCsv(rows as unknown as Record<string, unknown>[], [
      { key: 'environment', header: 'Environment' },
      { key: 'regionGroup', header: 'Region' },
      { key: 'iso', header: 'ISO' },
      { key: 'country', header: 'COUNTRY' },
      { key: 'cloudSpace', header: 'CLOUD SPACE' },
      { key: 'mask', header: 'MASK' },
      { key: 'cidr', header: 'CIDR' },
      { key: 'currentRange', header: 'Current Range' },
      { key: 'status', header: 'Status' },
      { key: 'remarks', header: 'Remarks' },
    ]);
    return text(200, csv, 'text/csv; charset=utf-8', 'allocations.csv');
  }

  if (method === 'POST' && sub === 'import') {
    requireEditor(user);
    const inputs = parseAllocationImport(event);
    if (inputs.length === 0) {
      throw new HttpError(400, 'No rows found in the import payload.');
    }
    const result = await allocations.bulkUpsertAllocations(inputs, actor);
    return ok({ ...result, total: inputs.length });
  }

  if (method === 'GET' && sub === 'overlaps') {
    const cidr = queryParam(event, 'cidr');
    if (!cidr) throw new HttpError(400, 'Query parameter "cidr" is required.');
    return ok(
      await allocations.findOverlaps(cidr, queryParam(event, 'excludeId')),
    );
  }

  if (method === 'GET' && !sub) {
    return ok(await allocations.listAllocations(readAllocationFilters(event)));
  }

  if (method === 'POST' && !sub) {
    requireEditor(user);
    const body = parseBody<CloudAllocationInput>(event);
    return created(await allocations.createAllocation(body, actor));
  }

  if (sub) {
    if (method === 'GET') return ok(await allocations.getAllocation(sub));
    if (method === 'PUT' || method === 'PATCH') {
      requireEditor(user);
      const body = parseBody<CloudAllocationInput>(event);
      return ok(await allocations.updateAllocation(sub, body, actor));
    }
    if (method === 'DELETE') {
      requireEditor(user);
      await allocations.deleteAllocation(sub, actor);
      return noContent();
    }
  }

  return json(405, { error: `Method ${method} not allowed on /allocations.` });
}

function readAllocationFilters(
  event: APIGatewayProxyEventV2,
): allocations.AllocationFilters {
  return {
    environment: queryParam(event, 'environment'),
    regionGroup: queryParam(event, 'regionGroup'),
    status: queryParam(event, 'status'),
    iso: queryParam(event, 'iso'),
    search: queryParam(event, 'search'),
    within: queryParam(event, 'within'),
  };
}

/**
 * Accept either a JSON array of allocation inputs or raw CSV whose headers
 * match the spreadsheet columns (ISO, COUNTRY, CLOUD SPACE, MASK, ...).
 */
function parseAllocationImport(
  event: APIGatewayProxyEventV2,
): CloudAllocationInput[] {
  const contentType =
    event.headers?.['content-type'] ?? event.headers?.['Content-Type'] ?? '';

  if (contentType.includes('text/csv')) {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');
    const records = parseCsv(raw);
    const defaultEnvironment = queryParam(event, 'environment');

    return records.map((record) => {
      const environment =
        pick(record, ['Environment', 'Cloud']) ?? defaultEnvironment;
      if (environment !== 'AWS' && environment !== 'Azure') {
        throw new HttpError(
          400,
          'Each CSV row needs an Environment of "AWS" or "Azure" ' +
            '(or pass ?environment=AWS on the request).',
        );
      }
      const regionGroup = pick(record, ['Region', 'Region Group', 'RegionGroup']);
      if (!regionGroup) {
        throw new HttpError(400, 'Each CSV row needs a Region value.');
      }
      const status = pick(record, ['Status']) ?? 'Allocated';

      return {
        environment,
        regionGroup,
        iso: pick(record, ['ISO', 'ISO Code']),
        country: pick(record, ['COUNTRY', 'Country', 'Market']),
        cloudSpace: pick(record, ['CLOUD SPACE', 'CloudSpace', 'Network']) ?? '',
        mask: pick(record, ['MASK', 'Mask', 'Subnet Mask']) ?? '',
        cidr: pick(record, ['CIDR']),
        currentRange: pick(record, ['Current Range', 'CurrentRange']),
        status,
        remarks: pick(record, ['Remarks', 'Notes', 'Comment']),
        tags: {},
      } as CloudAllocationInput;
    });
  }

  const body = parseBody<CloudAllocationInput[] | { rows: CloudAllocationInput[] }>(
    event,
  );
  const rows = Array.isArray(body) ? body : body.rows;
  if (!Array.isArray(rows)) {
    throw new HttpError(400, 'Expected a JSON array of rows, or {"rows": [...]}.');
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* /azure-subscriptions                                                       */
/* -------------------------------------------------------------------------- */

async function routeSubscriptions(
  event: APIGatewayProxyEventV2,
  method: string,
  segments: string[],
  actor: string,
  user: User,
): Promise<APIGatewayProxyResultV2> {
  const sub = segments[1];

  if (method === 'GET' && sub === 'export') {
    const rows = await subscriptions.listSubscriptions(readSubscriptionFilters(event));
    const csv = toCsv(rows as unknown as Record<string, unknown>[], [
      { key: 'portalType', header: 'Portal' },
      { key: 'subscription', header: 'Subscription' },
      { key: 'addressSpace', header: 'Address Space' },
      { key: 'cidr', header: 'CIDR' },
      { key: 'regionGroup', header: 'Region' },
      { key: 'remarks', header: 'Remarks' },
    ]);
    return text(200, csv, 'text/csv; charset=utf-8', 'azure-subscriptions.csv');
  }

  if (method === 'POST' && sub === 'import') {
    requireEditor(user);
    const inputs = parseSubscriptionImport(event);
    if (inputs.length === 0) {
      throw new HttpError(400, 'No rows found in the import payload.');
    }
    const result = await subscriptions.bulkUpsertSubscriptions(inputs, actor);
    return ok({ ...result, total: inputs.length });
  }

  if (method === 'GET' && !sub) {
    return ok(await subscriptions.listSubscriptions(readSubscriptionFilters(event)));
  }

  if (method === 'POST' && !sub) {
    requireEditor(user);
    const body = parseBody<AzureSubscriptionInput>(event);
    return created(await subscriptions.createSubscription(body, actor));
  }

  if (sub) {
    if (method === 'GET') return ok(await subscriptions.getSubscription(sub));
    if (method === 'PUT' || method === 'PATCH') {
      requireEditor(user);
      const body = parseBody<AzureSubscriptionInput>(event);
      return ok(await subscriptions.updateSubscription(sub, body, actor));
    }
    if (method === 'DELETE') {
      requireEditor(user);
      await subscriptions.deleteSubscription(sub, actor);
      return noContent();
    }
  }

  return json(405, {
    error: `Method ${method} not allowed on /azure-subscriptions.`,
  });
}

function readSubscriptionFilters(
  event: APIGatewayProxyEventV2,
): subscriptions.SubscriptionFilters {
  return {
    portalType: queryParam(event, 'portalType'),
    regionGroup: queryParam(event, 'regionGroup'),
    search: queryParam(event, 'search'),
  };
}

function parseSubscriptionImport(
  event: APIGatewayProxyEventV2,
): AzureSubscriptionInput[] {
  const contentType =
    event.headers?.['content-type'] ?? event.headers?.['Content-Type'] ?? '';

  if (contentType.includes('text/csv')) {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');
    const defaultPortal = queryParam(event, 'portalType');

    return parseCsv(raw).map((record) => {
      const portalType =
        pick(record, ['Portal', 'Portal Type', 'PortalType']) ?? defaultPortal;
      if (!portalType) {
        throw new HttpError(
          400,
          'Each CSV row needs a Portal value, or pass ?portalType=... on the request.',
        );
      }
      return {
        portalType,
        subscription: pick(record, ['Subscription', 'Subscription Name']) ?? '',
        addressSpace:
          pick(record, ['Address Space', 'AddressSpace', 'CLOUD SPACE']) ?? '',
        cidr: pick(record, ['CIDR']),
        regionGroup: pick(record, ['Region', 'Region Group']),
        remarks: pick(record, ['Remarks', 'Notes']),
      } as AzureSubscriptionInput;
    });
  }

  const body = parseBody<AzureSubscriptionInput[] | { rows: AzureSubscriptionInput[] }>(
    event,
  );
  const rows = Array.isArray(body) ? body : body.rows;
  if (!Array.isArray(rows)) {
    throw new HttpError(400, 'Expected a JSON array of rows, or {"rows": [...]}.');
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* /subnet-plan                                                               */
/* -------------------------------------------------------------------------- */

async function routePlan(
  event: APIGatewayProxyEventV2,
  method: string,
  segments: string[],
  actor: string,
  user: User,
): Promise<APIGatewayProxyResultV2> {
  const sub = segments[1];

  if (method === 'GET' && sub === 'export') {
    const rows = await plan.listPlanEntries({
      search: queryParam(event, 'search'),
      within: queryParam(event, 'within'),
    });
    const csv = toCsv(rows as unknown as Record<string, unknown>[], [
      { key: 'subnet16', header: '/16 SUBNETS' },
      { key: 'agg14', header: '/14 255.252.0.0' },
      { key: 'agg12', header: '/12 255.240.0.0' },
      { key: 'allocation', header: 'Allocation' },
      { key: 'remarks', header: 'Remarks' },
      { key: 'currentUsage', header: 'Current usage' },
      { key: 'change', header: 'Change' },
    ]);
    return text(200, csv, 'text/csv; charset=utf-8', 'subnet-plan.csv');
  }

  if (method === 'POST' && sub === 'import') {
    requireEditor(user);
    const inputs = parsePlanImport(event);
    if (inputs.length === 0) {
      throw new HttpError(400, 'No rows found in the import payload.');
    }
    const result = await plan.bulkUpsertPlanEntries(inputs, actor);
    return ok({ ...result, total: inputs.length });
  }

  if (method === 'GET' && !sub) {
    return ok(
      await plan.listPlanEntries({
        search: queryParam(event, 'search'),
        within: queryParam(event, 'within'),
      }),
    );
  }

  if (method === 'POST' && !sub) {
    requireEditor(user);
    const body = parseBody<SubnetPlanEntryInput>(event);
    return created(await plan.createPlanEntry(body, actor));
  }

  if (sub) {
    if (method === 'GET') return ok(await plan.getPlanEntry(sub));
    if (method === 'PUT' || method === 'PATCH') {
      requireEditor(user);
      const body = parseBody<SubnetPlanEntryInput>(event);
      return ok(await plan.updatePlanEntry(sub, body, actor));
    }
    if (method === 'DELETE') {
      requireEditor(user);
      await plan.deletePlanEntry(sub, actor);
      return noContent();
    }
  }

  return json(405, { error: `Method ${method} not allowed on /subnet-plan.` });
}

function parsePlanImport(event: APIGatewayProxyEventV2): SubnetPlanEntryInput[] {
  const contentType =
    event.headers?.['content-type'] ?? event.headers?.['Content-Type'] ?? '';

  if (contentType.includes('text/csv')) {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');

    return parseCsv(raw).map((record) => ({
      subnet16: pick(record, ['/16 SUBNETS', '16 SUBNETS', 'subnet16', '/16']),
      agg14: pick(record, ['/14 255.252.0.0', '/14', 'agg14']),
      agg12: pick(record, ['/12 255.240.0.0', '/12', 'agg12']),
      allocation: pick(record, ['Allocation']),
      remarks: pick(record, ['Remarks', 'Notes']),
      currentUsage: pick(record, ['Current usage', 'CurrentUsage', 'Usage']),
      change: pick(record, ['Change']),
    })) as SubnetPlanEntryInput[];
  }

  const body = parseBody<SubnetPlanEntryInput[] | { rows: SubnetPlanEntryInput[] }>(
    event,
  );
  const rows = Array.isArray(body) ? body : body.rows;
  if (!Array.isArray(rows)) {
    throw new HttpError(400, 'Expected a JSON array of rows, or {"rows": [...]}.');
  }
  return rows;
}
