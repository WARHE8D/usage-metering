import { z } from 'zod';

const ConfigSchema = z.object({
  VITE_API_URL: z.url({
    error: 'VITE_API_URL must be set to a valid URL, e.g. http://localhost:3000',
  }),
  VITE_API_KEY: z.string({ error: 'VITE_API_KEY must be set' }).min(1, 'VITE_API_KEY must be set'),
});

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

export interface AppConfig {
  apiUrl: string;
  apiKey: string;
}

export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; errors: string[] };

/** Validates the Vite env at startup. VITE_* values are public: they ship in the bundle. */
export function loadConfig(env: {
  VITE_API_URL?: string | undefined;
  VITE_API_KEY?: string | undefined;
}): ConfigResult {
  const parsed = ConfigSchema.safeParse({
    VITE_API_URL: nonEmpty(env.VITE_API_URL),
    VITE_API_KEY: nonEmpty(env.VITE_API_KEY),
  });
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => issue.message) };
  }
  return {
    ok: true,
    config: {
      apiUrl: parsed.data.VITE_API_URL.replace(/\/+$/, ''),
      apiKey: parsed.data.VITE_API_KEY,
    },
  };
}
