import { StoredUsageRecordSchema } from '@usage-metering/shared';
import { describe, expect, it } from 'vitest';
import {
  LIST_USAGE_RECORDS_SQL,
  createPgUsageReadRepository,
  type Queryable,
} from './pg-read-repository.js';

function fakeDb(rows: unknown[]) {
  const calls: { text: string; values: unknown[] }[] = [];
  const db: Queryable = {
    query(text, values) {
      calls.push({ text, values });
      return Promise.resolve({ rows });
    },
  };
  return { db, calls };
}

describe('createPgUsageReadRepository', () => {
  it('uses parameterized SQL ordered newest first, with customer and limit as params', async () => {
    const { db, calls } = fakeDb([]);
    await createPgUsageReadRepository(db).listByCustomer("cust'; DROP TABLE x;--", 25);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.text).toBe(LIST_USAGE_RECORDS_SQL);
    expect(call?.text).toContain('customer_id = $1');
    expect(call?.text).toContain('ORDER BY occurred_at DESC, record_id DESC');
    expect(call?.text).toContain('LIMIT $2');
    expect(call?.text).not.toContain('DROP');
    expect(call?.values).toEqual(["cust'; DROP TABLE x;--", 25]);
  });

  it('maps rows: numeric string to number, Date to ISO UTC string', async () => {
    const { db } = fakeDb([
      {
        record_id: '0b7e4c7e-6f7a-4d3e-9a51-3f2c1b8d9e10',
        customer_id: 'cust_42',
        dimension: 'api_calls',
        quantity: '2.500000',
        occurred_at: new Date('2026-01-01T11:59:00.123Z'),
        created_at: new Date(),
      },
    ]);
    const records = await createPgUsageReadRepository(db).listByCustomer('cust_42', 10);
    expect(records).toEqual([
      {
        recordId: '0b7e4c7e-6f7a-4d3e-9a51-3f2c1b8d9e10',
        customerId: 'cust_42',
        dimension: 'api_calls',
        quantity: 2.5,
        timestamp: '2026-01-01T11:59:00.123Z',
      },
    ]);
    for (const r of records) {
      expect(StoredUsageRecordSchema.safeParse(r).success).toBe(true);
      expect(r.timestamp.endsWith('Z')).toBe(true);
    }
  });

  it('preserves row order', async () => {
    const mk = (id: string) => ({
      record_id: id,
      customer_id: 'c',
      dimension: 'd',
      quantity: '1',
      occurred_at: new Date('2026-01-01T00:00:00Z'),
    });
    const { db } = fakeDb([
      mk('00000000-0000-4000-8000-000000000002'),
      mk('00000000-0000-4000-8000-000000000001'),
    ]);
    const records = await createPgUsageReadRepository(db).listByCustomer('c', 10);
    expect(records.map((r) => r.recordId)).toEqual([
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    ]);
  });

  it('rejects rows of an unexpected shape instead of returning garbage', async () => {
    const { db } = fakeDb([{ record_id: 1 }]);
    await expect(createPgUsageReadRepository(db).listByCustomer('c', 1)).rejects.toThrow();
  });

  it('propagates database errors', async () => {
    const db: Queryable = { query: () => Promise.reject(new Error('connection refused')) };
    await expect(createPgUsageReadRepository(db).listByCustomer('c', 1)).rejects.toThrow(
      'connection refused',
    );
  });
});
