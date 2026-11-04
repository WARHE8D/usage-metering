import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
});

export function loadDbConfig(env: Record<string, string | undefined>): { databaseUrl: string } {
  const parsed = envSchema.parse(env);
  return { databaseUrl: parsed.DATABASE_URL };
}
