/** An error retrying cannot fix (bad data, constraint violation, schema bug). */
export class PermanentError extends Error {
  override readonly name = 'PermanentError';
}

export type ErrorKind = 'transient' | 'permanent';

/** Node socket/DNS errors: the database or Redis is (temporarily) unreachable. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
]);

/** SQLSTATE codes outside the transient classes that are still worth retrying. */
const TRANSIENT_SQLSTATES = new Set(['55P03', '25006']); // lock not available, read-only after failover

/**
 * SQLSTATE classes. Transient: 08 connection, 40 serialization/deadlock,
 * 53 insufficient resources, 57 operator intervention (shutdown, statement timeout).
 * Permanent: 22 data exception, 23 integrity violation, 42 syntax/missing object.
 */
const TRANSIENT_CLASSES = new Set(['08', '40', '53', '57']);
const PERMANENT_CLASSES = new Set(['22', '23', '42']);

const SQLSTATE = /^[0-9A-Z]{5}$/;

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

/**
 * Decides whether a failed job should be retried. Unknown errors are treated as
 * transient: retries are bounded, so they still end up in the dead-letter queue.
 */
export function classifyError(err: unknown): ErrorKind {
  if (err instanceof PermanentError) return 'permanent';
  const code = errorCode(err);
  if (code === undefined) return 'transient';
  if (TRANSIENT_NETWORK_CODES.has(code) || TRANSIENT_SQLSTATES.has(code)) return 'transient';
  if (SQLSTATE.test(code)) {
    const sqlClass = code.slice(0, 2);
    if (TRANSIENT_CLASSES.has(sqlClass)) return 'transient';
    if (PERMANENT_CLASSES.has(sqlClass)) return 'permanent';
  }
  return 'transient';
}
