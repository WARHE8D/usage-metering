import { z } from 'zod';

export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type Clock = () => Date;

export interface ParseOptions {
  /** Injected clock used for the "not more than 5 minutes in the future" rule. */
  now?: Clock;
}

const systemClock: Clock = () => new Date();

/** Builds the schema with an injected clock (for tests / serverless wrappers). */
export function createUsageRecordSchema(now: Clock = systemClock) {
  return z.strictObject({
    recordId: z.uuid(),
    customerId: z.string().min(1).max(64),
    dimension: z.string().min(1).max(64),
    quantity: z.number().positive(),
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

export type UsageRecord = z.infer<typeof UsageRecordSchema>;

export interface UsageRecordError {
  path: string;
  message: string;
}

export type ParseUsageRecordResult =
  { ok: true; data: UsageRecord } | { ok: false; errors: UsageRecordError[] };

export function parseUsageRecord(
  input: unknown,
  options: ParseOptions = {},
): ParseUsageRecordResult {
  const schema = options.now ? createUsageRecordSchema(options.now) : UsageRecordSchema;
  const result = schema.safeParse(input);
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
