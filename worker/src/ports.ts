import type { UsageRecord, UsageRecordedEvent } from '@usage-metering/shared';

/** Result of the idempotent insert: Postgres (PK on record_id) decides, never memory. */
export type InsertOutcome = 'inserted' | 'duplicate';

export interface UsageRepository {
  insertIfAbsent(record: UsageRecord): Promise<InsertOutcome>;
}

export interface EventPublisher {
  publish(event: UsageRecordedEvent): Promise<void>;
}

/** The logging subset business logic needs; a pino Logger satisfies it. */
export interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
