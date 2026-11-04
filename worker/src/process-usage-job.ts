import { parseStoredUsageRecord, toUsageRecordedEvent, type Clock } from '@usage-metering/shared';
import { PermanentError, classifyError } from './classify-error.js';
import type { EventPublisher, Log, UsageRepository } from './ports.js';

export type ProcessOutcome =
  | { status: 'inserted'; recordId: string; published: boolean }
  | { status: 'duplicate'; recordId: string };

export interface ProcessorDeps {
  repo: UsageRepository;
  publisher: EventPublisher;
  clock: Clock;
  log: Log;
}

export type UsageJobProcessor = (data: unknown) => Promise<ProcessOutcome>;

/**
 * Pure job logic, independent of BullMQ (so it can become a serverless handler):
 * validate -> idempotent insert -> publish "usage.recorded" only if a row was inserted.
 *
 * Throws PermanentError for problems retrying can't fix, and rethrows transient
 * errors unchanged so the queue retries them.
 *
 * Events are best-effort: if publishing fails after the insert, a retry would
 * only see a duplicate and could not publish either, so the failure is logged
 * as a lost event and the job still succeeds. Postgres is the source of truth.
 */
export function createUsageJobProcessor(deps: ProcessorDeps): UsageJobProcessor {
  return async (data) => {
    const parsed = parseStoredUsageRecord(data);
    if (!parsed.ok) {
      const fields = [...new Set(parsed.errors.map((e) => e.path || '(root)'))].join(', ');
      throw new PermanentError(`invalid job data: ${fields}`);
    }
    const record = parsed.data;

    let outcome;
    try {
      outcome = await deps.repo.insertIfAbsent(record);
    } catch (err) {
      if (classifyError(err) === 'permanent') {
        const reason = err instanceof Error ? err.message : String(err);
        throw new PermanentError(`database rejected record: ${reason}`, { cause: err });
      }
      throw err;
    }

    if (outcome === 'duplicate') {
      deps.log.info({ recordId: record.recordId }, 'duplicate record, skipped');
      return { status: 'duplicate', recordId: record.recordId };
    }

    try {
      await deps.publisher.publish(toUsageRecordedEvent(record, deps.clock()));
    } catch (err) {
      deps.log.error(
        { err, recordId: record.recordId, event: 'event_publish_failed' },
        'usage.recorded event lost: publish failed after insert',
      );
      return { status: 'inserted', recordId: record.recordId, published: false };
    }
    return { status: 'inserted', recordId: record.recordId, published: true };
  };
}
