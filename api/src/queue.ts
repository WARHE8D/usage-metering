import { USAGE_QUEUE_NAME, type UsageRecord } from '@usage-metering/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { UsageQueue } from './ingest.js';

/**
 * Producer-side Redis connection. enableOfflineQueue: false makes commands fail
 * immediately while Redis is down (-> 503) instead of hanging the HTTP request.
 * Workers need different settings (maxRetriesPerRequest: null) and must not reuse this.
 */
export function createRedisConnection(url: string): Redis {
  return new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true });
}

/**
 * Connects and resolves once Redis is ready. Must complete before creating the
 * Queue: with the offline queue disabled, BullMQ's one-time init (INFO) fails on a
 * not-yet-connected client and every later add() would fail with it.
 */
export async function connectRedis(url: string): Promise<Redis> {
  const connection = createRedisConnection(url);
  // connect() rejects with the error; this stops ioredis also printing it as unhandled.
  const ignoreDuringConnect = (): void => undefined;
  connection.on('error', ignoreDuringConnect);
  try {
    await connection.connect();
  } catch (err) {
    connection.disconnect();
    throw err;
  } finally {
    connection.off('error', ignoreDuringConnect);
  }
  return connection;
}

export interface BullUsageQueue {
  queue: Queue<UsageRecord>;
  usageQueue: UsageQueue;
}

/** The caller owns `connection`: close the queue first, then quit the connection. */
export function createBullUsageQueue(
  connection: Redis,
  name: string = USAGE_QUEUE_NAME,
): BullUsageQueue {
  const queue = new Queue<UsageRecord>(name, { connection, skipWaitingForReady: true });
  return {
    queue,
    usageQueue: { add: (jobName, data, opts) => queue.add(jobName, data, opts) },
  };
}
