import type { UsageRecord } from '@usage-metering/shared';
import { describe, expect, it } from 'vitest';
import { createListUsageRecords, type UsageReadRepository } from './usage-query.js';

const record: UsageRecord = {
  recordId: '0b7e4c7e-6f7a-4d3e-9a51-3f2c1b8d9e10',
  customerId: 'cust_42',
  dimension: 'api_calls',
  quantity: 1.5,
  timestamp: '2026-01-01T11:59:00.000Z',
};

function setup(opts: { fails?: boolean; records?: UsageRecord[] } = {}) {
  const calls: { customerId: string; limit: number }[] = [];
  const repo: UsageReadRepository = {
    listByCustomer(customerId, limit) {
      calls.push({ customerId, limit });
      return opts.fails
        ? Promise.reject(new Error('pg down'))
        : Promise.resolve(opts.records ?? []);
    },
  };
  return { list: createListUsageRecords({ repo }), calls };
}

describe('createListUsageRecords validation', () => {
  it.each([
    ['missing customerId', {}, 'customerId'],
    ['empty customerId', { customerId: '' }, 'customerId'],
    ['65-char customerId', { customerId: 'c'.repeat(65) }, 'customerId'],
    ['array customerId', { customerId: ['a', 'b'] }, 'customerId'],
    ['limit 0', { customerId: 'c', limit: '0' }, 'limit'],
    ['limit 501', { customerId: 'c', limit: '501' }, 'limit'],
    ['negative limit', { customerId: 'c', limit: '-1' }, 'limit'],
    ['non-numeric limit', { customerId: 'c', limit: 'abc' }, 'limit'],
    ['fractional limit', { customerId: 'c', limit: '1.5' }, 'limit'],
    ['empty limit', { customerId: 'c', limit: '' }, 'limit'],
    ['unknown param', { customerId: 'c', custmerId: 'x' }, 'custmerId'],
  ])('rejects %s without calling the repo', async (_label, query, path) => {
    const { list, calls } = setup();
    const result = await list(query);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors.map((e) => e.path)).toContain(path);
      expect(result.errors.every((e) => e.message.length > 0)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects a non-object query', async () => {
    const { list } = setup();
    expect((await list(undefined)).status).toBe('invalid');
  });

  it('defaults limit to 100', async () => {
    const { list, calls } = setup();
    await list({ customerId: 'cust_42' });
    expect(calls).toEqual([{ customerId: 'cust_42', limit: 100 }]);
  });

  it.each([
    ['1', 1],
    ['25', 25],
    ['500', 500],
  ])('coerces limit %s to a number', async (raw, expected) => {
    const { list, calls } = setup();
    await list({ customerId: 'cust_42', limit: raw });
    expect(calls).toEqual([{ customerId: 'cust_42', limit: expected }]);
  });

  it('accepts a 64-char customerId', async () => {
    const { list } = setup();
    expect((await list({ customerId: 'c'.repeat(64) })).status).toBe('ok');
  });
});

describe('createListUsageRecords results', () => {
  it('passes repository records through', async () => {
    const { list } = setup({ records: [record] });
    await expect(list({ customerId: 'cust_42' })).resolves.toEqual({
      status: 'ok',
      records: [record],
    });
  });

  it('returns ok with an empty list when nothing matches', async () => {
    const { list } = setup();
    await expect(list({ customerId: 'nobody' })).resolves.toEqual({ status: 'ok', records: [] });
  });

  it('maps a repository failure to unavailable and keeps the cause', async () => {
    const { list } = setup({ fails: true });
    const result = await list({ customerId: 'cust_42' });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.cause).toBeInstanceOf(Error);
    }
  });
});
