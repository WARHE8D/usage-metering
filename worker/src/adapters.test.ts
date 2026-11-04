import type { UsageRecord } from '@usage-metering/shared';
import { describe, expect, it } from 'vitest';
import {
  INSERT_USAGE_RECORD_SQL,
  createPgUsageRepository,
  type Queryable,
} from './pg-repository.js';
import { createRedisEventPublisher } from './redis-publisher.js';

const record: UsageRecord = {
  recordId: '0b7e4c7e-6f7a-4d3e-9a51-3f2c1b8d9e10',
  customerId: "cust'; DROP TABLE usage_records; --",
  dimension: 'api_calls',
  quantity: 0.1,
  timestamp: '2026-01-01T11:59:00.000Z',
};

function fakeDb(rows: unknown[]): Queryable & { calls: { text: string; values: unknown[] }[] } {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text, values) {
      calls.push({ text, values });
      return Promise.resolve({ rows });
    },
  };
}

describe('createPgUsageRepository', () => {
  it('uses one parameterized idempotent INSERT with values in column order', async () => {
    const db = fakeDb([{ record_id: record.recordId }]);
    await createPgUsageRepository(db).insertIfAbsent(record);

    expect(db.calls).toHaveLength(1);
    const call = db.calls[0];
    expect(call?.text).toBe(INSERT_USAGE_RECORD_SQL);
    expect(call?.values).toEqual([
      record.recordId,
      record.customerId,
      'api_calls',
      '0.1',
      record.timestamp,
    ]);
  });

  it('never interpolates values into the SQL text', async () => {
    const db = fakeDb([]);
    await createPgUsageRepository(db).insertIfAbsent(record);
    const text = db.calls[0]?.text ?? '';
    expect(text).not.toContain(record.customerId);
    expect(text).not.toContain(record.recordId);
    expect(text).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5\)/);
    expect(text).toContain('ON CONFLICT (record_id) DO NOTHING');
    expect(text).toContain('RETURNING record_id');
  });

  it('maps timestamp to occurred_at', () => {
    expect(INSERT_USAGE_RECORD_SQL).toMatch(
      /\(record_id, customer_id, dimension, quantity, occurred_at\)/,
    );
  });

  it('reports inserted when a row is returned', async () => {
    await expect(
      createPgUsageRepository(fakeDb([{ record_id: record.recordId }])).insertIfAbsent(record),
    ).resolves.toBe('inserted');
  });

  it('reports duplicate when no row is returned', async () => {
    await expect(createPgUsageRepository(fakeDb([])).insertIfAbsent(record)).resolves.toBe(
      'duplicate',
    );
  });

  it('propagates database errors for the processor to classify', async () => {
    const boom = Object.assign(new Error('admin shutdown'), { code: '57P01' });
    const db: Queryable = { query: () => Promise.reject(boom) };
    await expect(createPgUsageRepository(db).insertIfAbsent(record)).rejects.toBe(boom);
  });
});

describe('createRedisEventPublisher', () => {
  it('publishes the event as JSON on the configured channel', async () => {
    const calls: [string, string][] = [];
    const publisher = createRedisEventPublisher(
      {
        publish: (channel, message) => {
          calls.push([channel, message]);
          return Promise.resolve(1);
        },
      },
      'test.channel',
    );
    const event = {
      version: 1 as const,
      type: 'usage.recorded' as const,
      recordId: record.recordId,
      customerId: 'cust_42',
      dimension: 'api_calls',
      quantity: 1,
      occurredAt: record.timestamp,
      recordedAt: record.timestamp,
    };
    await publisher.publish(event);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('test.channel');
    expect(JSON.parse(calls[0]?.[1] ?? '')).toEqual(event);
  });

  it('propagates publish failures', async () => {
    const publisher = createRedisEventPublisher(
      { publish: () => Promise.reject(new Error('down')) },
      'c',
    );
    await expect(
      publisher.publish({
        version: 1,
        type: 'usage.recorded',
        recordId: record.recordId,
        customerId: 'c',
        dimension: 'd',
        quantity: 1,
        occurredAt: record.timestamp,
        recordedAt: record.timestamp,
      }),
    ).rejects.toThrow('down');
  });
});
