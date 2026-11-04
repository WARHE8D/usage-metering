import { usageJobOptions, type UsageJobOptions, type UsageRecord } from '@usage-metering/shared';
import { describe, expect, it } from 'vitest';
import { createIngestUsage, type UsageQueue } from './ingest.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const now = () => NOW;

const validRecord = {
  recordId: '0b7e4c7e-6f7a-4d3e-9a51-3f2c1b8d9e10',
  customerId: 'cust_42',
  dimension: 'api_calls',
  quantity: 3,
  timestamp: '2026-01-01T11:59:00.000Z',
};

interface AddCall {
  name: string;
  data: UsageRecord;
  opts: UsageJobOptions;
}

function fakeQueue(failWith?: Error): UsageQueue & { calls: AddCall[] } {
  const calls: AddCall[] = [];
  return {
    calls,
    add(name, data, opts) {
      calls.push({ name, data, opts });
      return failWith ? Promise.reject(failWith) : Promise.resolve({ id: opts.jobId });
    },
  };
}

describe('createIngestUsage', () => {
  it('enqueues a valid record once with the job name, data and shared options', async () => {
    const queue = fakeQueue();
    const result = await createIngestUsage({ queue, now })(validRecord);

    expect(result).toEqual({ status: 'accepted', recordId: validRecord.recordId });
    expect(queue.calls).toEqual([
      {
        name: 'usage.record',
        data: validRecord,
        opts: usageJobOptions(validRecord.recordId),
      },
    ]);
    expect(queue.calls[0]?.opts.jobId).toBe(validRecord.recordId);
  });

  it('returns validation errors and does not enqueue an invalid record', async () => {
    const queue = fakeQueue();
    const result = await createIngestUsage({ queue, now })({ ...validRecord, quantity: -1 });

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors.map((e) => e.path)).toEqual(['quantity']);
    }
    expect(queue.calls).toHaveLength(0);
  });

  it('rejects unknown fields (strict schema)', async () => {
    const queue = fakeQueue();
    const result = await createIngestUsage({ queue, now })({ ...validRecord, extra: true });
    expect(result.status).toBe('invalid');
    expect(queue.calls).toHaveLength(0);
  });

  it.each([null, undefined, 'text', 42, []])('rejects non-object input %j', async (input) => {
    const queue = fakeQueue();
    const result = await createIngestUsage({ queue, now })(input);
    expect(result.status).toBe('invalid');
    expect(queue.calls).toHaveLength(0);
  });

  it('uses the injected clock for the future-timestamp rule', async () => {
    const queue = fakeQueue();
    const ingest = createIngestUsage({ queue, now });
    const tooFar = await ingest({ ...validRecord, timestamp: '2026-01-01T12:05:00.001Z' });
    const atLimit = await ingest({ ...validRecord, timestamp: '2026-01-01T12:05:00.000Z' });
    expect(tooFar.status).toBe('invalid');
    expect(atLimit.status).toBe('accepted');
  });

  it('reports unavailable (with the cause) when the queue rejects', async () => {
    const boom = new Error("Stream isn't writeable and enableOfflineQueue options is false");
    const queue = fakeQueue(boom);
    const result = await createIngestUsage({ queue, now })(validRecord);
    expect(result).toEqual({ status: 'unavailable', cause: boom });
  });

  it('is stateless: the same record twice is enqueued twice with the same jobId', async () => {
    const queue = fakeQueue();
    const ingest = createIngestUsage({ queue, now });
    await ingest(validRecord);
    await ingest(validRecord);
    expect(queue.calls.map((c) => c.opts.jobId)).toEqual([
      validRecord.recordId,
      validRecord.recordId,
    ]);
  });
});
