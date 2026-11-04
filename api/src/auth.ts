import { createHash, timingSafeEqual } from 'node:crypto';

/** Header value as Fastify exposes it. */
export type ApiKeyHeader = string | string[] | undefined;
export type ApiKeyChecker = (provided: ApiKeyHeader) => boolean;

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time API key check. Both sides are hashed first so inputs of any
 * length compare in constant time (timingSafeEqual throws on unequal lengths).
 */
export function createApiKeyChecker(expected: string): ApiKeyChecker {
  if (expected.length === 0) throw new Error('API key must not be empty');
  const expectedDigest = sha256(expected);
  return (provided) => {
    if (typeof provided !== 'string' || provided.length === 0) return false;
    return timingSafeEqual(sha256(provided), expectedDigest);
  };
}
