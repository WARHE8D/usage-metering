import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://usage:s3cret@localhost:5432/usage_metering',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadWorkerConfig', () => {
  it('applies defaults (concurrency 5, pool = concurrency + 2)', () => {
    expect(loadWorkerConfig(base)).toEqual({
      databaseUrl: base.DATABASE_URL,
      redisUrl: base.REDIS_URL,
      concurrency: 5,
      pgPoolMax: 7,
      eventsChannel: 'usage.recorded',
      shutdownTimeoutMs: 10_000,
      logLevel: 'info',
    });
  });

  it('reads overrides', () => {
    expect(
      loadWorkerConfig({
        ...base,
        WORKER_CONCURRENCY: '10',
        PG_POOL_MAX: '4',
        USAGE_EVENTS_CHANNEL: 'test.channel',
        SHUTDOWN_TIMEOUT_MS: '2000',
        LOG_LEVEL: 'debug',
      }),
    ).toMatchObject({
      concurrency: 10,
      pgPoolMax: 4,
      eventsChannel: 'test.channel',
      shutdownTimeoutMs: 2000,
      logLevel: 'debug',
    });
  });

  it('derives the pool size from an overridden concurrency', () => {
    expect(loadWorkerConfig({ ...base, WORKER_CONCURRENCY: '3' }).pgPoolMax).toBe(5);
  });

  it.each([
    ['DATABASE_URL missing', { REDIS_URL: base.REDIS_URL }, 'DATABASE_URL'],
    ['REDIS_URL missing', { DATABASE_URL: base.DATABASE_URL }, 'REDIS_URL'],
    ['concurrency 0', { ...base, WORKER_CONCURRENCY: '0' }, 'WORKER_CONCURRENCY'],
    ['concurrency not a number', { ...base, WORKER_CONCURRENCY: 'many' }, 'WORKER_CONCURRENCY'],
    ['concurrency too high', { ...base, WORKER_CONCURRENCY: '500' }, 'WORKER_CONCURRENCY'],
    ['bad log level', { ...base, LOG_LEVEL: 'loud' }, 'LOG_LEVEL'],
  ])('throws on %s, naming the variable', (_label, env, variable) => {
    expect(() => loadWorkerConfig(env)).toThrow(variable);
  });

  it('never echoes connection strings in errors', () => {
    let message = '';
    try {
      loadWorkerConfig({ ...base, WORKER_CONCURRENCY: 'x' });
    } catch (err) {
      message = err instanceof Error ? err.message : '';
    }
    expect(message).not.toContain('s3cret');
  });
});
