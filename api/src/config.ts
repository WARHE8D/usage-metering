import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const envSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  REDIS_URL: z.string().min(1),
  API_KEY: z.string().min(16),
  API_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(16_384),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface ApiConfig {
  port: number;
  host: string;
  redisUrl: string;
  apiKey: string;
  bodyLimitBytes: number;
  logLevel: LogLevel;
}

/**
 * Validates env vars. Throws an Error that names the offending variables but
 * never echoes their values (API_KEY and REDIS_URL may hold secrets).
 */
export function loadApiConfig(env: Record<string, string | undefined>): ApiConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid api configuration: ${problems}`);
  }
  const c = parsed.data;
  return {
    port: c.API_PORT,
    host: c.API_HOST,
    redisUrl: c.REDIS_URL,
    apiKey: c.API_KEY,
    bodyLimitBytes: c.API_BODY_LIMIT_BYTES,
    logLevel: c.LOG_LEVEL,
  };
}
