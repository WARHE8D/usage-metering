import { randomUUID } from 'node:crypto';
import { UsageDlqEntrySchema, type UsageRecord } from '@usage-metering/shared';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BULLMQ_REDIS_OPTIONS, connectRedis, createPgPool } from './connections.js';
import { buildDlqEntry, moveToDlq } from './dlq.js';
import { createPgUsageRepository } from './pg-repository.js';
import type { Log, UsageRepository } from './ports.js';
import { createUsageJobProcessor } from './process-usage-job.js';
import { createRedisEventPublisher } from './redis-publisher.js';
import { startUsageWorker, type UsageWorkerHandle } from './worker.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const silent: Log = { info: () => undefined, warn: () => undefined, error: () => undefined };
const CUSTOMER_ID = `it-${randomUUID()}`;
/** Fast retries so exhausting attempts takes milliseconds, not seconds. */
const FAST_RETRY = { attempts: 3, backoff: { type: 'fixed', delay: 50 } } as const;

const newRecord = (): UsageRecord => ({
  recordId: randomUUID(),
  customerId: CUSTOMER_ID,
  dimension: 'api_calls',
  quantity: 2,
  timestamp: new Date().toISOString(),
});

let pool: pg.Pool;
let conns: Redis[] = [];
const connect = async () => {
  const c = await connectRedis(REDIS_URL, BULLMQ_REDIS_OPTIONS, silent, 'test');
  conns.push(c);
  return c;
};

interface Stack {
  producer: Queue;
  handle: UsageWorkerHandle;
  events: unknown[];
  queueName: string;
}
let stacks: Stack[] = [];

/** A real worker on throwaway queue/DLQ/channel names, plus a producer and a subscriber. */
async function buildStack(repo?: UsageRepository): Promise<Stack> {
  const suffix = randomUUID();
  const queueName = `usage-test-${suffix}`;
  const channel = `usage.recorded.test-${suffix}`;
  const events: unknown[] = [];

  const subscriber = await connect();
  await subscriber.subscribe(channel);
  subscriber.on('message', (_c: string, message: string) => events.push(JSON.parse(message)));

  const publisherConn = await connect();
  const handle = startUsageWorker({
    queueName,
    dlqName: `usage-dlq-test-${suffix}`,
    connection: await connect(),
    dlqConnection: await connect(),
    processor: createUsageJobProcessor({
      repo: repo ?? createPgUsageRepository(pool),
      publisher: createRedisEventPublisher(publisherConn, channel),
      clock: () => new Date(),
      log: silent,
    }),
    concurrency: 5,
    clock: () => new Date(),
    log: silent,
  });
  const producer = new Queue(queueName, { connection: await connect() });
  const stack = { producer, handle, events, queueName };
  stacks.push(stack);
  return stack;
}

const rowCount = async (recordId: string) =>
  (await pool.query('SELECT 1 FROM usage_records WHERE record_id = $1', [recordId])).rowCount;

beforeAll(() => {
  pool = createPgPool(DATABASE_URL, 10, silent);
});

afterEach(async () => {
  for (const s of stacks) {
    await s.handle.close(5000);
    await s.producer.obliterate({ force: true });
    await s.producer.close();
    // The DLQ queue is closed by handle.close(); obliterate it through a fresh handle.
    const dlq = new Queue(s.handle.dlq.name, { connection: await connect() });
    await dlq.obliterate({ force: true });
    await dlq.close();
  }
  stacks = [];
  await Promise.allSettled(conns.map((c) => c.quit()));
  conns = [];
});

afterAll(async () => {
  await pool.query('DELETE FROM usage_records WHERE customer_id = $1', [CUSTOMER_ID]);
  await pool.end();
});

