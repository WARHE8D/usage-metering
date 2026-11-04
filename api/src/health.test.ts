import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHealthCheck } from './health.js';

describe('createHealthCheck', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports up when ping resolves', async () => {
    const check = createHealthCheck({ ping: () => Promise.resolve('PONG'), timeoutMs: 1000 });
    await expect(check()).resolves.toEqual({ ok: true, redis: 'up' });
  });

  it('reports down when ping rejects', async () => {
    const check = createHealthCheck({
      ping: () => Promise.reject(new Error('ECONNREFUSED')),
      timeoutMs: 1000,
    });
    await expect(check()).resolves.toEqual({ ok: false, redis: 'down' });
  });

  it('reports down when ping does not answer within the timeout', async () => {
    vi.useFakeTimers();
    const check = createHealthCheck({
      ping: () => new Promise<never>(() => undefined),
      timeoutMs: 1000,
    });
    const pending = check();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ ok: false, redis: 'down' });
  });

  it('clears its timer after a fast answer', async () => {
    vi.useFakeTimers();
    const check = createHealthCheck({ ping: () => Promise.resolve('PONG'), timeoutMs: 1000 });
    await check();
    expect(vi.getTimerCount()).toBe(0);
  });
});
