import { describe, expect, it } from 'vitest';
import { startupMessage } from './startup.js';

describe('worker startup', () => {
  it('builds a startup message from the shared app name', () => {
    expect(startupMessage('worker')).toBe('usage-metering worker starting');
  });
});
