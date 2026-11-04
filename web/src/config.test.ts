import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('accepts valid values and strips trailing slashes', () => {
    expect(loadConfig({ VITE_API_URL: 'http://localhost:3000/', VITE_API_KEY: 'abc' })).toEqual({
      ok: true,
      config: { apiUrl: 'http://localhost:3000', apiKey: 'abc' },
    });
  });

  it('reports missing values', () => {
    const result = loadConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('VITE_API_URL');
      expect(result.errors.join(' ')).toContain('VITE_API_KEY');
    }
  });

  it('treats an empty key and a malformed URL as invalid', () => {
    const result = loadConfig({ VITE_API_URL: 'not a url', VITE_API_KEY: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(2);
  });
});
