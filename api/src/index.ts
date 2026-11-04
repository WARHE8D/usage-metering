import { buildServer } from './server.js';
import { createApiKeyChecker } from './auth.js';
import { loadApiConfig } from './config.js';
import { createHealthCheck } from './health.js';
import { createIngestUsage } from './ingest.js';
import { connectRedis, createBullUsageQueue } from './queue.js';
import { startupMessage } from './startup.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 1_000;

/** Runs a startup step; on failure prints a one-line reason (no stack, no secrets) and exits 1. */
async function orExit<T>(step: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.error(`${step}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

const config = await orExit('Startup failed', () => loadApiConfig(process.env));
const connection = await orExit('Cannot connect to Redis at startup', () =>
  connectRedis(config.redisUrl),
);
const { queue, usageQueue } = createBullUsageQueue(connection);

const app = buildServer({
  ingest: createIngestUsage({ queue: usageQueue }),
  checkApiKey: createApiKeyChecker(config.apiKey),
  health: createHealthCheck({ ping: () => connection.ping(), timeoutMs: HEALTH_TIMEOUT_MS }),
  config: { bodyLimitBytes: config.bodyLimitBytes, corsOrigins: config.corsOrigins },
  logger: { level: config.logLevel, redact: ['req.headers["x-api-key"]'] },
});

// Without a listener, ioredis connection errors would be unhandled 'error' events.
connection.on('error', (err: unknown) => {
  app.log.warn({ err }, 'redis connection error');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const timer = setTimeout(() => {
    app.log.error('shutdown timed out');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  try {
    await app.close(); // stop accepting, drain in-flight requests
    await queue.close();
    await connection.quit().catch(() => {
      connection.disconnect();
    });
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

app.log.info(startupMessage('api'));
await app.listen({ port: config.port, host: config.host });
