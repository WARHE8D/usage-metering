import { randomUUID } from 'node:crypto';
import type { UsageRecord } from '@usage-metering/shared';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiKeyChecker } from '../../api/src/auth.js';
import { createHealthCheck } from '../../api/src/health.js';
import { createIngestUsage } from '../../api/src/ingest.js';
import { createPgUsageReadRepository } from '../../api/src/pg-read-repository.js';
import { connectRedis as connectProducerRedis, createBullUsageQueue } from '../../api/src/queue.js';
import { buildServer } from '../../api/src/server.js';
import { createListUsageRecords } from '../../api/src/usage-query.js';
import {
  BULLMQ_REDIS_OPTIONS,
  PUBLISHER_REDIS_OPTIONS,
  connectRedis,
  createPgPool,
  type RedisConnectionOptions,
} from '../../worker/src/connections.js';
import { createPgUsageRepository } from '../../worker/src/pg-repository.js';
import type { Log } from '../../worker/src/ports.js';
import { createUsageJobProcessor } from '../../worker/src/process-usage-job.js';
import { createRedisEventPublisher } from '../../worker/src/redis-publisher.js';
import { startUsageWorker, type UsageWorkerHandle } from '../../worker/src/worker.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const API_KEY = 'e2e-test-key-0123456789';
const silent: Log = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Unique per run, so cleanup only ever touches this run's rows. */
const CUSTOMER_ID = `e2e-${randomUUID()}`;

const GRACE_MS = 300;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Stack {
  app: FastifyInstance;
  queue: Queue<UsageRecord>;
  worker: UsageWorkerHandle;
  events: unknown[];
  dlqName: string;
  redis: Redis[];
}

let pool: pg.Pool;
let stack: Stack | undefined;

/** Real API + real BullMQ queue + real worker + real pg/redis adapters, all on throwaway names. */
async function buildStack(): Promise<Stack> {
  const suffix = randomUUID();
  const queueName = `usage-e2e-${suffix}`;
  const dlqName = `usage-dlq-e2e-${suffix}`;
  const channel = `usage.recorded.e2e-${suffix}`;
  const redis: Redis[] = [];
  const connect = async (options: RedisConnectionOptions, name: string) => {
    const c = await connectRedis(REDIS_URL, options, silent, name);
    redis.push(c);
    return c;
  };

  const events: unknown[] = [];
  const subscriber = await connect(BULLMQ_REDIS_OPTIONS, 'e2e-subscriber');
  await subscriber.subscribe(channel);
  subscriber.on('message', (_c: string, message: string) => events.push(JSON.parse(message)));

  const worker = startUsageWorker({
    queueName,
    dlqName,
    connection: await connect(BULLMQ_REDIS_OPTIONS, 'e2e-worker'),
    dlqConnection: await connect(BULLMQ_REDIS_OPTIONS, 'e2e-dlq'),
    processor: createUsageJobProcessor({
      repo: createPgUsageRepository(pool),
      publisher: createRedisEventPublisher(
        await connect(PUBLISHER_REDIS_OPTIONS, 'e2e-publisher'),
        channel,
      ),
      clock: () => new Date(),
      log: silent,
    }),
    concurrency: 5,
    clock: () => new Date(),
    log: silent,
  });

  const producerConnection = await connectProducerRedis(REDIS_URL);
  redis.push(producerConnection);
  const { queue, usageQueue } = createBullUsageQueue(producerConnection, queueName);
  const app = buildServer({
    ingest: createIngestUsage({ queue: usageQueue }),
    listUsageRecords: createListUsageRecords({ repo: createPgUsageReadRepository(pool) }),
    checkApiKey: createApiKeyChecker(API_KEY),
    health: createHealthCheck({
      ping: () => producerConnection.ping(),
      pingDb: () => pool.query('SELECT 1'),
      timeoutMs: 1000,
    }),
    config: { bodyLimitBytes: 16_384, corsOrigins: [] },
  });
  await app.ready();
  return { app, queue, worker, events, dlqName, redis };
}

