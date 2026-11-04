import { loadSubscriberConfig } from './config.js';
import { connectRedis } from './connections.js';
import { createLogger } from './logger.js';
import { createUsageEventHandler } from './subscriber-handler.js';

/**
 * Separate process that logs usage.recorded events. Redis pub/sub is
 * fire-and-forget: events published while this is not running are not replayed.
 */
async function orExit<T>(step: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.error(`${step}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

const config = await orExit('Startup failed', () => loadSubscriberConfig(process.env));
const log = createLogger('subscriber', config.logLevel);
// A subscribed ioredis client can only run (un)subscribe commands, so it gets its own connection.
const connection = await orExit('Cannot connect to Redis at startup', () =>
  connectRedis(config.redisUrl, {}, log, 'subscriber'),
);

const handle = createUsageEventHandler(log);
connection.on('message', (channel: string, message: string) => {
  if (channel === config.eventsChannel) handle(message);
});
// ioredis re-subscribes automatically after a reconnect.
await orExit('Cannot subscribe', () => connection.subscribe(config.eventsChannel));
log.info({ channel: config.eventsChannel }, 'subscriber listening');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  const timer = setTimeout(() => {
    connection.disconnect();
    process.exit(1);
  }, 5000);
  timer.unref();
  try {
    await connection.unsubscribe();
    await connection.quit();
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'shutdown failed');
    connection.disconnect();
    process.exit(1);
  }
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
