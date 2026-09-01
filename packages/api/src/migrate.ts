/**
 * Migration runner.
 *
 * Applies every .sql file in ../migrations in lexical order, tracking which
 * have already run in a `schema_migrations` table. Runs either as a Lambda
 * (invoked once after deployment) or from the CLI for local development.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPool, closePool } from './db';

/**
 * Locate the migrations directory.
 *
 * The layout differs between environments: when bundled into a Lambda the
 * .sql files sit next to the handler, whereas locally they live one level up
 * from the compiled output.
 */
function resolveMigrationsDir(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    join(__dirname, 'migrations'),
    join(__dirname, '..', 'migrations'),
    join(process.cwd(), 'migrations'),
    join(process.cwd(), 'packages', 'api', 'migrations'),
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not locate the migrations directory. Looked in: ${candidates.join(', ')}`,
  );
}

export async function runMigrations(): Promise<{ applied: string[] }> {
  const migrationsDir = resolveMigrationsDir();
  console.log(`Using migrations directory: ${migrationsDir}`);

  const pool = await getPool();
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const done = new Set(
      (
        await client.query<{ filename: string }>(
          'SELECT filename FROM schema_migrations',
        )
      ).rows.map((r) => r.filename),
    );

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (done.has(file)) {
        console.log(`skip ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      console.log(`applying ${file} ...`);
      // Each migration runs in its own transaction so a failure leaves the
      // database in a consistent state.
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
        applied.push(file);
        console.log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${file} failed: ${(err as Error).message}`,
        );
      }
    }
  } finally {
    client.release();
  }

  return { applied };
}

/** Lambda handler used by the post-deployment custom resource. */
export async function handler(): Promise<{ applied: string[] }> {
  const result = await runMigrations();
  console.log('Migrations complete', result);
  return result;
}

// CLI entry point: `node dist/migrate.js`
if (require.main === module) {
  runMigrations()
    .then((r) => {
      console.log(
        r.applied.length
          ? `Applied ${r.applied.length} migration(s).`
          : 'Database already up to date.',
      );
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
