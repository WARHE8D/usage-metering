import { z } from 'zod';

export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type Clock = () => Date;

export interface ParseOptions {
  /** Injected clock used for the "not more than 5 minutes in the future" rule. */
  now?: Clock;
}

const systemClock: Clock = () => new Date();

/** Field rules shared by the ingest schema and the stored-record (worker) schema. */
const recordFields = {
  recordId: z.uuid(),
  customerId: z.string().min(1).max(64),
  dimension: z.string().min(1).max(64),
  quantity: z.number().positive(),
};

/** Builds the ingest schema with an injected clock (for tests / serverless wrappers). */
export function createUsageRecordSchema(now: Clock = systemClock) {
  return z.strictObject({
    ...recordFields,
    timestamp: z.iso.datetime().refine(
      (value) => {
        // Malformed or non-UTC values are already reported by the datetime format check.
        if (!value.endsWith('Z')) return true;
        const time = Date.parse(value);
        return Number.isNaN(time) || time <= now().getTime() + MAX_FUTURE_SKEW_MS;
      },
      {
        message: 'timestamp must not be more than 5 minutes in the future',
      },
    ),
  });
}

export const UsageRecordSchema = createUsageRecordSchema();

/**
 * Schema for records already accepted at ingest (e.g. queue job data). Same field
 * rules, but no "future" check: that rule is relative to ingest time, and a job
 * retried or processed from a backlog later must not fail because of it.
 */
export const StoredUsageRecordSchema = z.strictObject({
  ...recordFields,
  timestamp: z.iso.datetime(),
});

export type UsageRecord = z.infer<typeof UsageRecordSchema>;

export interface UsageRecordError {
  path: string;
  message: string;
}

export type ParseUsageRecordResult =
  { ok: true; data: UsageRecord } | { ok: false; errors: UsageRecordError[] };

function toResult(result: ReturnType<typeof UsageRecordSchema.safeParse>): ParseUsageRecordResult {
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}

/** Validates a record at ingest (includes the "not more than 5 minutes in the future" rule). */
export function parseUsageRecord(
  input: unknown,
  options: ParseOptions = {},
): ParseUsageRecordResult {
  const schema = options.now ? createUsageRecordSchema(options.now) : UsageRecordSchema;
  return toResult(schema.safeParse(input));
}

/** Validates a previously accepted record (format only; no future-timestamp rule). */
export function parseStoredUsageRecord(input: unknown): ParseUsageRecordResult {
  return toResult(StoredUsageRecordSchema.safeParse(input));
}
