import pg from 'pg';
import { Redis } from 'ioredis';
import type { Log } from './ports.js';

/**
 * The few ioredis options we set. A narrow type of our own: ioredis 6's RedisOptions
 * does not satisfy its own constructor under exactOptionalPropertyTypes.
 */
export interface RedisConnectionOptions {
  maxRetriesPerRequest?: number | null;
  commandTimeout?: number;
}

/**
 * Worker (BullMQ blocking) and DLQ Queue connections: BullMQ requires
 * maxRetriesPerRequest null for workers; keep the offline queue so they wait out
 * Redis blips instead of failing.
 */
export const BULLMQ_REDIS_OPTIONS: RedisConnectionOptions = { maxRetriesPerRequest: null };

/** Publisher: bounded, so a Redis outage can't stall a job for long. */
export const PUBLISHER_REDIS_OPTIONS: RedisConnectionOptions = {
  maxRetriesPerRequest: 2,
  commandTimeout: 2000,
};

/**
 * Connects and resolves once Redis is ready, so startup fails fast with a clear
 * error. Afterwards, connection errors are logged (an 'error' event without a
 * listener would be unhandled) while ioredis reconnects on its own.
 */
export async function connectRedis(
  url: string,
  options: RedisConnectionOptions,
  log: Log,
  name: string,
): Promise<Redis> {
  const connection = new Redis(url, { ...options, lazyConnect: true });
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
  connection.on('error', (err: unknown) => {
    log.warn({ err, connection: name }, 'redis connection error');
  });
  return connection;
}

export function createPgPool(url: string, max: number, log: Log): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
  });
  // Idle clients emit errors when Postgres restarts; without a listener the process crashes.
  pool.on('error', (err) => {
    log.error({ err }, 'idle postgres client error');
  });
  return pool;
}
