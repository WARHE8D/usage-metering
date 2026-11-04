import {
  USAGE_JOB_NAME,
  parseUsageRecord,
  usageJobOptions,
  type Clock,
  type UsageJobOptions,
  type UsageRecord,
  type UsageRecordError,
} from '@usage-metering/shared';

/** The only queue capability ingest needs; a BullMQ Queue adapter or a fake implements it. */
export interface UsageQueue {
  add(name: string, data: UsageRecord, opts: UsageJobOptions): Promise<unknown>;
}

export type IngestResult =
  | { status: 'accepted'; recordId: string }
  | { status: 'invalid'; errors: UsageRecordError[] }
  | { status: 'unavailable'; cause: unknown };

export type IngestUsage = (input: unknown) => Promise<IngestResult>;

export interface IngestDeps {
  queue: UsageQueue;
  now?: Clock;
}

/**
 * Pure ingest use case: validate, then enqueue with jobId = recordId.
 * No HTTP, no logging, no in-memory dedupe (idempotency lives in Postgres).
 */
export function createIngestUsage(deps: IngestDeps): IngestUsage {
  const parseOptions = deps.now ? { now: deps.now } : {};
  return async (input) => {
    const parsed = parseUsageRecord(input, parseOptions);
    if (!parsed.ok) return { status: 'invalid', errors: parsed.errors };

    const record = parsed.data;
    try {
      await deps.queue.add(USAGE_JOB_NAME, record, usageJobOptions(record.recordId));
    } catch (cause) {
      return { status: 'unavailable', cause };
    }
    return { status: 'accepted', recordId: record.recordId };
  };
}
