import { USAGE_DLQ_NAME, USAGE_QUEUE_NAME } from '@usage-metering/shared';
import { loadWorkerConfig } from './config.js';
import {
  BULLMQ_REDIS_OPTIONS,
  PUBLISHER_REDIS_OPTIONS,
  connectRedis,
  createPgPool,
} from './connections.js';
import { createLogger } from './logger.js';
import { createPgUsageRepository } from './pg-repository.js';
import { createUsageJobProcessor } from './process-usage-job.js';
import { createRedisEventPublisher } from './redis-publisher.js';
import { startupMessage } from './startup.js';
import { startUsageWorker } from './worker.js';

/** Runs a startup step; on failure prints a one-line reason (no stack, no secrets) and exits 1. */
async function orExit<T>(step: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.error(`${step}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

const config = await orExit('Startup failed', () => loadWorkerConfig(process.env));
const log = createLogger('worker', config.logLevel);
log.info(startupMessage('worker'));

const pool = createPgPool(config.databaseUrl, config.pgPoolMax, log);
await orExit('Cannot connect to Postgres at startup', () => pool.query('SELECT 1'));
const workerConn = await orExit('Cannot connect to Redis at startup', () =>
  connectRedis(config.redisUrl, BULLMQ_REDIS_OPTIONS, log, 'worker'),
);
const dlqConn = await orExit('Cannot connect to Redis at startup', () =>
  connectRedis(config.redisUrl, BULLMQ_REDIS_OPTIONS, log, 'dlq'),
);
const publisherConn = await orExit('Cannot connect to Redis at startup', () =>
  connectRedis(config.redisUrl, PUBLISHER_REDIS_OPTIONS, log, 'publisher'),
);

const clock = () => new Date();
const handle = startUsageWorker({
  queueName: USAGE_QUEUE_NAME,
  dlqName: USAGE_DLQ_NAME,
  connection: workerConn,
  dlqConnection: dlqConn,
  processor: createUsageJobProcessor({
    repo: createPgUsageRepository(pool),
    publisher: createRedisEventPublisher(publisherConn, config.eventsChannel),
    clock,
    log,
  }),
  concurrency: config.concurrency,
  clock,
  log,
});
log.info(
  { queue: USAGE_QUEUE_NAME, concurrency: config.concurrency, channel: config.eventsChannel },
  'worker started',
);

let shuttingDown = false;
async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ reason }, 'shutting down');
  try {
    const { forced } = await handle.close(config.shutdownTimeoutMs);
    const results = await Promise.allSettled([
      publisherConn.quit(),
      dlqConn.quit(),
      workerConn.quit(),
    ]);
    await pool.end();
    const failed = results.some((r) => r.status === 'rejected');
    process.exit(forced || failed ? 1 : exitCode);
  } catch (err) {
    log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.once('SIGINT', () => void shutdown('SIGINT', 0));
process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('unhandledRejection', (err) => {
  log.fatal({ err }, 'unhandled rejection');
  void shutdown('unhandledRejection', 1);
});
