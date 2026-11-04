import { describe, expect, it } from 'vitest';
import { createApiKeyChecker } from './auth.js';

const KEY = 'correct-horse-battery-staple';

describe('createApiKeyChecker', () => {
  const check = createApiKeyChecker(KEY);

  it('accepts the exact key', () => {
    expect(check(KEY)).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['wrong key of the same length', 'correct-horse-battery-stapLE'],
    ['shorter prefix', 'correct-horse'],
    ['longer key', `${KEY}x`],
    ['different case', KEY.toUpperCase()],
    ['surrounding whitespace', ` ${KEY} `],
    ['array (repeated header)', [KEY, KEY]],
    ['single-element array', [KEY]],
  ])('rejects %s without throwing', (_label, provided) => {
    expect(() => check(provided)).not.toThrow();
    expect(check(provided)).toBe(false);
  });

  it('refuses to be configured with an empty key', () => {
    expect(() => createApiKeyChecker('')).toThrow();
  });
});
