/**
 * PostgreSQL connection management for the Lambda runtime.
 *
 * The pool is created lazily and cached on the module scope so that warm
 * Lambda invocations reuse connections. Credentials are read from Secrets
 * Manager (the secret created by the RDS construct) and cached in memory.
 */

import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

interface DbCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  dbname: string;
}

let cachedPool: Pool | null = null;
let cachedCredentials: DbCredentials | null = null;

const secretsClient = new SecretsManagerClient({});

/**
 * Resolve database credentials.
 *
 * Prefers explicit environment variables (useful for local development and
 * for the migration runner), otherwise falls back to the Secrets Manager
 * secret referenced by DB_SECRET_ARN.
 */
async function resolveCredentials(): Promise<DbCredentials> {
  if (cachedCredentials) return cachedCredentials;

  const {
    DB_HOST,
    DB_PORT,
    DB_USER,
    DB_PASSWORD,
    DB_NAME,
    DB_SECRET_ARN,
  } = process.env;

  if (DB_HOST && DB_USER && DB_PASSWORD) {
    cachedCredentials = {
      host: DB_HOST,
      port: Number(DB_PORT ?? 5432),
      username: DB_USER,
      password: DB_PASSWORD,
      dbname: DB_NAME ?? 'ipam',
    };
    return cachedCredentials;
  }

  if (!DB_SECRET_ARN) {
    throw new Error(
      'No database configuration found: set DB_SECRET_ARN or DB_HOST/DB_USER/DB_PASSWORD.',
    );
  }

  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }),
  );
  if (!result.SecretString) {
    throw new Error(`Secret ${DB_SECRET_ARN} contains no string value.`);
  }

  const parsed = JSON.parse(result.SecretString) as Partial<DbCredentials> & {
    dbInstanceIdentifier?: string;
    engine?: string;
  };

  if (!parsed.host || !parsed.username || !parsed.password) {
    throw new Error(`Secret ${DB_SECRET_ARN} is missing host/username/password.`);
  }

  cachedCredentials = {
    host: parsed.host,
    port: Number(parsed.port ?? 5432),
    username: parsed.username,
    password: parsed.password,
    dbname: DB_NAME ?? parsed.dbname ?? 'ipam',
  };
  return cachedCredentials;
}

/** Get (or lazily create) the shared connection pool. */
export async function getPool(): Promise<Pool> {
  if (cachedPool) return cachedPool;

  const creds = await resolveCredentials();
  cachedPool = new Pool({
    host: creds.host,
    port: creds.port,
    user: creds.username,
    password: creds.password,
    database: creds.dbname,
    // Lambda concurrency means many short-lived containers; keep pools small.
    max: Number(process.env.DB_POOL_MAX ?? 2),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl:
      process.env.DB_SSL === 'disable'
        ? undefined
        : { rejectUnauthorized: false },
  });

  cachedPool.on('error', (err) => {
    console.error('Unexpected idle client error', err);
  });

  return cachedPool;
}

/** Run a parameterised query and return the rows. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const pool = await getPool();
  const result = await pool.query<T>(sql, params as never[]);
  return result.rows;
}

/** Run a parameterised query expecting at most one row. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** Execute a function inside a transaction, rolling back on error. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Close the pool (used by scripts; Lambda keeps it warm instead). */
export async function closePool(): Promise<void> {
  if (cachedPool) {
    await cachedPool.end();
    cachedPool = null;
  }
}
