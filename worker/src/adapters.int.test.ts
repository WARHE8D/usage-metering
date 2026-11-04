import { randomUUID } from 'node:crypto';
import { toUsageRecordedEvent, type UsageRecord } from '@usage-metering/shared';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BULLMQ_REDIS_OPTIONS,
  PUBLISHER_REDIS_OPTIONS,
  connectRedis,
  createPgPool,
} from './connections.js';
import { createPgUsageRepository } from './pg-repository.js';
import type { Log } from './ports.js';
import { createRedisEventPublisher } from './redis-publisher.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const silent: Log = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Every row this run inserts uses this customerId; cleanup deletes only these. */
const CUSTOMER_ID = `it-${randomUUID()}`;

const newRecord = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  recordId: randomUUID(),
  customerId: CUSTOMER_ID,
  dimension: 'api_calls',
  quantity: 0.1,
  timestamp: '2026-01-01T11:59:00.000Z',
  ...overrides,
});

describe('pg repository against Postgres', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = createPgPool(DATABASE_URL, 10, silent);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM usage_records WHERE customer_id = $1', [CUSTOMER_ID]);
    await pool.end();
  });

  it('inserts once, then reports duplicate, storing values exactly', async () => {
    const repo = createPgUsageRepository(pool);
    const record = newRecord({ quantity: 0.1 });

    await expect(repo.insertIfAbsent(record)).resolves.toBe('inserted');
    await expect(repo.insertIfAbsent(record)).resolves.toBe('duplicate');

    const { rows } = await pool.query<{
      customer_id: string;
      dimension: string;
      quantity: string;
      occurred_at: Date;
    }>(
      'SELECT customer_id, dimension, quantity, occurred_at FROM usage_records WHERE record_id = $1',
      [record.recordId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.customer_id).toBe(CUSTOMER_ID);
    expect(rows[0]?.quantity).toBe('0.1'); // numeric comes back as an exact string
    expect(rows[0]?.occurred_at.toISOString()).toBe(record.timestamp);
  });

  it('stores large and fractional quantities without float drift', async () => {
    const repo = createPgUsageRepository(pool);
    const big = newRecord({ quantity: 123456789.123 });
    await repo.insertIfAbsent(big);
    const { rows } = await pool.query<{ quantity: string }>(
      'SELECT quantity FROM usage_records WHERE record_id = $1',
      [big.recordId],
    );
    expect(rows[0]?.quantity).toBe('123456789.123');
  });

  it('lets exactly one of many concurrent inserts of the same record win', async () => {
    const repo = createPgUsageRepository(pool);
    const record = newRecord();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => repo.insertIfAbsent(record)),
    );
    expect(outcomes.filter((o) => o === 'inserted')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(7);
  });
});

describe('redis publisher against Redis', () => {
  const channel = `usage.recorded.test-${randomUUID()}`;
  let publisherConn: Redis;
  let subscriberConn: Redis;

  beforeAll(async () => {
    publisherConn = await connectRedis(REDIS_URL, PUBLISHER_REDIS_OPTIONS, silent, 'publisher');
    subscriberConn = await connectRedis(REDIS_URL, BULLMQ_REDIS_OPTIONS, silent, 'subscriber');
    await subscriberConn.subscribe(channel);
  });

  afterAll(async () => {
    await subscriberConn.quit();
    await publisherConn.quit();
  });

  it('delivers the event JSON to a subscriber on the channel', async () => {
    const received = new Promise<string>((resolve) => {
      subscriberConn.once('message', (_channel: string, message: string) => {
        resolve(message);
      });
    });
    const event = toUsageRecordedEvent(newRecord(), new Date('2026-01-01T12:00:00.000Z'));
    await createRedisEventPublisher(publisherConn, channel).publish(event);
    expect(JSON.parse(await received)).toEqual(event);
  });

  it('rejects startup when Redis is unreachable', async () => {
    await expect(
      connectRedis('redis://127.0.0.1:6399', PUBLISHER_REDIS_OPTIONS, silent, 'x'),
    ).rejects.toThrow();
  });
});
