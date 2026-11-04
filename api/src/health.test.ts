import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHealthCheck } from './health.js';

const up = () => Promise.resolve('ok');
const failing = () => Promise.reject(new Error('ECONNREFUSED'));
const hanging = () => new Promise<never>(() => undefined);

describe('createHealthCheck', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports both up when both probes resolve', async () => {
    const check = createHealthCheck({ ping: up, pingDb: up, timeoutMs: 1000 });
    await expect(check()).resolves.toEqual({ ok: true, redis: 'up', postgres: 'up' });
  });

  it('reports redis down when ping rejects', async () => {
    const check = createHealthCheck({ ping: failing, pingDb: up, timeoutMs: 1000 });
    await expect(check()).resolves.toEqual({ ok: false, redis: 'down', postgres: 'up' });
  });

  it('reports postgres down when the db probe rejects', async () => {
    const check = createHealthCheck({ ping: up, pingDb: failing, timeoutMs: 1000 });
    await expect(check()).resolves.toEqual({ ok: false, redis: 'up', postgres: 'down' });
  });

  it('reports both down when both fail', async () => {
    const check = createHealthCheck({ ping: failing, pingDb: failing, timeoutMs: 1000 });
    await expect(check()).resolves.toEqual({ ok: false, redis: 'down', postgres: 'down' });
  });

  it('reports a probe down when it does not answer within the timeout', async () => {
    vi.useFakeTimers();
    const check = createHealthCheck({ ping: up, pingDb: hanging, timeoutMs: 1000 });
    const pending = check();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ ok: false, redis: 'up', postgres: 'down' });
  });

  it('clears its timers after fast answers', async () => {
    vi.useFakeTimers();
    const check = createHealthCheck({ ping: up, pingDb: up, timeoutMs: 1000 });
    await check();
    expect(vi.getTimerCount()).toBe(0);
  });
});
