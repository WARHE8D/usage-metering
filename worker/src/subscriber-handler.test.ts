import { toUsageRecordedEvent } from '@usage-metering/shared';
import { describe, expect, it } from 'vitest';
import { loadSubscriberConfig } from './config.js';
import type { Log } from './ports.js';
import { createUsageEventHandler } from './subscriber-handler.js';

interface Line {
  level: 'info' | 'warn' | 'error';
  obj: object;
  msg: string;
}

function capture(): { log: Log; lines: Line[] } {
  const lines: Line[] = [];
  return {
    lines,
    log: {
      info: (obj, msg) => lines.push({ level: 'info', obj, msg }),
      warn: (obj, msg) => lines.push({ level: 'warn', obj, msg }),
      error: (obj, msg) => lines.push({ level: 'error', obj, msg }),
    },
  };
}

const event = toUsageRecordedEvent(
  {
    recordId: '0b7e4c7e-6f7a-4d3e-9a51-3f2c1b8d9e10',
    customerId: 'cust_42',
    dimension: 'api_calls',
    quantity: 3,
    timestamp: '2026-01-01T11:59:00.000Z',
  },
  new Date('2026-01-01T12:00:00.000Z'),
);

describe('createUsageEventHandler', () => {
  it('logs a valid event at info level', () => {
    const { log, lines } = capture();
    createUsageEventHandler(log)(JSON.stringify(event));
    expect(lines).toEqual([{ level: 'info', obj: { event }, msg: 'usage.recorded' }]);
  });

  it.each([
    ['malformed JSON', '{"recordId":'],
    ['empty message', ''],
    ['wrong shape', JSON.stringify({ hello: 'world' })],
    ['unknown version', JSON.stringify({ ...event, version: 2 })],
    ['JSON null', 'null'],
  ])('warns and does not throw on %s', (_label, raw) => {
    const { log, lines } = capture();
    expect(() => {
      createUsageEventHandler(log)(raw);
    }).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('warn');
  });

  it('truncates huge payloads in the warning', () => {
    const { log, lines } = capture();
    createUsageEventHandler(log)('x'.repeat(10_000));
    const payload = (lines[0]?.obj as { payload: string }).payload;
    expect(payload).toHaveLength(200);
  });

  it('survives a logger that throws', () => {
    const throwing: Log = {
      info: () => {
        throw new Error('stdout closed');
      },
      warn: () => undefined,
      error: () => undefined,
    };
    expect(() => {
      createUsageEventHandler(throwing)(JSON.stringify(event));
    }).not.toThrow();
  });
});

describe('loadSubscriberConfig', () => {
  it('needs only REDIS_URL (no DATABASE_URL) and applies defaults', () => {
    expect(loadSubscriberConfig({ REDIS_URL: 'redis://localhost:6379' })).toEqual({
      redisUrl: 'redis://localhost:6379',
      eventsChannel: 'usage.recorded',
      logLevel: 'info',
    });
  });

  it('throws when REDIS_URL is missing', () => {
    expect(() => loadSubscriberConfig({})).toThrow('REDIS_URL');
  });
});
