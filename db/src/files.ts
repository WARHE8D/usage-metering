import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MigrationFile } from './runner.js';

export async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(path.join(dir, name), 'utf8') })),
  );
}
