import { describe, expect, it } from 'vitest';
import { runMigrations, type MigrationClient } from './runner.js';

function fakeClient(opts: { applied?: string[]; failOn?: string } = {}) {
  const log: string[] = [];
  const applied = new Set(opts.applied ?? []);
  const client: MigrationClient = {
    query(text, params) {
      const t = text.trim();
      if (t.startsWith('SELECT name FROM schema_migrations')) {
        return Promise.resolve({ rows: [...applied].map((name) => ({ name })) });
      }
      if (t.startsWith('INSERT INTO schema_migrations')) {
        log.push(`insert:${params?.[0] ?? ''}`);
      } else if (opts.failOn !== undefined && t === opts.failOn) {
        log.push(`fail:${t}`);
        return Promise.reject(new Error('boom'));
      } else {
        log.push(t.startsWith('CREATE TABLE') ? 'bootstrap' : t);
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { client, log };
}

describe('runMigrations', () => {
  it('applies files in filename order regardless of input order', async () => {
    const { client, log } = fakeClient();
    const res = await runMigrations(client, [
      { name: '002_b.sql', sql: 'SQL-B' },
      { name: '001_a.sql', sql: 'SQL-A' },
    ]);
    expect(res.applied).toEqual(['001_a.sql', '002_b.sql']);
    expect(log.filter((l) => l.startsWith('SQL') || l.startsWith('insert'))).toEqual([
      'SQL-A',
      'insert:001_a.sql',
      'SQL-B',
      'insert:002_b.sql',
    ]);
  });

  it('skips already-applied files', async () => {
    const { client, log } = fakeClient({ applied: ['001_a.sql'] });
    const res = await runMigrations(client, [
      { name: '001_a.sql', sql: 'SQL-A' },
      { name: '002_b.sql', sql: 'SQL-B' },
    ]);
    expect(res).toEqual({ applied: ['002_b.sql'], skipped: ['001_a.sql'] });
    expect(log).not.toContain('SQL-A');
  });

  it('is a no-op when everything is applied', async () => {
    const { client, log } = fakeClient({ applied: ['001_a.sql'] });
    const res = await runMigrations(client, [{ name: '001_a.sql', sql: 'SQL-A' }]);
    expect(res.applied).toEqual([]);
    expect(log).not.toContain('BEGIN');
  });

  it('wraps each file in a transaction and commits', async () => {
    const { client, log } = fakeClient();
    await runMigrations(client, [{ name: '001_a.sql', sql: 'SQL-A' }]);
    expect(log.slice(log.indexOf('BEGIN'), log.indexOf('COMMIT') + 1)).toEqual([
      'BEGIN',
      'SQL-A',
      'insert:001_a.sql',
      'COMMIT',
    ]);
  });

  it('rolls back and stops on failure, keeping earlier files', async () => {
    const { client, log } = fakeClient({ failOn: 'SQL-B' });
    await expect(
      runMigrations(client, [
        { name: '001_a.sql', sql: 'SQL-A' },
        { name: '002_b.sql', sql: 'SQL-B' },
        { name: '003_c.sql', sql: 'SQL-C' },
      ]),
    ).rejects.toThrow('002_b.sql');
    expect(log).toContain('ROLLBACK');
    expect(log).not.toContain('insert:002_b.sql');
    expect(log).not.toContain('SQL-C');
    expect(log.filter((l) => l === 'COMMIT')).toHaveLength(1);
    expect(log.at(-1)).toMatch(/pg_advisory_unlock/);
  });
});