describe('usage worker against Postgres and Redis', () => {
  it('stores a queued record and publishes one usage.recorded event', async () => {
    const { producer, events } = await buildStack();
    const record = newRecord();
    await producer.add('usage.record', record, { jobId: record.recordId });

    await vi.waitFor(
      async () => {
        expect(await rowCount(record.recordId)).toBe(1);
      },
      {
        timeout: 10_000,
      },
    );
    await vi.waitFor(
      () => {
        expect(events).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    expect(events[0]).toMatchObject({
      version: 1,
      type: 'usage.recorded',
      recordId: record.recordId,
      customerId: CUSTOMER_ID,
      quantity: 2,
      occurredAt: record.timestamp,
    });
  });

  it('processes a duplicate record as success with one row and one event', async () => {
    const { producer, events } = await buildStack();
    const record = newRecord();
    // Different jobIds bypass BullMQ's own dedupe, so Postgres has to catch it.
    const [a, b] = await Promise.all([
      producer.add('usage.record', record, { jobId: `a-${record.recordId}` }),
      producer.add('usage.record', record, { jobId: `b-${record.recordId}` }),
    ]);

    await vi.waitFor(
      async () => {
        expect(await a.getState()).toBe('completed');
        expect(await b.getState()).toBe('completed');
      },
      { timeout: 10_000 },
    );
    expect(await rowCount(record.recordId)).toBe(1);
    // Give a stray second event time to arrive before asserting there is none.
    await new Promise((r) => setTimeout(r, 200));
    expect(events).toHaveLength(1);
  });

  it('retries a transient failure, then moves the job to the DLQ', async () => {
    let calls = 0;
    const { producer, handle } = await buildStack({
      insertIfAbsent: () => {
        calls += 1;
        return Promise.reject(Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }));
      },
    });
    const record = newRecord();
    await producer.add('usage.record', record, { jobId: record.recordId, ...FAST_RETRY });

    const dlqJob = await vi.waitFor(
      async () => {
        const job = await handle.dlq.getJob(record.recordId);
        expect(job).toBeDefined();
        return job;
      },
      { timeout: 10_000 },
    );
    expect(calls).toBe(3);
    const entry = UsageDlqEntrySchema.parse(dlqJob?.data);
    expect(entry).toMatchObject({
      record,
      failedReason: 'db down',
      attemptsMade: 3,
      originalJobId: record.recordId,
      queue: producer.name,
    });
    // The original job is kept in "failed" for inspection.
    expect(await (await producer.getJob(record.recordId))?.getState()).toBe('failed');
  });

  it('dead-letters invalid job data immediately, without retries', async () => {
    let calls = 0;
    const { producer, handle } = await buildStack({
      insertIfAbsent: () => {
        calls += 1;
        return Promise.resolve('inserted');
      },
    });
    const bad = { ...newRecord(), quantity: -1 };
    await producer.add('usage.record', bad, { jobId: bad.recordId, ...FAST_RETRY });

    const dlqJob = await vi.waitFor(
      async () => {
        const job = await handle.dlq.getJob(bad.recordId);
        expect(job).toBeDefined();
        return job;
      },
      { timeout: 10_000 },
    );
    expect(dlqJob?.data.attemptsMade).toBe(1);
    expect(dlqJob?.data.failedReason).toBe('invalid job data: quantity');
    expect(calls).toBe(0);
  });

  it('dead-letters a permanent database error immediately', async () => {
    const { producer, handle } = await buildStack({
      insertIfAbsent: () =>
        Promise.reject(Object.assign(new Error('numeric field overflow'), { code: '22003' })),
    });
    const record = newRecord();
    await producer.add('usage.record', record, { jobId: record.recordId, ...FAST_RETRY });

    await vi.waitFor(
      async () => {
        const job = await handle.dlq.getJob(record.recordId);
        expect(job?.data.attemptsMade).toBe(1);
      },
      { timeout: 10_000 },
    );
  });

  it('makes repeated DLQ moves of the same record idempotent', async () => {
    const { handle } = await buildStack();
    const record = newRecord();
    const entry = buildDlqEntry({
      data: record,
      failedReason: 'x',
      attemptsMade: 5,
      originalJobId: record.recordId,
      queue: 'usage',
      failedAt: new Date(),
    });
    await moveToDlq(handle.dlq, entry, record.recordId);
    await moveToDlq(handle.dlq, entry, record.recordId);
    expect(await handle.dlq.getJobCountByTypes('wait')).toBe(1);
  });
});
