/**
 * Small HTTP helpers for API Gateway HTTP API (payload format 2.0).
 */

import type { APIGatewayProxyResultV2, APIGatewayProxyEventV2 } from 'aws-lambda';
import { HttpError } from './auth';

const baseHeaders: Record<string, string> = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
};

/** CORS headers. The allowed origin is configured at deploy time. */
function corsHeaders(): Record<string, string> {
  const origin = process.env.CORS_ALLOW_ORIGIN ?? '*';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-max-age': '3600',
  };
}

export function json(
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { ...baseHeaders, ...corsHeaders(), ...extraHeaders },
    body: JSON.stringify(body),
  };
}

export function ok(body: unknown): APIGatewayProxyResultV2 {
  return json(200, body);
}

export function created(body: unknown): APIGatewayProxyResultV2 {
  return json(201, body);
}

export function noContent(): APIGatewayProxyResultV2 {
  return {
    statusCode: 204,
    headers: { ...corsHeaders() },
    body: '',
  };
}

/** Plain-text/CSV response used by the export endpoints. */
export function text(
  statusCode: number,
  body: string,
  contentType: string,
  filename?: string,
): APIGatewayProxyResultV2 {
  const headers: Record<string, string> = {
    'content-type': contentType,
    ...corsHeaders(),
  };
  if (filename) {
    headers['content-disposition'] = `attachment; filename="${filename}"`;
  }
  return { statusCode, headers, body };
}

/** Convert any thrown value into an API response. */
export function errorResponse(err: unknown): APIGatewayProxyResultV2 {
  if (err instanceof HttpError) {
    return json(err.statusCode, { error: err.message });
  }
  // Postgres unique-violation -> 409 so the UI can show a friendly message.
  const code = (err as { code?: string })?.code;
  if (code === '23505' || code === '23P01') {
    return json(409, { error: 'A record with those values already exists.' });
  }
  if (code === '22P02' || code === '22P03') {
    return json(400, { error: 'One or more values have an invalid format.' });
  }
  console.error('Unhandled error', err);
  return json(500, { error: 'Internal server error.' });
}

/** Parse a JSON request body, tolerating base64 encoding. */
export function parseBody<T>(event: APIGatewayProxyEventV2): T {
  if (!event.body) {
    throw new HttpError(400, 'Request body is required.');
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

/** Read a single query-string parameter. */
export function queryParam(
  event: APIGatewayProxyEventV2,
  name: string,
): string | undefined {
  const value = event.queryStringParameters?.[name];
  return value === undefined || value === '' ? undefined : value;
}
