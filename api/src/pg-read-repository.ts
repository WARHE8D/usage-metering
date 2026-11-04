import type { UsageRecord } from '@usage-metering/shared';
import { z } from 'zod';
import type { UsageReadRepository } from './usage-query.js';

/** The query capability the repository needs; a pg Pool satisfies it. */
export interface Queryable {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

export const LIST_USAGE_RECORDS_SQL = `SELECT record_id, customer_id, dimension, quantity, occurred_at
FROM usage_records
WHERE customer_id = $1
ORDER BY occurred_at DESC, record_id DESC
LIMIT $2`;

/** pg returns numeric as a string (exact) and timestamptz as a Date. */
const RowSchema = z.object({
  record_id: z.string(),
  customer_id: z.string(),
  dimension: z.string(),
  quantity: z.string(),
  occurred_at: z.date(),
});

export function createPgUsageReadRepository(db: Queryable): UsageReadRepository {
  return {
    async listByCustomer(customerId, limit): Promise<UsageRecord[]> {
      const result = await db.query(LIST_USAGE_RECORDS_SQL, [customerId, limit]);
      return result.rows.map((raw) => {
        const row = RowSchema.parse(raw);
        return {
          recordId: row.record_id,
          customerId: row.customer_id,
          dimension: row.dimension,
          quantity: Number(row.quantity),
          timestamp: row.occurred_at.toISOString(),
        };
      });
    },
  };
}
