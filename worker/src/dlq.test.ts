import type { DlqJobOptions, UsageDlqEntry } from '@usage-metering/shared';
import { UsageDlqEntrySchema } from '@usage-metering/shared';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { buildDlqEntry, dlqJobId, moveToDlq, shouldDeadLetter } from './dlq.js';

const RECORD_ID = '0b7e4c7e-6f7a-4d3e-9a51-3f2c1b8d9e10';

describe('shouldDeadLetter', () => {
  it.each([
    [1, 5, false],
    [4, 5, false],
    [5, 5, true],
    [6, 5, true],
    [1, 1, true],
  ])('attemptsMade %i of %i -> %s', (attemptsMade, maxAttempts, expected) => {
    expect(shouldDeadLetter({ attemptsMade, maxAttempts }, new Error('x'))).toBe(expected);
  });

  it('dead-letters an unrecoverable error on the first attempt', () => {
    expect(
      shouldDeadLetter({ attemptsMade: 1, maxAttempts: 5 }, new UnrecoverableError('bad')),
    ).toBe(true);
  });
});

describe('dlqJobId', () => {
  it('uses the recordId of valid data so repeated moves are idempotent', () => {
    expect(dlqJobId({ recordId: RECORD_ID }, 'job-1')).toBe(RECORD_ID);
  });

  it.each([
    ['no recordId', { foo: 1 }],
    ['non-uuid recordId', { recordId: '123' }],
    ['non-object', 'garbage'],
    ['null', null],
  ])('falls back to the original job id for %s', (_label, data) => {
    expect(dlqJobId(data, 'job-1')).toBe('dlq-job-1');
  });

  it('never produces ids with ":" or only digits', () => {
    const id = dlqJobId(null, 'repeat:abc:1');
    expect(id).toBe('dlq-repeat-abc-1');
    expect(dlqJobId(null, '42')).toBe('dlq-42');
  });

  it('generates an id when the original job id is missing', () => {
    expect(dlqJobId(null, undefined)).toMatch(/^dlq-[0-9a-f-]{36}$/);
  });
});

describe('buildDlqEntry', () => {
  it('builds an entry that matches the shared DLQ schema', () => {
    const entry = buildDlqEntry({
      data: { recordId: RECORD_ID },
      failedReason: 'db down',
      attemptsMade: 5,
      originalJobId: RECORD_ID,
      queue: 'usage',
      failedAt: new Date('2026-01-01T12:00:00.000Z'),
    });
    expect(entry).toEqual({
      record: { recordId: RECORD_ID },
      failedReason: 'db down',
      attemptsMade: 5,
      originalJobId: RECORD_ID,
      failedAt: '2026-01-01T12:00:00.000Z',
      queue: 'usage',
    });
    expect(UsageDlqEntrySchema.safeParse(entry).success).toBe(true);
  });
});

describe('moveToDlq', () => {
  it('adds the entry under the DLQ job name with keep-forever options', async () => {
    const calls: { name: string; data: UsageDlqEntry; opts: DlqJobOptions }[] = [];
    const entry = buildDlqEntry({
      data: null,
      failedReason: 'x',
      attemptsMade: 1,
      originalJobId: 'j',
      queue: 'usage',
      failedAt: new Date(),
    });
    await moveToDlq(
      {
        add: (name, data, opts) => {
          calls.push({ name, data, opts });
          return Promise.resolve();
        },
      },
      entry,
      'dlq-j',
    );
    expect(calls).toEqual([
      {
        name: 'usage.dead-letter',
        data: entry,
        opts: { jobId: 'dlq-j', attempts: 1, removeOnComplete: false, removeOnFail: false },
      },
    ]);
  });
});
