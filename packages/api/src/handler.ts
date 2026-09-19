/**
 * Lambda entry point — a small REST router over API Gateway HTTP API events.
 *
 * Authorisation summary
 *   Reads               any authenticated user
 *   Child/master writes Author, Admin, or a CountryOwner for that country
 *   Countries           Author or Admin
 *   Custom fields       Admin
 *   Country owners      Admin
 *   Audit               Admin
 *
 * Routes
 *   GET    /health                          (public)
 *   GET    /me
 *   GET    /dashboard
 *
 *   GET    /countries                       ?regionGroup&search&activeOnly
 *   POST   /countries                       (Author+)
 *   GET    /countries/export                -> CSV
 *   POST   /countries/import                (Author+)
 *   GET    /countries/{iso}
 *   PUT    /countries/{iso}                 (Author+)
 *   DELETE /countries/{iso}                 (Author+)
 *
 *   GET    /master-subnets                  ?regionGroup&countryIso&providerLocation&search&within
 *   POST   /master-subnets                  (country-scoped)
 *   GET    /master-subnets/export           -> CSV
 *   GET    /master-subnets/overlaps         ?cidr&excludeId
 *   GET    /master-subnets/{id}
 *   PUT    /master-subnets/{id}             (country-scoped)
 *   DELETE /master-subnets/{id}             (country-scoped)
 *   GET    /master-subnets/{id}/free-space  ?prefix
 *   GET    /master-subnets/{id}/children
 *
 *   GET    /child-subnets                   ?masterSubnetId&regionGroup&countryIso&status&environment&providerLocation&technicalOwner&requestorName&search&within
 *   POST   /child-subnets                   (country-scoped)
 *   GET    /child-subnets/export            -> CSV
 *   GET    /child-subnets/overlaps          ?cidr&excludeId
 *   GET    /child-subnets/{id}
 *   PUT    /child-subnets/{id}              (country-scoped)
 *   DELETE /child-subnets/{id}              (country-scoped)
 *   POST   /child-subnets/{id}/release      (country-scoped)
 *
 *   GET    /custom-fields                   ?entity&includeInactive
 *   POST   /custom-fields                   (Admin)
 *   PUT    /custom-fields/{id}              (Admin)
 *   DELETE /custom-fields/{id}              (Admin)
 *
 *   GET    /country-owners                  (Admin) ?userEmail&countryIso
 *   POST   /country-owners                  (Admin)
 *   PUT    /country-owners                  (Admin) replace one user's set
 *   DELETE /country-owners/{id}             (Admin)
 *
 *   GET    /azure-subscriptions ... (unchanged)
 *   GET    /subnet-plan ...        (unchanged)
 *   GET    /audit                           (Admin)
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import type {
  AuthenticatedUser,
  CountryInput,
  MasterSubnetInput,
  ChildSubnetInput,
  CustomFieldInput,
  CountryOwnerInput,
  AzureSubscriptionInput,
  SubnetPlanEntryInput,
} from '@ipam/shared';
import {
  authenticate,
  requireAdmin,
  requireGlobalAuthor,
  requireCountryWrite,
  HttpError,
} from './auth';
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
import * as countries from './repositories/countries';
import * as masters from './repositories/masterSubnets';
import * as children from './repositories/childSubnets';
import * as customFields from './repositories/customFields';
import * as owners from './repositories/countryOwners';
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
  const path = rawPath.replace(/\/+$/, '') || '/';

  try {
    if (method === 'OPTIONS') return noContent();

    // Unauthenticated so infrastructure probes work.
    if (method === 'GET' && path.endsWith('/health')) {
      return ok({ status: 'ok', time: new Date().toISOString() });
    }

    const user = await authenticate(event);
    const segments = path.split('/').filter(Boolean);
    const root = segments[0];

    if (method === 'GET' && root === 'me') return ok(user);
    if (method === 'GET' && root === 'dashboard') {
      return ok(await getDashboardSummary());
    }

    switch (root) {
      case 'countries':
        return await routeCountries(event, method, segments, user);
      case 'master-subnets':
        return await routeMasters(event, method, segments, user);
      case 'child-subnets':
        return await routeChildren(event, method, segments, user);
      case 'custom-fields':
        return await routeCustomFields(event, method, segments, user);
      case 'country-owners':
        return await routeCountryOwners(event, method, segments, user);
      case 'azure-subscriptions':
        return await routeSubscriptions(event, method, segments, user);
      case 'subnet-plan':
        return await routePlan(event, method, segments, user);
      case 'audit': {
        if (method !== 'GET') break;
        requireAdmin(user);
        const limit = Number(queryParam(event, 'limit') ?? 200);
        return ok(await listAudit(Number.isFinite(limit) ? limit : 200));
      }
      default:
        break;
    }

    return json(404, { error: `No route for ${method} ${path}` });
  } catch (err) {
    return errorResponse(err);
  }
}

/* -------------------------------------------------------------------------- */
/* /countries                                                                 */
/* -------------------------------------------------------------------------- */

