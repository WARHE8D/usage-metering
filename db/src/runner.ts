export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

/** Minimal DB surface needed by the runner. Must be a single connection (transactions, locks). */
export interface MigrationClient {
  query(text: string, params?: readonly string[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface MigrationResult {
  readonly applied: string[];
  readonly skipped: string[];
}

// Arbitrary constant; serializes concurrent migration runs via a session advisory lock.
const LOCK_KEY = '727465001';

export function sortMigrations(files: readonly MigrationFile[]): MigrationFile[] {
  return [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Applies pending migrations in filename order. Each file runs in its own transaction
 * together with its schema_migrations bookkeeping row; a failure rolls that file back
 * and aborts the run.
 */
export async function runMigrations(
  client: MigrationClient,
  files: readonly MigrationFile[],
): Promise<MigrationResult> {
  const applied: string[] = [];
  const skipped: string[] = [];

  await client.query('SELECT pg_advisory_lock($1::bigint)', [LOCK_KEY]);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name       text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => String(r.name)));

    for (const file of sortMigrations(files)) {
      if (done.has(file.name)) {
        skipped.push(file.name);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file.name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file.name} failed`, { cause: err });
      }
      applied.push(file.name);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
  }
  return { applied, skipped };
}
