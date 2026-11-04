import { describe, expect, it } from 'vitest';
import {
  createUsageRecordSchema,
  parseStoredUsageRecord,
  parseUsageRecord,
  UsageRecordSchema,
  type ParseUsageRecordResult,
} from './index.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const now = () => NOW;
const valid = {
  recordId: '3f8e2c1a-5b7d-4e6f-8a9b-0c1d2e3f4a5b',
  customerId: 'cust_1',
  dimension: 'api_calls',
  quantity: 5,
  timestamp: '2026-01-01T11:00:00Z',
};
const parse = (input: unknown) => parseUsageRecord(input, { now });
const errorsOf = (r: ParseUsageRecordResult) => (r.ok ? [] : r.errors);
const paths = (input: unknown) => errorsOf(parse(input)).map((e) => e.path);
const withField = (k: string, v: unknown) => ({ ...valid, [k]: v });
const plusMs = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe('parseUsageRecord', () => {
  it('accepts a valid record', () => {
    expect(parse(valid)).toEqual({ ok: true, data: valid });
  });

  it('narrows the discriminated union', () => {
    const r = parse(valid);
    if (r.ok) {
      expect(r.data.recordId).toBe(valid.recordId);
    } else {
      expect.unreachable();
    }
    const bad = parse(null);
    if (!bad.ok) {
      expect(Array.isArray(bad.errors)).toBe(true);
    } else {
      expect.unreachable();
    }
  });

  it.each(Object.keys(valid))('rejects missing %s', (key) => {
    const input = Object.fromEntries(Object.entries(valid).filter(([k]) => k !== key));
    expect(paths(input)).toEqual([key]);
  });

  it.each([
    ['recordId', 123],
    ['customerId', 42],
    ['dimension', {}],
    ['quantity', true],
    ['timestamp', 1700000000],
  ])('rejects wrong type for %s', (key, value) => {
    expect(paths(withField(key, value))).toEqual([key]);
  });

  it.each(['not-a-uuid', '', '3f8e2c1a-5b7d-4e6f-8a9b-0c1d2e3f4a5'])(
    'rejects invalid uuid %j',
    (v) => {
      expect(paths(withField('recordId', v))).toEqual(['recordId']);
    },
  );

  describe.each(['customerId', 'dimension'])('%s length', (key) => {
    it('rejects empty', () => {
      expect(paths(withField(key, ''))).toEqual([key]);
    });
    it('rejects 65 chars', () => {
      expect(paths(withField(key, 'a'.repeat(65)))).toEqual([key]);
    });
    it('accepts 64 chars', () => {
      expect(parse(withField(key, 'a'.repeat(64))).ok).toBe(true);
    });
    it('accepts 1 char', () => {
      expect(parse(withField(key, 'a')).ok).toBe(true);
    });
  });

  describe('quantity', () => {
    it.each([0, -1, -0.5, NaN, Infinity, -Infinity, '5', '1.5', null])('rejects %j', (v) => {
      expect(paths(withField('quantity', v))).toEqual(['quantity']);
    });
    it.each([0.000001, 0.1, 1, 1e9])('accepts %j', (v) => {
      expect(parse(withField('quantity', v)).ok).toBe(true);
    });
  });

  describe('timestamp', () => {
    it.each([
      '2026-01-01T11:00:00+02:00',
      '2026-01-01T11:00:00-05:00',
      '2026-01-01T11:00:00+00:00',
      '2026-01-01T11:00:00',
      '2026-01-01',
      'garbage',
      '',
      '2026-13-01T11:00:00Z',
    ])('rejects %j', (v) => {
      expect(paths(withField('timestamp', v))).toEqual(['timestamp']);
    });

    it('accepts fractional seconds in UTC', () => {
      expect(parse(withField('timestamp', '2026-01-01T11:00:00.123Z')).ok).toBe(true);
    });
    it('accepts exactly 5 minutes in the future', () => {
      expect(parse(withField('timestamp', plusMs(5 * 60 * 1000))).ok).toBe(true);
    });
    it('rejects just over 5 minutes in the future', () => {
      const r = parse(withField('timestamp', plusMs(5 * 60 * 1000 + 1)));
      expect(r.ok).toBe(false);
      expect(errorsOf(r)[0]?.path).toBe('timestamp');
      expect(errorsOf(r)[0]?.message).toMatch(/future/);
    });
    it('accepts past timestamps', () => {
      expect(parse(withField('timestamp', '2000-01-01T00:00:00Z')).ok).toBe(true);
    });
  });

  describe('strictness and non-objects', () => {
    it('rejects unknown keys', () => {
      const r = parse({ ...valid, extra: 1 });
      expect(r.ok).toBe(false);
      expect(errorsOf(r)).toHaveLength(1);
      expect(errorsOf(r)[0]?.message).toMatch(/extra/);
    });
    it.each([null, undefined, [], [valid], 'str', 42, true])('rejects non-object %j', (v) => {
      const r = parse(v);
      expect(r.ok).toBe(false);
      expect(errorsOf(r)).toHaveLength(1);
      expect(errorsOf(r)[0]?.path).toBe('');
    });
  });

  it('reports multiple errors at once with paths', () => {
    const input = { recordId: 'x', customerId: '', dimension: 1, quantity: -1, timestamp: 'nope' };
    expect(paths(input).sort()).toEqual([
      'customerId',
      'dimension',
      'quantity',
      'recordId',
      'timestamp',
    ]);
  });

  it('returns serializable errors', () => {
    const r = parse({});
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it('uses the real clock by default', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(parseUsageRecord({ ...valid, timestamp: future }).ok).toBe(false);
    expect(parseUsageRecord({ ...valid, timestamp: new Date().toISOString() }).ok).toBe(true);
  });
});

describe('schemas', () => {
  it('UsageRecordSchema is ready to use', () => {
    expect(UsageRecordSchema.safeParse(valid).success).toBe(true);
  });
  it('createUsageRecordSchema honours the injected clock', () => {
    const late = () => new Date('2030-01-01T00:00:00Z');
    const input = { ...valid, timestamp: '2029-12-31T23:59:00Z' };
    expect(createUsageRecordSchema(late).safeParse(input).success).toBe(true);
    expect(createUsageRecordSchema(now).safeParse(input).success).toBe(false);
  });
});

describe('parseStoredUsageRecord (worker side)', () => {
  it('accepts a timestamp far in the future, since the rule only applies at ingest', () => {
    const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    expect(parseStoredUsageRecord({ ...valid, timestamp: farFuture }).ok).toBe(true);
  });

  it('accepts a timestamp days in the past (backlog / late retry)', () => {
    expect(parseStoredUsageRecord({ ...valid, timestamp: '2020-01-01T00:00:00.000Z' }).ok).toBe(
      true,
    );
  });

  it('still applies every field rule', () => {
    const result = parseStoredUsageRecord({
      ...valid,
      recordId: 'nope',
      customerId: '',
      quantity: 0,
      timestamp: '2026-01-01T11:00:00+02:00',
      extra: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.path).sort()).toEqual([
        '',
        'customerId',
        'quantity',
        'recordId',
        'timestamp',
      ]);
    }
  });

  it.each([null, undefined, 'x', 1, []])('rejects non-object %j', (input) => {
    expect(parseStoredUsageRecord(input).ok).toBe(false);
  });
});
