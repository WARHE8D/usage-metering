import { describe, expect, it } from 'vitest';
import { UsageRecordsResponseSchema } from './usage-records-response.js';

const record = {
  recordId: '0b7e4c7e-6f7a-4d3e-9a51-3f2c1b8d9e10',
  customerId: 'cust_42',
  dimension: 'api_calls',
  quantity: 1.5,
  timestamp: '2026-01-01T11:59:00.000Z',
};

describe('UsageRecordsResponseSchema', () => {
  it('accepts empty and populated lists', () => {
    expect(UsageRecordsResponseSchema.safeParse({ records: [] }).success).toBe(true);
    expect(UsageRecordsResponseSchema.safeParse({ records: [record] }).success).toBe(true);
  });

  it('rejects a missing records field or a malformed record', () => {
    expect(UsageRecordsResponseSchema.safeParse({}).success).toBe(false);
    expect(
      UsageRecordsResponseSchema.safeParse({ records: [{ ...record, quantity: '1' }] }).success,
    ).toBe(false);
    expect(
      UsageRecordsResponseSchema.safeParse({ records: [{ ...record, extra: 1 }] }).success,
    ).toBe(false);
  });
});
