import { randomUUID } from 'node:crypto';
import type { UsageRecord } from '@usage-metering/shared';
import type { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { createApiKeyChecker } from './auth.js';
import { createHealthCheck } from './health.js';
import { createIngestUsage } from './ingest.js';
import { connectRedis, createBullUsageQueue } from './queue.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const API_KEY = 'integration-test-key-0123';

interface Stack {
  app: FastifyInstance;
  queue: Queue<UsageRecord>;
  connection: Redis;
}

/** Wires the real app to real Redis on a throwaway queue (never the live "usage" queue). */
async function buildStack(queueName: string): Promise<Stack> {
  const connection = await connectRedis(REDIS_URL);
  const { queue, usageQueue } = createBullUsageQueue(connection, queueName);
  const app = buildServer({
    ingest: createIngestUsage({ queue: usageQueue }),
    checkApiKey: createApiKeyChecker(API_KEY),
    health: createHealthCheck({ ping: () => connection.ping(), timeoutMs: 1000 }),
    config: { bodyLimitBytes: 16_384, corsOrigins: ['http://localhost:5173'] },
  });
  return { app, queue, connection };
}

function newRecord(): UsageRecord {
  return {
    recordId: randomUUID(),
    customerId: 'cust_int',
    dimension: 'api_calls',
    quantity: 7,
    timestamp: new Date().toISOString(),
  };
}

const post = (app: FastifyInstance, record: UsageRecord) =>
  app.inject({
    method: 'POST',
    url: '/usage',
    headers: { 'x-api-key': API_KEY },
    payload: record,
  });

describe('ingest against real Redis', () => {
  const queueName = `usage-test-${randomUUID()}`;
  let stack: Stack;

  beforeAll(async () => {
    stack = await buildStack(queueName);
  });

  afterAll(async () => {
    await stack.app.close();
    await stack.queue.obliterate({ force: true });
    await stack.queue.close();
    await stack.connection.quit();
  });

  it('enqueues a posted record with jobId = recordId and the shared job options', async () => {
    const record = newRecord();
    const res = await post(stack.app, record);
    expect(res.statusCode).toBe(202);

    const job = await stack.queue.getJob(record.recordId);
    expect(job?.id).toBe(record.recordId);
    expect(job?.name).toBe('usage.record');
    expect(job?.data).toEqual(record);
    expect(job?.opts).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { count: 1000, age: 86_400 },
      removeOnFail: false,
    });
  });

  it('dedupes a re-posted record into a single job while answering 202 twice', async () => {
    const record = newRecord();
    const before = await stack.queue.getJobCountByTypes('wait');
    const first = await post(stack.app, record);
    const second = await post(stack.app, record);
    expect([first.statusCode, second.statusCode]).toEqual([202, 202]);
    expect(await stack.queue.getJobCountByTypes('wait')).toBe(before + 1);
  });

  it('reports healthy against live Redis', async () => {
    const res = await stack.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', redis: 'up' });
  });
});

describe('ingest when Redis goes away', () => {
  it('fails fast with 503 (not a hang) and health turns 503', async () => {
    const queueName = `usage-test-${randomUUID()}`;
    const { app, queue, connection } = await buildStack(queueName);
    try {
      // Simulate an outage after a healthy start.
      connection.disconnect();

      const started = Date.now();
      const res = await post(app, newRecord());
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(Date.now() - started).toBeLessThan(5000);

      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(503);
    } finally {
      await app.close();
      await queue.close().catch(() => undefined);
    }
  });

  it('refuses to start when Redis is unreachable', async () => {
    await expect(connectRedis('redis://127.0.0.1:6399')).rejects.toThrow();
  });
});
