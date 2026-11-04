import { StoredUsageRecordSchema, type UsageRecord } from '@usage-metering/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { createApiKeyChecker } from './auth.js';
import type { HealthStatus } from './health.js';
import { createIngestUsage, type UsageQueue } from './ingest.js';
import { createListUsageRecords, type UsageReadRepository } from './usage-query.js';

const API_KEY = 'test-api-key-0123456789';
const ALLOWED_ORIGIN = 'http://localhost:5173';
const NOW = new Date('2026-01-01T12:00:00.000Z');

const validRecord = {
  recordId: '0b7e4c7e-6f7a-4d3e-9a51-3f2c1b8d9e10',
  customerId: 'cust_42',
  dimension: 'api_calls',
  quantity: 3,
  timestamp: '2026-01-01T11:59:00.000Z',
};

interface Harness {
  app: FastifyInstance;
  added: string[];
  listCalls: { customerId: string; limit: number }[];
}

let current: FastifyInstance | undefined;

const storedRecords: UsageRecord[] = [
  { ...validRecord, recordId: '11111111-1111-4111-8111-111111111111', quantity: 2.5 },
  { ...validRecord, recordId: '22222222-2222-4222-8222-222222222222' },
];

function setup(
  opts: {
    queueFails?: boolean;
    dbFails?: boolean;
    health?: HealthStatus;
    healthThrows?: boolean;
  } = {},
): Harness {
  const listCalls: { customerId: string; limit: number }[] = [];
  const repo: UsageReadRepository = {
    listByCustomer(customerId, limit) {
      listCalls.push({ customerId, limit });
      return opts.dbFails
        ? Promise.reject(new Error('pg down: secret internals'))
        : Promise.resolve(storedRecords);
    },
  };
  const added: string[] = [];
  const queue: UsageQueue = {
    add(_name, data) {
      added.push(data.recordId);
      return opts.queueFails
        ? Promise.reject(new Error('redis down: secret internals'))
        : Promise.resolve(undefined);
    },
  };
  const app = buildServer({
    ingest: createIngestUsage({ queue, now: () => NOW }),
    listUsageRecords: createListUsageRecords({ repo }),
    checkApiKey: createApiKeyChecker(API_KEY),
    health: () =>
      opts.healthThrows
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(opts.health ?? { ok: true, redis: 'up', postgres: 'up' }),
    config: { bodyLimitBytes: 1024, corsOrigins: [ALLOWED_ORIGIN] },
  });
  current = app;
  return { app, added, listCalls };
}

afterEach(async () => {
  await current?.close();
  current = undefined;
});

const postUsage = (app: FastifyInstance, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/usage',
    headers: { 'x-api-key': API_KEY, ...headers },
    payload: body as Record<string, unknown>,
  });

function expectNoStack(body: string): void {
  expect(body).not.toMatch(/\bat .+:\d+:\d+/);
  expect(body).not.toContain('"stack"');
}