async function routeCountries(
  event: APIGatewayProxyEventV2,
  method: string,
  segments: string[],
  user: AuthenticatedUser,
): Promise<APIGatewayProxyResultV2> {
  const sub = segments[1];

  if (method === 'GET' && sub === 'export') {
    const rows = await countries.listCountries(readCountryFilters(event));
    return text(
      200,
      toCsv(rows as unknown as Record<string, unknown>[], [
        { key: 'iso', header: 'ISO' },
        { key: 'name', header: 'Country' },
        { key: 'regionGroup', header: 'Region' },
        { key: 'active', header: 'Active' },
        { key: 'remarks', header: 'Remarks' },
      ]),
      'text/csv; charset=utf-8',
      'countries.csv',
    );
  }

  if (method === 'POST' && sub === 'import') {
    requireGlobalAuthor(user);
    const rows = parseCountryImport(event);
    if (rows.length === 0) throw new HttpError(400, 'No rows found to import.');
    const result = await countries.bulkUpsertCountries(rows, user.email);
    return ok({ ...result, total: rows.length });
  }

  if (!sub) {
    if (method === 'GET') {
      return ok(await countries.listCountries(readCountryFilters(event)));
    }
    if (method === 'POST') {
      requireGlobalAuthor(user);
      const body = parseBody<CountryInput>(event);
      body.attributes = await customFields.sanitiseAttributes(
        'country',
        body.attributes,
      );
      return created(await countries.createCountry(body, user.email));
    }
  } else {
    if (method === 'GET') return ok(await countries.getCountry(sub));
    if (method === 'PUT' || method === 'PATCH') {
      requireGlobalAuthor(user);
      const body = parseBody<CountryInput>(event);
      body.attributes = await customFields.sanitiseAttributes(
        'country',
        body.attributes,
      );
      return ok(await countries.updateCountry(sub, body, user.email));
    }
    if (method === 'DELETE') {
      requireGlobalAuthor(user);
      await countries.deleteCountry(sub, user.email);
      return noContent();
    }
  }

  return json(405, { error: `Method ${method} not allowed on /countries.` });
}

function readCountryFilters(
  event: APIGatewayProxyEventV2,
): countries.CountryFilters {
  return {
    regionGroup: queryParam(event, 'regionGroup'),
    search: queryParam(event, 'search'),
    activeOnly: queryParam(event, 'activeOnly'),
  };
}