async function teardown(s: Stack): Promise<void> {
  await s.app.close();
  await s.worker.close(5000);
  await s.queue.obliterate({ force: true });
  await s.queue.close();
  // The worker handle closes its DLQ queue; obliterate it through a fresh handle.
  const cleanup = await connectRedis(REDIS_URL, BULLMQ_REDIS_OPTIONS, silent, 'e2e-cleanup');
  s.redis.push(cleanup);
  const dlq = new Queue(s.dlqName, { connection: cleanup });
  await dlq.obliterate({ force: true });
  await dlq.close();
  await Promise.allSettled(s.redis.map((c) => c.quit()));
}

const newRecord = (): UsageRecord => ({
  recordId: randomUUID(),
  customerId: CUSTOMER_ID,
  dimension: 'api_calls',
  quantity: 3,
  timestamp: new Date().toISOString(),
});

const post = (s: Stack, record: UsageRecord) =>
  s.app.inject({
    method: 'POST',
    url: '/usage',
    headers: { 'x-api-key': API_KEY },
    payload: record,
  });

const rowCount = async (recordId: string): Promise<number> =>
  (await pool.query('SELECT 1 FROM usage_records WHERE record_id = $1', [recordId])).rowCount ?? 0;

const waitForCompleted = (s: Stack, recordId: string) =>
  vi.waitFor(
    async () => {
      const job = await s.queue.getJob(recordId);
      expect(await job?.getState()).toBe('completed');
    },
    { timeout: 10_000 },
  );

beforeAll(() => {
  pool = createPgPool(DATABASE_URL, 5, silent);
});

beforeEach(async () => {
  stack = await buildStack();
});

afterEach(async () => {
  if (stack) await teardown(stack);
  stack = undefined;
});

afterAll(async () => {
  await pool.query('DELETE FROM usage_records WHERE customer_id = $1', [CUSTOMER_ID]);
  await pool.end();
});

describe('usage pipeline end to end (API -> queue -> worker -> Postgres -> event)', () => {
  it('stores one row and publishes one event when the same record is POSTed twice', async () => {
    const s = stack!;
    const record = newRecord();

    const first = await post(s, record);
    const second = await post(s, record);
    expect([first.statusCode, second.statusCode]).toEqual([202, 202]);

    await vi.waitFor(async () => {
      expect(await rowCount(record.recordId)).toBe(1);
    });
    await waitForCompleted(s, record.recordId);
    await vi.waitFor(() => {
      expect(s.events).toHaveLength(1);
    });

    // Let a stray second event arrive before asserting there is none.
    await sleep(GRACE_MS);
    expect(await rowCount(record.recordId)).toBe(1);
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({
      type: 'usage.recorded',
      recordId: record.recordId,
      customerId: CUSTOMER_ID,
      quantity: 3,
      occurredAt: record.timestamp,
    });
  });

  it('lets Postgres absorb a re-POST after the completed job has been removed', async () => {
    const s = stack!;
    const record = newRecord();

    expect((await post(s, record)).statusCode).toBe(202);
    await waitForCompleted(s, record.recordId);
    await vi.waitFor(() => {
      expect(s.events).toHaveLength(1);
    });

    // Simulate removeOnComplete retention having expired, so BullMQ no longer dedupes by jobId.
    const completed = await s.queue.getJob(record.recordId);
    await completed?.remove();
    expect(await s.queue.getJob(record.recordId)).toBeUndefined();

    expect((await post(s, record)).statusCode).toBe(202);
    // A brand new job must be created and processed (the old one was removed).
    await waitForCompleted(s, record.recordId);

    await sleep(GRACE_MS);
    expect(await rowCount(record.recordId)).toBe(1);
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ recordId: record.recordId, customerId: CUSTOMER_ID });
  });
});