describe('POST /usage', () => {
  it('accepts a valid record with 202 and enqueues it', async () => {
    const { app, added } = setup();
    const res = await postUsage(app, validRecord);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted', recordId: validRecord.recordId });
    expect(added).toEqual([validRecord.recordId]);
  });

  it('returns 202 for the same record twice (dedupe is the queue/DB concern)', async () => {
    const { app } = setup();
    const first = await postUsage(app, validRecord);
    const second = await postUsage(app, validRecord);
    expect([first.statusCode, second.statusCode]).toEqual([202, 202]);
    expect(second.json()).toEqual(first.json());
  });

  it.each([
    ['missing', {}],
    ['wrong', { 'x-api-key': 'not-the-right-key-at-all' }],
    ['empty', { 'x-api-key': '' }],
  ])('rejects a %s API key with 401 and does not enqueue', async (_label, headers) => {
    const { app, added } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/usage',
      headers,
      payload: validRecord,
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('ApiKey');
    expect(res.json()).toEqual({ error: 'unauthorized', message: 'Missing or invalid API key' });
    expect(added).toHaveLength(0);
  });

  it('checks the API key before the body (401 wins over malformed JSON)', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/usage',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 with field errors for an invalid record', async () => {
    const { app, added } = setup();
    const res = await postUsage(app, { ...validRecord, quantity: 0, customerId: '' });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; errors: { path: string; message: string }[] }>();
    expect(body.error).toBe('validation_failed');
    expect(body.errors.map((e) => e.path).sort()).toEqual(['customerId', 'quantity']);
    expect(added).toHaveLength(0);
  });

  it('returns 400 for malformed JSON', async () => {
    const { app } = setup();
    const res = await postUsage(app, '{"recordId":', { 'content-type': 'application/json' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('bad_request');
    expectNoStack(res.body);
  });

  it('returns 400 for an empty JSON body', async () => {
    const { app } = setup();
    const res = await postUsage(app, '', { 'content-type': 'application/json' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 415 for non-JSON content types', async () => {
    const { app, added } = setup();
    const res = await postUsage(app, 'hello', { 'content-type': 'text/plain' });
    expect(res.statusCode).toBe(415);
    expect(res.json<{ error: string }>().error).toBe('unsupported_media_type');
    expect(added).toHaveLength(0);
  });

  it('returns 413 for a body over the limit', async () => {
    const { app, added } = setup();
    const res = await postUsage(app, { ...validRecord, dimension: 'x'.repeat(2000) });
    expect(res.statusCode).toBe(413);
    expect(res.json<{ error: string }>().error).toBe('payload_too_large');
    expect(added).toHaveLength(0);
  });

  it('returns 503 with Retry-After and no internals when the queue is unavailable', async () => {
    const { app } = setup({ queueFails: true });
    const res = await postUsage(app, validRecord);
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json()).toEqual({
      error: 'queue_unavailable',
      message: 'Queue unavailable, retry later',
    });
    expect(res.body).not.toContain('secret internals');
  });
});

const getRecords = (app: FastifyInstance, query: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url: `/usage/records${query}`,
    headers: { 'x-api-key': API_KEY, ...headers },
  });

describe('GET /usage/records', () => {
  it('returns 200 with records that match the shared schema', async () => {
    const { app, listCalls } = setup();
    const res = await getRecords(app, '?customerId=cust_42&limit=2');
    expect(res.statusCode).toBe(200);
    const body = res.json<{ records: unknown[] }>();
    expect(body).toEqual({ records: storedRecords });
    for (const r of body.records) {
      expect(StoredUsageRecordSchema.safeParse(r).success).toBe(true);
    }
    expect(listCalls).toEqual([{ customerId: 'cust_42', limit: 2 }]);
  });

  it('defaults limit to 100', async () => {
    const { app, listCalls } = setup();
    await getRecords(app, '?customerId=cust_42');
    expect(listCalls).toEqual([{ customerId: 'cust_42', limit: 100 }]);
  });

  it.each([
    '',
    '?customerId=',
    '?customerId=c&limit=0',
    '?customerId=c&limit=501',
    '?customerId=c&x=1',
  ])('returns 400 validation_failed for %j', async (query) => {
    const { app, listCalls } = setup();
    const res = await getRecords(app, query);
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; errors: { path: string; message: string }[] }>();
    expect(body.error).toBe('validation_failed');
    expect(body.errors.length).toBeGreaterThan(0);
    expect(Object.keys(body.errors[0] ?? {}).sort()).toEqual(['message', 'path']);
    expect(listCalls).toHaveLength(0);
  });

  it.each([
    ['missing', {}],
    ['wrong', { 'x-api-key': 'not-the-right-key-at-all' }],
  ])('rejects a %s API key with 401 and does not query', async (_label, headers) => {
    const { app, listCalls } = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/usage/records?customerId=cust_42',
      headers,
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('ApiKey');
    expect(listCalls).toHaveLength(0);
  });

  it('returns 503 with Retry-After and no internals when the database fails', async () => {
    const { app } = setup({ dbFails: true });
    const res = await getRecords(app, '?customerId=cust_42');
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json()).toEqual({
      error: 'database_unavailable',
      message: 'Database unavailable, retry later',
    });
    expect(res.body).not.toContain('secret internals');
  });

  it('adds CORS headers for the allowed origin on success, 401, 400 and 503', async () => {
    const origin = { origin: ALLOWED_ORIGIN };
    const ok = await getRecords(setup().app, '?customerId=c', origin);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    const bad = await getRecords(setup().app, '', origin);
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    const down = await getRecords(setup({ dbFails: true }).app, '?customerId=c', origin);
    expect(down.statusCode).toBe(503);
    expect(down.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    const unauth = await setup().app.inject({
      method: 'GET',
      url: '/usage/records?customerId=c',
      headers: origin,
    });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });

  it('answers a GET preflight from the allowed origin without an API key', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/usage/records',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-api-key',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });
});

