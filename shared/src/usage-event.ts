import { z } from 'zod';
import type { UsageRecord } from './usage-record.js';

/** Redis pub/sub channel for usage events. */
export const USAGE_EVENTS_CHANNEL = 'usage.recorded';
export const USAGE_RECORDED_EVENT_TYPE = 'usage.recorded';

/**
 * Published once a record was newly stored in Postgres. Best-effort notification:
 * Postgres is the source of truth. A breaking change adds a new `version`.
 */
export const UsageRecordedEventSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal(USAGE_RECORDED_EVENT_TYPE),
  recordId: z.uuid(),
  customerId: z.string().min(1).max(64),
  dimension: z.string().min(1).max(64),
  quantity: z.number().positive(),
  occurredAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
});

export type UsageRecordedEvent = z.infer<typeof UsageRecordedEventSchema>;

export function toUsageRecordedEvent(record: UsageRecord, recordedAt: Date): UsageRecordedEvent {
  return {
    version: 1,
    type: USAGE_RECORDED_EVENT_TYPE,
    recordId: record.recordId,
    customerId: record.customerId,
    dimension: record.dimension,
    quantity: record.quantity,
    occurredAt: record.timestamp,
    recordedAt: recordedAt.toISOString(),
  };
}

export type ParseUsageEventResult =
  { ok: true; event: UsageRecordedEvent } | { ok: false; reason: string };

/** Parses a raw pub/sub message. Never throws. */
export function parseUsageEvent(raw: string): ParseUsageEventResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'message is not valid JSON' };
  }
  const result = UsageRecordedEventSchema.safeParse(json);
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.map(String).join('.') || '(root)');
    return { ok: false, reason: `invalid event: ${[...new Set(fields)].join(', ')}` };
  }
  return { ok: true, event: result.data };
}
