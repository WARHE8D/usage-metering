import type { UsageRecord, UsageRecordedEvent } from '@usage-metering/shared';
import { describe, expect, it } from 'vitest';
import { PermanentError } from './classify-error.js';
import type { InsertOutcome, Log } from './ports.js';
import { createUsageJobProcessor } from './process-usage-job.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');

const record: UsageRecord = {
  recordId: '0b7e4c7e-6f7a-4d3e-9a51-3f2c1b8d9e10',
  customerId: 'cust_42',
  dimension: 'api_calls',
  quantity: 3,
  timestamp: '2026-01-01T11:59:00.000Z',
};

interface LogLine {
  level: 'info' | 'warn' | 'error';
  obj: object;
  msg: string;
}

function harness(opts: { insert?: () => Promise<InsertOutcome>; publishFails?: boolean } = {}) {
  const inserted: UsageRecord[] = [];
  const published: UsageRecordedEvent[] = [];
  const logs: LogLine[] = [];
  const log: Log = {
    info: (obj, msg) => logs.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => logs.push({ level: 'error', obj, msg }),
  };
  const process = createUsageJobProcessor({
    repo: {
      insertIfAbsent: (r) => {
        inserted.push(r);
        return opts.insert ? opts.insert() : Promise.resolve('inserted');
      },
    },
    publisher: {
      publish: (e) => {
        published.push(e);
        return opts.publishFails ? Promise.reject(new Error('redis down')) : Promise.resolve();
      },
    },
    clock: () => NOW,
    log,
  });
  return { process, inserted, published, logs };
}

const codeError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe('createUsageJobProcessor', () => {
  it('inserts a new record and publishes exactly one usage.recorded event', async () => {
    const h = harness();
    await expect(h.process(record)).resolves.toEqual({
      status: 'inserted',
      recordId: record.recordId,
      published: true,
    });
    expect(h.inserted).toEqual([record]);
    expect(h.published).toEqual([
      {
        version: 1,
        type: 'usage.recorded',
        recordId: record.recordId,
        customerId: 'cust_42',
        dimension: 'api_calls',
        quantity: 3,
        occurredAt: record.timestamp,
        recordedAt: NOW.toISOString(),
      },
    ]);
  });

  it('treats an existing record as a successful duplicate with no event', async () => {
    const h = harness({ insert: () => Promise.resolve('duplicate') });
    await expect(h.process(record)).resolves.toEqual({
      status: 'duplicate',
      recordId: record.recordId,
    });
    expect(h.published).toHaveLength(0);
    expect(h.logs).toContainEqual(expect.objectContaining({ level: 'info' }));
  });

  it('rethrows transient database errors unchanged so the queue retries', async () => {
    const err = codeError('57P01');
    const h = harness({ insert: () => Promise.reject(err) });
    await expect(h.process(record)).rejects.toBe(err);
    expect(h.published).toHaveLength(0);
  });

  it('rethrows unknown errors as transient', async () => {
    const err = new Error('Connection terminated unexpectedly');
    const h = harness({ insert: () => Promise.reject(err) });
    await expect(h.process(record)).rejects.toBe(err);
  });

  it('turns permanent database errors into PermanentError (keeping the cause)', async () => {
    const err = codeError('22003');
    const h = harness({ insert: () => Promise.reject(err) });
    const failure = await h.process(record).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PermanentError);
    expect((failure as PermanentError).cause).toBe(err);
    expect(h.published).toHaveLength(0);
  });

  it.each([
    ['missing field', { ...record, quantity: undefined }],
    ['extra field', { ...record, extra: true }],
    ['bad uuid', { ...record, recordId: 'abc' }],
    ['zero quantity', { ...record, quantity: 0 }],
    ['non-UTC timestamp', { ...record, timestamp: '2026-01-01T11:59:00+02:00' }],
    ['null', null],
    ['string', 'garbage'],
  ])(
    'rejects invalid job data (%s) as PermanentError without touching the DB',
    async (_l, data) => {
      const h = harness();
      await expect(h.process(data)).rejects.toBeInstanceOf(PermanentError);
      expect(h.inserted).toHaveLength(0);
      expect(h.published).toHaveLength(0);
    },
  );

  it('names invalid fields without echoing their values', async () => {
    const h = harness();
    await expect(h.process({ ...record, customerId: '' })).rejects.toThrow(
      'invalid job data: customerId',
    );
  });

  it.each([
    ['days in the past', '2020-01-01T00:00:00.000Z'],
    ['far in the future', '2099-01-01T00:00:00.000Z'],
  ])('accepts a timestamp %s (no ingest-time future rule in the worker)', async (_l, ts) => {
    const h = harness();
    await expect(h.process({ ...record, timestamp: ts })).resolves.toMatchObject({
      status: 'inserted',
    });
  });

  it('succeeds and logs a lost event when publishing fails after the insert', async () => {
    const h = harness({ publishFails: true });
    await expect(h.process(record)).resolves.toEqual({
      status: 'inserted',
      recordId: record.recordId,
      published: false,
    });
    expect(h.inserted).toHaveLength(1);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'error',
        obj: expect.objectContaining({
          event: 'event_publish_failed',
          recordId: record.recordId,
        }) as object,
      }),
    );
  });
});
