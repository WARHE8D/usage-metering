import { describe, expect, it } from 'vitest';
import { startupMessage } from './startup.js';

describe('api startup', () => {
  it('builds a startup message from the shared app name', () => {
    expect(startupMessage('api')).toBe('usage-metering api starting');
  });
});
