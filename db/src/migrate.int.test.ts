import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDbConfig } from './config.js';
import { readMigrationFiles } from './files.js';
import { runMigrations } from './runner.js';

const sqlDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('migrations against Postgres', () => {
  const client = new pg.Client({
    connectionString: loadDbConfig(process.env).databaseUrl,
  });
  beforeAll(() => client.connect());
  afterAll(() => client.end());

  it('applies idempotently and creates usage_records', async () => {
    const files = await readMigrationFiles(sqlDir);
    await runMigrations(client, files);
    const second = await runMigrations(client, files);
    expect(second.applied).toEqual([]);
    const r = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM information_schema.columns WHERE table_name = 'usage_records'",
    );
    expect(r.rows[0]?.n).toBe('6');
  });
});
