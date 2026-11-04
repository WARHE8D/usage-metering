import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadDbConfig } from './config.js';
import { readMigrationFiles } from './files.js';
import { runMigrations } from './runner.js';

const sqlDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<void> {
  const { databaseUrl } = loadDbConfig(process.env);
  const files = await readMigrationFiles(sqlDir);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { applied, skipped } = await runMigrations(client, files);
    for (const n of skipped) console.log(`skip   ${n}`);
    for (const n of applied) console.log(`apply  ${n}`);
    console.log(`done: ${String(applied.length)} applied, ${String(skipped.length)} skipped`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