function parseCountryImport(event: APIGatewayProxyEventV2): CountryInput[] {
  const contentType =
    event.headers?.['content-type'] ?? event.headers?.['Content-Type'] ?? '';

  if (contentType.includes('text/csv')) {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');
    return parseCsv(raw).map((record) => {
      const activeRaw = pick(record, ['Active', 'Enabled']);
      return {
        iso: pick(record, ['ISO', 'ISO Code', 'Code']) ?? '',
        name: pick(record, ['Country', 'Name', 'Market']) ?? '',
        regionGroup: (pick(record, ['Region', 'Region Group']) ?? '') as
          CountryInput['regionGroup'],
        active: activeRaw === null ? true : /^(true|yes|1|y)$/i.test(activeRaw),
        remarks: pick(record, ['Remarks', 'Notes']),
        attributes: {},
      };
    });
  }

  const body = parseBody<CountryInput[] | { rows: CountryInput[] }>(event);
  const rows = Array.isArray(body) ? body : body.rows;
  if (!Array.isArray(rows)) {
    throw new HttpError(400, 'Expected a JSON array of rows, or {"rows": [...]}.');
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* /master-subnets                                                            */
/* -------------------------------------------------------------------------- */

async function routeMasters(
  event: APIGatewayProxyEventV2,
  method: string,
  segments: string[],
  user: AuthenticatedUser,
): Promise<APIGatewayProxyResultV2> {
  const sub = segments[1];
  const action = segments[2];

  if (method === 'GET' && sub === 'export') {
    const rows = await masters.listMasters(readMasterFilters(event));
    return text(
      200,
      toCsv(rows as unknown as Record<string, unknown>[], [
        { key: 'cidr', header: 'Master Subnet' },
        { key: 'name', header: 'Name' },
        { key: 'regionGroup', header: 'Region' },
        { key: 'countryIso', header: 'ISO' },
        { key: 'countryName', header: 'Country' },
        { key: 'providerLocation', header: 'Provider / Location' },
        { key: 'totalAddresses', header: 'Total Addresses' },
        { key: 'allocatedAddresses', header: 'Allocated' },
        { key: 'availableAddresses', header: 'Available' },
        { key: 'totalChildren', header: 'Child Subnets' },
        { key: 'description', header: 'Description' },
        { key: 'remarks', header: 'Remarks' },
      ]),
      'text/csv; charset=utf-8',
      'master-subnets.csv',
    );
  }

  if (method === 'GET' && sub === 'overlaps') {
    const cidr = queryParam(event, 'cidr');
    if (!cidr) throw new HttpError(400, 'Query parameter "cidr" is required.');
    return ok(
      await masters.findOverlappingMasters(cidr, queryParam(event, 'excludeId')),
    );
  }

  if (method === 'POST' && sub === 'import') {
    // Imports span countries, so they need global rights.
    requireGlobalAuthor(user);
    const rows = parseMasterImport(event);
    if (rows.length === 0) throw new HttpError(400, 'No rows found to import.');
    const result = await masters.bulkUpsertMasters(rows, user.email);
    return ok({ ...result, total: rows.length });
  }

  if (!sub) {
    if (method === 'GET') {
      return ok(await masters.listMasters(readMasterFilters(event)));
    }
    if (method === 'POST') {
      const body = parseBody<MasterSubnetInput>(event);
      requireCountryWrite(user, body.countryIso);
      body.attributes = await customFields.sanitiseAttributes(
        'master_subnet',
        body.attributes,
      );
      return created(await masters.createMaster(body, user.email));
    }
  } else if (action === 'free-space' && method === 'GET') {
    const prefixRaw = queryParam(event, 'prefix');
    const prefix = prefixRaw === undefined ? undefined : Number(prefixRaw);
    if (prefix !== undefined && !Number.isFinite(prefix)) {
      throw new HttpError(400, 'prefix must be a number.');
    }
    return ok(await masters.findFreeSpace(sub, prefix));
  } else if (action === 'children' && method === 'GET') {
    return ok(await children.listChildren({ masterSubnetId: sub }));
  } else if (!action) {
    if (method === 'GET') return ok(await masters.getMaster(sub));
    if (method === 'PUT' || method === 'PATCH') {
      const existing = await masters.getMaster(sub);
      const body = parseBody<MasterSubnetInput>(event);
      // Writable in both the current and the target country.
      requireCountryWrite(user, existing.countryIso);
      requireCountryWrite(user, body.countryIso);
      body.attributes = await customFields.sanitiseAttributes(
        'master_subnet',
        body.attributes,
      );
      return ok(await masters.updateMaster(sub, body, user.email));
    }
    if (method === 'DELETE') {
      const existing = await masters.getMaster(sub);
      requireCountryWrite(user, existing.countryIso);
      await masters.deleteMaster(sub, user.email);
      return noContent();
    }
  }

  return json(405, { error: `Method ${method} not allowed on /master-subnets.` });
}

function readMasterFilters(
  event: APIGatewayProxyEventV2,
): masters.MasterFilters {
  return {
    regionGroup: queryParam(event, 'regionGroup'),
    countryIso: queryParam(event, 'countryIso'),
    providerLocation: queryParam(event, 'providerLocation'),
    search: queryParam(event, 'search'),
    within: queryParam(event, 'within'),
  };
}

/** Accept a JSON array of master subnets, or CSV from the importer. */
function parseMasterImport(event: APIGatewayProxyEventV2): MasterSubnetInput[] {
  const contentType =
    event.headers?.['content-type'] ?? event.headers?.['Content-Type'] ?? '';

  if (contentType.includes('text/csv')) {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');

    return parseCsv(raw).map((record) => {
      // Accept either a single CIDR column or the spreadsheet's
      // "CLOUD SPACE" + "MASK" pair.
      const cidrDirect = pick(record, ['Master Subnet', 'CIDR', 'Subnet']);
      const space = pick(record, ['CLOUD SPACE', 'CloudSpace', 'Network']);
      const mask = pick(record, ['MASK', 'Mask', 'Prefix']);
      const cidr =
        cidrDirect ?? (space && mask ? `${space}/${String(mask).replace(/^\//, '')}` : space);

      return {
        name: pick(record, ['Name', 'COUNTRY', 'Country']),
        cidr: cidr ?? '',
        regionGroup: (pick(record, ['Region', 'Region Group']) ?? '') as
          MasterSubnetInput['regionGroup'],
        countryIso: pick(record, ['ISO', 'ISO Code']),
        providerLocation: pick(record, [
          'Provider / Location',
          'Provider',
          'Cloud',
          'Environment',
        ]) as MasterSubnetInput['providerLocation'],
        description: pick(record, ['Description']),
        remarks: pick(record, ['Remarks', 'Notes']),
        attributes: {},
      } as MasterSubnetInput;
    });
  }

  const body = parseBody<MasterSubnetInput[] | { rows: MasterSubnetInput[] }>(event);
  const rows = Array.isArray(body) ? body : body.rows;
  if (!Array.isArray(rows)) {
    throw new HttpError(400, 'Expected a JSON array of rows, or {"rows": [...]}.');
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* /child-subnets                                                             */
/* -------------------------------------------------------------------------- */

async function routeChildren(
  event: APIGatewayProxyEventV2,
  method: string,
  segments: string[],
  user: AuthenticatedUser,
): Promise<APIGatewayProxyResultV2> {
  const sub = segments[1];
  const action = segments[2];

  if (method === 'GET' && sub === 'export') {
    const rows = await children.listChildren(readChildFilters(event));
    return text(
      200,
      toCsv(rows as unknown as Record<string, unknown>[], [
        { key: 'cidr', header: 'Child Subnet' },
        { key: 'name', header: 'Name' },
        { key: 'masterCidr', header: 'Master Subnet' },
        { key: 'regionGroup', header: 'Region' },
        { key: 'countryIso', header: 'ISO' },
        { key: 'countryName', header: 'Country' },
        { key: 'status', header: 'Status' },
        { key: 'environment', header: 'Environment' },
        { key: 'providerLocation', header: 'Provider / Location' },
        { key: 'requestorName', header: 'Requestor Name' },
        { key: 'requestDate', header: 'Request Date' },
        { key: 'allocatedDate', header: 'Allocated Date' },
        { key: 'technicalOwner', header: 'Technical Owner' },
        { key: 'justification', header: 'Justification / Purpose' },
        { key: 'totalAddresses', header: 'Total Addresses' },
        { key: 'usableHosts', header: 'Usable Hosts' },
        { key: 'remarks', header: 'Remarks' },
      ]),
      'text/csv; charset=utf-8',
      'child-subnets.csv',
    );
  }

  if (method === 'GET' && sub === 'overlaps') {
    const cidr = queryParam(event, 'cidr');
    if (!cidr) throw new HttpError(400, 'Query parameter "cidr" is required.');
    return ok(
      await children.findOverlappingChildren(cidr, queryParam(event, 'excludeId')),
    );
  }

  if (!sub) {
    if (method === 'GET') {
      return ok(await children.listChildren(readChildFilters(event)));
    }
    if (method === 'POST') {
      const body = parseBody<ChildSubnetInput>(event);
      body.attributes = await customFields.sanitiseAttributes(
        'child_subnet',
        body.attributes,
      );
      // createChild performs the country-scoped check via its master.
      return created(await children.createChild(body, user));
    }
  } else if (action === 'release' && method === 'POST') {
    return ok(await children.releaseChild(sub, user));
  } else if (!action) {
    if (method === 'GET') return ok(await children.getChild(sub));
    if (method === 'PUT' || method === 'PATCH') {
      const body = parseBody<ChildSubnetInput>(event);
      body.attributes = await customFields.sanitiseAttributes(
        'child_subnet',
        body.attributes,
      );
      return ok(await children.updateChild(sub, body, user));
    }
    if (method === 'DELETE') {
      await children.deleteChild(sub, user);
      return noContent();
    }
  }

  return json(405, { error: `Method ${method} not allowed on /child-subnets.` });
}

function readChildFilters(
  event: APIGatewayProxyEventV2,
): children.ChildFilters {
  return {
    masterSubnetId: queryParam(event, 'masterSubnetId'),
    regionGroup: queryParam(event, 'regionGroup'),
    countryIso: queryParam(event, 'countryIso'),
    status: queryParam(event, 'status'),
    environment: queryParam(event, 'environment'),
    providerLocation: queryParam(event, 'providerLocation'),
    technicalOwner: queryParam(event, 'technicalOwner'),
    requestorName: queryParam(event, 'requestorName'),
    search: queryParam(event, 'search'),
    within: queryParam(event, 'within'),
  };
}

/* -------------------------------------------------------------------------- */
/* /custom-fields                                                             */
/* -------------------------------------------------------------------------- */

async function routeCustomFields(
  event: APIGatewayProxyEventV2,
  method: string,
  segments: string[],
  user: AuthenticatedUser,
): Promise<APIGatewayProxyResultV2> {
  const id = segments[1];

  if (!id) {
    if (method === 'GET') {
      // Every authenticated user needs the definitions to render the grids.
      return ok(
        await customFields.listCustomFields(
          queryParam(event, 'entity'),
          queryParam(event, 'includeInactive') === 'true',
        ),
      );
    }
    if (method === 'POST') {
      requireAdmin(user);
      const body = parseBody<CustomFieldInput>(event);
      return created(await customFields.createCustomField(body, user.email));
    }
  } else {
    if (method === 'GET') return ok(await customFields.getCustomField(id));
    if (method === 'PUT' || method === 'PATCH') {
      requireAdmin(user);
      const body = parseBody<CustomFieldInput>(event);
      return ok(await customFields.updateCustomField(id, body, user.email));
    }
    if (method === 'DELETE') {
      requireAdmin(user);
      await customFields.deleteCustomField(id, user.email);
      return noContent();
    }
  }

  return json(405, { error: `Method ${method} not allowed on /custom-fields.` });
}

/* -------------------------------------------------------------------------- */
/* /country-owners                                                            */
/* -------------------------------------------------------------------------- */

async function routeCountryOwners(
  event: APIGatewayProxyEventV2,
  method: string,
  segments: string[],
  user: AuthenticatedUser,
): Promise<APIGatewayProxyResultV2> {
  const id = segments[1];
  requireAdmin(user);

  if (!id) {
    if (method === 'GET') {
      if (queryParam(event, 'summary') === 'true') {
        return ok(await owners.summariseOwners());
      }
      return ok(
        await owners.listCountryOwners(
          queryParam(event, 'userEmail'),
          queryParam(event, 'countryIso'),
        ),
      );
    }
    if (method === 'POST') {
      const body = parseBody<CountryOwnerInput>(event);
      return created(await owners.createCountryOwner(body, user.email));
    }
    if (method === 'PUT') {
      // Replace one user's complete set of countries.
      const body = parseBody<{ userEmail: string; countries: string[] }>(event);
      if (!Array.isArray(body.countries)) {
        throw new HttpError(400, 'countries must be an array of ISO codes.');
      }
      return ok(
        await owners.setCountryOwnerships(
          body.userEmail,
          body.countries,
          user.email,
        ),
      );
    }
  } else if (method === 'DELETE') {
    await owners.deleteCountryOwner(id, user.email);
    return noContent();
  }

  return json(405, { error: `Method ${method} not allowed on /country-owners.` });
}

/* -------------------------------------------------------------------------- */
/* /azure-subscriptions                                                       */
/* -------------------------------------------------------------------------- */

async function routeSubscriptions(
  event: APIGatewayProxyEventV2,
  method: string,
  segments: string[],
  user: AuthenticatedUser,
): Promise<APIGatewayProxyResultV2> {
  const sub = segments[1];

  if (method === 'GET' && sub === 'export') {
    const rows = await subscriptions.listSubscriptions(
      readSubscriptionFilters(event),
    );
    return text(
      200,
      toCsv(rows as unknown as Record<string, unknown>[], [
        { key: 'portalType', header: 'Portal' },
        { key: 'subscription', header: 'Subscription' },
        { key: 'addressSpace', header: 'Address Space' },
        { key: 'cidr', header: 'CIDR' },
        { key: 'regionGroup', header: 'Region' },
        { key: 'remarks', header: 'Remarks' },
      ]),
      'text/csv; charset=utf-8',
      'azure-subscriptions.csv',
    );
  }

  if (method === 'POST' && sub === 'import') {
    requireGlobalAuthor(user);
    const rows = parseSubscriptionImport(event);
    if (rows.length === 0) throw new HttpError(400, 'No rows found to import.');
    const result = await subscriptions.bulkUpsertSubscriptions(rows, user.email);
    return ok({ ...result, total: rows.length });
  }

  if (!sub) {
    if (method === 'GET') {
      return ok(
        await subscriptions.listSubscriptions(readSubscriptionFilters(event)),
      );
    }
    if (method === 'POST') {
      requireGlobalAuthor(user);
      return created(
        await subscriptions.createSubscription(
          parseBody<AzureSubscriptionInput>(event),
          user.email,
        ),
      );
    }
  } else {
    if (method === 'GET') return ok(await subscriptions.getSubscription(sub));
    if (method === 'PUT' || method === 'PATCH') {
      requireGlobalAuthor(user);
      return ok(
        await subscriptions.updateSubscription(
          sub,
          parseBody<AzureSubscriptionInput>(event),
          user.email,
        ),
      );
    }
    if (method === 'DELETE') {
      requireGlobalAuthor(user);
      await subscriptions.deleteSubscription(sub, user.email);
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
          'Each row needs a Portal value, or pass ?portalType=... on the request.',
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

  const body = parseBody<
    AzureSubscriptionInput[] | { rows: AzureSubscriptionInput[] }
  >(event);
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
  user: AuthenticatedUser,
): Promise<APIGatewayProxyResultV2> {
  const sub = segments[1];

  if (method === 'GET' && sub === 'export') {
    const rows = await plan.listPlanEntries({
      search: queryParam(event, 'search'),
      within: queryParam(event, 'within'),
    });
    return text(
      200,
      toCsv(rows as unknown as Record<string, unknown>[], [
        { key: 'subnet16', header: '/16 SUBNETS' },
        { key: 'agg14', header: '/14 255.252.0.0' },
        { key: 'agg12', header: '/12 255.240.0.0' },
        { key: 'allocation', header: 'Allocation' },
        { key: 'remarks', header: 'Remarks' },
        { key: 'currentUsage', header: 'Current usage' },
        { key: 'change', header: 'Change' },
      ]),
      'text/csv; charset=utf-8',
      'subnet-plan.csv',
    );
  }

  if (method === 'POST' && sub === 'import') {
    requireGlobalAuthor(user);
    const rows = parsePlanImport(event);
    if (rows.length === 0) throw new HttpError(400, 'No rows found to import.');
    const result = await plan.bulkUpsertPlanEntries(rows, user.email);
    return ok({ ...result, total: rows.length });
  }

  if (!sub) {
    if (method === 'GET') {
      return ok(
        await plan.listPlanEntries({
          search: queryParam(event, 'search'),
          within: queryParam(event, 'within'),
        }),
      );
    }
    if (method === 'POST') {
      requireGlobalAuthor(user);
      return created(
        await plan.createPlanEntry(
          parseBody<SubnetPlanEntryInput>(event),
          user.email,
        ),
      );
    }
  } else {
    if (method === 'GET') return ok(await plan.getPlanEntry(sub));
    if (method === 'PUT' || method === 'PATCH') {
      requireGlobalAuthor(user);
      return ok(
        await plan.updatePlanEntry(
          sub,
          parseBody<SubnetPlanEntryInput>(event),
          user.email,
        ),
      );
    }
    if (method === 'DELETE') {
      requireGlobalAuthor(user);
      await plan.deletePlanEntry(sub, user.email);
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