describe('GET /health', () => {
  it('returns 200 without an API key when Redis and Postgres are up', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', redis: 'up', postgres: 'up' });
  });

  it('returns 503 when Redis is down', async () => {
    const { app } = setup({ health: { ok: false, redis: 'down', postgres: 'up' } });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', redis: 'down', postgres: 'up' });
  });

  it('returns 503 when Postgres is down', async () => {
    const { app } = setup({ health: { ok: false, redis: 'up', postgres: 'down' } });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', redis: 'up', postgres: 'down' });
  });

  it('returns a generic 500 without a stack if the health check itself throws', async () => {
    const { app } = setup({ healthThrows: true });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error', message: 'Internal Server Error' });
    expectNoStack(res.body);
  });
});

describe('unknown routes', () => {
  it('returns a JSON 404', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', message: 'Route GET /nope not found' });
  });
});

describe('CORS', () => {
  const ACAO = 'access-control-allow-origin';

  it('answers a preflight without an API key and allows x-api-key', async () => {
    const { app, added } = setup();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/usage',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-api-key',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers[ACAO]).toBe(ALLOWED_ORIGIN);
    const allowHeaders = String(res.headers['access-control-allow-headers']).toLowerCase();
    expect(allowHeaders).toContain('x-api-key');
    expect(allowHeaders).toContain('content-type');
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(added).toHaveLength(0);
  });

  it('adds allow-origin to a successful POST from an allowed origin', async () => {
    const { app } = setup();
    const res = await postUsage(app, validRecord, { origin: ALLOWED_ORIGIN });
    expect(res.statusCode).toBe(202);
    expect(res.headers[ACAO]).toBe(ALLOWED_ORIGIN);
  });

  it('does not set allow-origin for a disallowed origin (no reflection, no wildcard)', async () => {
    const { app } = setup();
    const res = await postUsage(app, validRecord, { origin: 'http://evil.example' });
    expect(res.headers[ACAO]).toBeUndefined();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/usage',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers[ACAO]).toBeUndefined();
  });

  it('keeps allow-origin on a 401 for an allowed origin and still enforces the key', async () => {
    const { app, added } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/usage',
      headers: { origin: ALLOWED_ORIGIN },
      payload: validRecord,
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers[ACAO]).toBe(ALLOWED_ORIGIN);
    expect(added).toHaveLength(0);
  });

  it('keeps allow-origin on 400 and 503 responses for an allowed origin', async () => {
    const bad = await postUsage(
      setup().app,
      { ...validRecord, quantity: 0 },
      { origin: ALLOWED_ORIGIN },
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.headers[ACAO]).toBe(ALLOWED_ORIGIN);
    const down = await postUsage(setup({ queueFails: true }).app, validRecord, {
      origin: ALLOWED_ORIGIN,
    });
    expect(down.statusCode).toBe(503);
    expect(down.headers[ACAO]).toBe(ALLOWED_ORIGIN);
  });
});
