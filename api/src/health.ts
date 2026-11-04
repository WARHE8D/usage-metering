export interface HealthStatus {
  ok: boolean;
  redis: 'up' | 'down';
  postgres: 'up' | 'down';
}

export type HealthCheck = () => Promise<HealthStatus>;

export interface HealthDeps {
  /** Resolves when Redis answers; rejects otherwise. */
  ping: () => Promise<unknown>;
  /** Resolves when Postgres answers (SELECT 1); rejects otherwise. */
  pingDb: () => Promise<unknown>;
  timeoutMs: number;
}

/** Resolves true if probe settles within timeoutMs, false if it rejects or is too slow. */
async function isUp(probe: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('health check timed out'));
    }, timeoutMs);
  });
  try {
    await Promise.race([probe(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Readiness check: Redis and Postgres must each answer within timeoutMs (probed in parallel). */
export function createHealthCheck(deps: HealthDeps): HealthCheck {
  return async () => {
    const [redisUp, pgUp] = await Promise.all([
      isUp(deps.ping, deps.timeoutMs),
      isUp(deps.pingDb, deps.timeoutMs),
    ]);
    return {
      ok: redisUp && pgUp,
      redis: redisUp ? 'up' : 'down',
      postgres: pgUp ? 'up' : 'down',
    };
  };
}
