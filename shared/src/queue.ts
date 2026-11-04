/**
 * Queue contract shared by the API (producer) and the worker (consumer).
 * Typed structurally so shared/ does not depend on bullmq; the shape is
 * assignable to bullmq's JobsOptions.
 */

export const USAGE_QUEUE_NAME = 'usage';
/** Dead-letter queue for jobs that exhausted their retries (used by the worker). */
export const USAGE_DLQ_NAME = 'usage-dlq';
export const USAGE_JOB_NAME = 'usage.record';

export const USAGE_JOB_ATTEMPTS = 5;
/** Exponential backoff base: retries wait ~1s, 2s, 4s, 8s. */
export const USAGE_JOB_BACKOFF_DELAY_MS = 1000;
/** Completed jobs kept for inspection: at most this many, for at most this long. */
export const USAGE_JOB_KEEP_COMPLETED = { count: 1000, age: 24 * 60 * 60 } as const;

export interface UsageJobOptions {
  jobId: string;
  attempts: number;
  backoff: { type: 'exponential'; delay: number };
  removeOnComplete: { count: number; age: number };
  /** Failed jobs are kept so the worker can move them to the dead-letter queue. */
  removeOnFail: false;
}

/** jobId = recordId gives best-effort dedupe in Redis; Postgres is the real guard. */
export function usageJobOptions(recordId: string): UsageJobOptions {
  return {
    jobId: recordId,
    attempts: USAGE_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: USAGE_JOB_BACKOFF_DELAY_MS },
    removeOnComplete: { ...USAGE_JOB_KEEP_COMPLETED },
    removeOnFail: false,
  };
}
