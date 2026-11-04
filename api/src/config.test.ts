import { describe, expect, it } from 'vitest';
import { loadApiConfig } from './config.js';

const SECRET = 'a-very-secret-key-123';
const base = { REDIS_URL: 'redis://localhost:6379', API_KEY: SECRET };

describe('loadApiConfig', () => {
  it('applies defaults for optional vars', () => {
    expect(loadApiConfig(base)).toEqual({
      port: 3000,
      host: '0.0.0.0',
      redisUrl: 'redis://localhost:6379',
      apiKey: SECRET,
      bodyLimitBytes: 16_384,
      logLevel: 'info',
    });
  });

  it('coerces numeric vars and reads overrides', () => {
    const config = loadApiConfig({
      ...base,
      API_PORT: '8080',
      API_HOST: '127.0.0.1',
      API_BODY_LIMIT_BYTES: '1024',
      LOG_LEVEL: 'debug',
    });
    expect(config).toMatchObject({
      port: 8080,
      host: '127.0.0.1',
      bodyLimitBytes: 1024,
      logLevel: 'debug',
    });
  });

  it('ignores unrelated env vars', () => {
    expect(() => loadApiConfig({ ...base, PATH: '/usr/bin' })).not.toThrow();
  });

  it.each([
    ['REDIS_URL missing', { API_KEY: SECRET }, 'REDIS_URL'],
    ['API_KEY missing', { REDIS_URL: base.REDIS_URL }, 'API_KEY'],
    ['API_KEY too short', { ...base, API_KEY: 'short' }, 'API_KEY'],
    ['non-numeric port', { ...base, API_PORT: 'abc' }, 'API_PORT'],
    ['port out of range', { ...base, API_PORT: '70000' }, 'API_PORT'],
    ['non-integer port', { ...base, API_PORT: '3000.5' }, 'API_PORT'],
    ['zero body limit', { ...base, API_BODY_LIMIT_BYTES: '0' }, 'API_BODY_LIMIT_BYTES'],
    ['unknown log level', { ...base, LOG_LEVEL: 'verbose' }, 'LOG_LEVEL'],
  ])('throws on %s, naming the variable', (_label, env, variable) => {
    expect(() => loadApiConfig(env)).toThrow(variable);
  });

  it('never includes secret values in the error message', () => {
    const shortSecret = 'tooshort!';
    let message = '';
    try {
      loadApiConfig({
        REDIS_URL: 'redis://user:pw@host:6379',
        API_KEY: shortSecret,
        API_PORT: 'x',
      });
    } catch (err) {
      message = err instanceof Error ? err.message : '';
    }
    expect(message).toContain('API_KEY');
    expect(message).not.toContain(shortSecret);
    expect(message).not.toContain('pw@host');
  });
});
