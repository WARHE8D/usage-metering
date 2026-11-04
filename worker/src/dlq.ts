import { randomUUID } from 'node:crypto';
import {
  USAGE_DLQ_JOB_NAME,
  dlqJobOptions,
  type DlqJobOptions,
  type UsageDlqEntry,
} from '@usage-metering/shared';
import { UnrecoverableError } from 'bullmq';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A failed job goes to the dead-letter queue when it will not be retried again:
 * its attempts are used up, or it failed with an unrecoverable (permanent) error.
 */
export function shouldDeadLetter(
  job: { attemptsMade: number; maxAttempts: number },
  err: unknown,
): boolean {
  return err instanceof UnrecoverableError || job.attemptsMade >= job.maxAttempts;
}

/**
 * DLQ jobId = recordId, so moving the same record twice is a no-op. Falls back to
 * the original job id for invalid data (no ':' — BullMQ uses it as a separator).
 */
export function dlqJobId(data: unknown, originalJobId: string | undefined): string {
  if (typeof data === 'object' && data !== null && 'recordId' in data) {
    const { recordId } = data;
    if (typeof recordId === 'string' && UUID.test(recordId)) return recordId;
  }
  const suffix = originalJobId ? originalJobId.replaceAll(':', '-') : randomUUID();
  return `dlq-${suffix}`;
}

export function buildDlqEntry(input: {
  data: unknown;
  failedReason: string;
  attemptsMade: number;
  originalJobId: string | undefined;
  queue: string;
  failedAt: Date;
}): UsageDlqEntry {
  return {
    record: input.data,
    failedReason: input.failedReason,
    attemptsMade: input.attemptsMade,
    originalJobId: input.originalJobId ?? 'unknown',
    failedAt: input.failedAt.toISOString(),
    queue: input.queue,
  };
}

/** The only DLQ capability needed; a BullMQ Queue adapter or a fake implements it. */
export interface DeadLetterQueue {
  add(name: string, data: UsageDlqEntry, opts: DlqJobOptions): Promise<unknown>;
}

export async function moveToDlq(
  dlq: DeadLetterQueue,
  entry: UsageDlqEntry,
  jobId: string,
): Promise<void> {
  await dlq.add(USAGE_DLQ_JOB_NAME, entry, dlqJobOptions(jobId));
}
