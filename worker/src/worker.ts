import type { Clock, UsageDlqEntry } from '@usage-metering/shared';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { PermanentError } from './classify-error.js';
import { buildDlqEntry, dlqJobId, moveToDlq, shouldDeadLetter } from './dlq.js';
import type { Log } from './ports.js';
import type { ProcessOutcome, UsageJobProcessor } from './process-usage-job.js';

export interface UsageWorkerDeps {
  queueName: string;
  dlqName: string;
  /** maxRetriesPerRequest: null (BullMQ duplicates it for its blocking connection). */
  connection: Redis;
  dlqConnection: Redis;
  processor: UsageJobProcessor;
  concurrency: number;
  clock: Clock;
  log: Log;
}

export interface UsageWorkerHandle {
  worker: Worker<unknown, ProcessOutcome>;
  dlq: Queue<UsageDlqEntry>;
  /** Stops taking jobs, waits for active ones (forcing after timeoutMs), then for DLQ moves. */
  close(timeoutMs: number): Promise<{ forced: boolean }>;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** Wires the pure processor into BullMQ, with retries (from job options) and the DLQ move. */
export function startUsageWorker(deps: UsageWorkerDeps): UsageWorkerHandle {
  const { log } = deps;
  const dlq = new Queue<UsageDlqEntry>(deps.dlqName, { connection: deps.dlqConnection });

  const worker = new Worker<unknown, ProcessOutcome>(
    deps.queueName,
    async (job: Job<unknown, ProcessOutcome>) => {
      try {
        return await deps.processor(job.data);
      } catch (err) {
        // Permanent problems skip the remaining retries and go straight to the DLQ.
        if (err instanceof PermanentError) throw new UnrecoverableError(err.message);
        throw err;
      }
    },
    { connection: deps.connection, concurrency: deps.concurrency },
  );

  worker.on('completed', (job, result) => {
    log.info({ jobId: job.id, ...result }, 'job completed');
  });

  worker.on('error', (err) => {
    log.error({ err }, 'worker error');
  });

  // The 'failed' handler is not guaranteed to run (e.g. a crash right after the
  // failure); the original job stays in "failed" (removeOnFail: false) either way.
  const pendingMoves = new Set<Promise<void>>();
  worker.on('failed', (job, err) => {
    if (!job) return;
    const attempts = { attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 1 };
    const context = { jobId: job.id, ...attempts, err };
    if (!shouldDeadLetter(attempts, err)) {
      log.warn(context, 'job failed, will retry');
      return;
    }
    const entry = buildDlqEntry({
      data: job.data,
      failedReason: err.message,
      attemptsMade: job.attemptsMade,
      originalJobId: job.id,
      queue: deps.queueName,
      failedAt: deps.clock(),
    });
    const move = moveToDlq(dlq, entry, dlqJobId(job.data, job.id))
      .then(() => {
        log.error(context, 'job moved to dead-letter queue');
      })
      .catch((dlqErr: unknown) => {
        log.error(
          { ...context, dlqErr },
          'failed to move job to dead-letter queue; it remains in the failed set',
        );
      })
      .finally(() => {
        pendingMoves.delete(move);
      });
    pendingMoves.add(move);
  });

  return {
    worker,
    dlq,
    async close(timeoutMs) {
      // worker.close() waits for active jobs with no built-in timeout.
      const forced = await Promise.race([
        worker.close().then(() => false),
        delay(timeoutMs).then(() => true),
      ]);
      if (forced) {
        log.warn({ timeoutMs }, 'active jobs did not finish in time; forcing close');
        await worker.close(true); // interrupted jobs are retried later as stalled
      }
      await Promise.allSettled([...pendingMoves]);
      await dlq.close();
      return { forced };
    },
  };
}
