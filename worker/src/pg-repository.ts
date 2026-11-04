import type { InsertOutcome, UsageRepository } from './ports.js';

/** The query capability the repository needs; a pg Pool satisfies it. */
export interface Queryable {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Idempotency lives here: the primary key on record_id plus ON CONFLICT DO NOTHING.
 * RETURNING yields a row only when this call inserted it.
 */
export const INSERT_USAGE_RECORD_SQL = `INSERT INTO usage_records (record_id, customer_id, dimension, quantity, occurred_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (record_id) DO NOTHING
RETURNING record_id`;

export function createPgUsageRepository(db: Queryable): UsageRepository {
  return {
    async insertIfAbsent(record): Promise<InsertOutcome> {
      const result = await db.query(INSERT_USAGE_RECORD_SQL, [
        record.recordId,
        record.customerId,
        record.dimension,
        // Sent as text so Postgres parses it into numeric exactly.
        String(record.quantity),
        record.timestamp,
      ]);
      return result.rows.length > 0 ? 'inserted' : 'duplicate';
    },
  };
}
