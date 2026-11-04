import { USAGE_EVENTS_CHANNEL } from '@usage-metering/shared';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(100).optional(),
  USAGE_EVENTS_CHANNEL: z.string().min(1).default(USAGE_EVENTS_CHANNEL),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  concurrency: number;
  /** One connection per concurrent job plus a little headroom. */
  pgPoolMax: number;
  eventsChannel: string;
  shutdownTimeoutMs: number;
  logLevel: LogLevel;
}

/** Errors name the variables but never echo values (URLs hold passwords). */
function parseEnv<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined>,
  what: string,
): z.infer<T> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid ${what} configuration: ${problems}`);
  }
  return parsed.data;
}

export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const c = parseEnv(envSchema, env, 'worker');
  return {
    databaseUrl: c.DATABASE_URL,
    redisUrl: c.REDIS_URL,
    concurrency: c.WORKER_CONCURRENCY,
    pgPoolMax: c.PG_POOL_MAX ?? c.WORKER_CONCURRENCY + 2,
    eventsChannel: c.USAGE_EVENTS_CHANNEL,
    shutdownTimeoutMs: c.SHUTDOWN_TIMEOUT_MS,
    logLevel: c.LOG_LEVEL,
  };
}

const subscriberEnvSchema = envSchema.pick({
  REDIS_URL: true,
  USAGE_EVENTS_CHANNEL: true,
  LOG_LEVEL: true,
});

export interface SubscriberConfig {
  redisUrl: string;
  eventsChannel: string;
  logLevel: LogLevel;
}

/** The subscriber only needs Redis; it never touches Postgres. */
export function loadSubscriberConfig(env: Record<string, string | undefined>): SubscriberConfig {
  const c = parseEnv(subscriberEnvSchema, env, 'subscriber');
  return { redisUrl: c.REDIS_URL, eventsChannel: c.USAGE_EVENTS_CHANNEL, logLevel: c.LOG_LEVEL };
}
