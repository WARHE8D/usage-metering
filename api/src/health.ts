export interface HealthStatus {
  ok: boolean;
  redis: 'up' | 'down';
}

export type HealthCheck = () => Promise<HealthStatus>;

export interface HealthDeps {
  /** Resolves when Redis answers; rejects otherwise. */
  ping: () => Promise<unknown>;
  timeoutMs: number;
}

/** Readiness check: Redis must answer a ping within timeoutMs. */
export function createHealthCheck(deps: HealthDeps): HealthCheck {
  return async () => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('health check timed out'));
      }, deps.timeoutMs);
    });
    try {
      await Promise.race([deps.ping(), timeout]);
      return { ok: true, redis: 'up' };
    } catch {
      return { ok: false, redis: 'down' };
    } finally {
      clearTimeout(timer);
    }
  };
}
