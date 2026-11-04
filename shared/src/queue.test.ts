import { describe, expect, it } from 'vitest';
import {
  USAGE_DLQ_NAME,
  USAGE_JOB_NAME,
  USAGE_QUEUE_NAME,
  UsageDlqEntrySchema,
  dlqJobOptions,
  usageJobOptions,
} from './index.js';

const RECORD_ID = '0b7e4c7e-6f7a-4d3e-9a51-3f2c1b8d9e10';

describe('usage queue contract', () => {
  it('uses the agreed queue and job names', () => {
    expect(USAGE_QUEUE_NAME).toBe('usage');
    expect(USAGE_DLQ_NAME).toBe('usage-dlq');
    expect(USAGE_JOB_NAME).toBe('usage.record');
  });

  it('builds job options with jobId = recordId, retries, backoff and retention', () => {
    expect(usageJobOptions(RECORD_ID)).toEqual({
      jobId: RECORD_ID,
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { count: 1000, age: 86_400 },
      removeOnFail: false,
    });
  });

  it('returns a fresh object each call so callers cannot mutate shared state', () => {
    const a = usageJobOptions(RECORD_ID);
    a.removeOnComplete.count = 1;
    expect(usageJobOptions(RECORD_ID).removeOnComplete.count).toBe(1000);
  });
});

describe('dead-letter queue contract', () => {
  const entry = {
    record: { anything: true },
    failedReason: 'boom',
    attemptsMade: 5,
    originalJobId: RECORD_ID,
    failedAt: '2026-01-01T12:00:00.000Z',
    queue: 'usage',
  };

  it('accepts a well-formed entry, including invalid original data', () => {
    expect(UsageDlqEntrySchema.safeParse(entry).success).toBe(true);
    expect(UsageDlqEntrySchema.safeParse({ ...entry, record: 'garbage' }).success).toBe(true);
  });

  it.each([
    ['negative attempts', { attemptsMade: -1 }],
    ['empty originalJobId', { originalJobId: '' }],
    ['bad failedAt', { failedAt: 'yesterday' }],
    ['extra field', { extra: 1 }],
  ])('rejects %s', (_label, patch) => {
    expect(UsageDlqEntrySchema.safeParse({ ...entry, ...patch }).success).toBe(false);
  });

  it('keeps DLQ jobs forever and does not retry them', () => {
    expect(dlqJobOptions(RECORD_ID)).toEqual({
      jobId: RECORD_ID,
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    });
  });
});
