import { describe, expect, it } from 'vitest';
import {
  USAGE_EVENTS_CHANNEL,
  UsageRecordedEventSchema,
  parseUsageEvent,
  toUsageRecordedEvent,
  type UsageRecord,
} from './index.js';

const record: UsageRecord = {
  recordId: '0b7e4c7e-6f7a-4d3e-9a51-3f2c1b8d9e10',
  customerId: 'cust_42',
  dimension: 'api_calls',
  quantity: 2.5,
  timestamp: '2026-01-01T11:59:00.000Z',
};
const recordedAt = new Date('2026-01-01T12:00:00.000Z');
const event = toUsageRecordedEvent(record, recordedAt);

describe('usage.recorded event', () => {
  it('uses the agreed channel name', () => {
    expect(USAGE_EVENTS_CHANNEL).toBe('usage.recorded');
  });

  it('maps a record to a v1 event (timestamp -> occurredAt)', () => {
    expect(event).toEqual({
      version: 1,
      type: 'usage.recorded',
      recordId: record.recordId,
      customerId: 'cust_42',
      dimension: 'api_calls',
      quantity: 2.5,
      occurredAt: '2026-01-01T11:59:00.000Z',
      recordedAt: '2026-01-01T12:00:00.000Z',
    });
    expect(UsageRecordedEventSchema.safeParse(event).success).toBe(true);
  });

  it('round-trips through JSON', () => {
    expect(parseUsageEvent(JSON.stringify(event))).toEqual({ ok: true, event });
  });

  it.each([
    ['extra field', { ...event, extra: 1 }],
    ['wrong version', { ...event, version: 2 }],
    ['wrong type', { ...event, type: 'usage.deleted' }],
    ['non-uuid recordId', { ...event, recordId: 'abc' }],
    ['string quantity', { ...event, quantity: '2.5' }],
    ['missing recordedAt', { ...event, recordedAt: undefined }],
  ])('rejects an event with %s', (_label, bad) => {
    const result = parseUsageEvent(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it.each(['', 'not json', '{', 'null', '42', '[]'])(
    'returns a failure (never throws) for %j',
    (raw) => {
      expect(() => parseUsageEvent(raw)).not.toThrow();
      expect(parseUsageEvent(raw).ok).toBe(false);
    },
  );

  it('names the offending fields without echoing values', () => {
    const result = parseUsageEvent(JSON.stringify({ ...event, recordId: 'secret-ish' }));
    expect(result).toEqual({ ok: false, reason: 'invalid event: recordId' });
  });
});
