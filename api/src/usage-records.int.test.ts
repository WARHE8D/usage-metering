import { randomUUID } from 'node:crypto';
import { StoredUsageRecordSchema, UsageRecordsResponseSchema } from '@usage-metering/shared';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiKeyChecker } from './auth.js';
import { createHealthCheck } from './health.js';
import { createIngestUsage } from './ingest.js';
import { createPgUsageReadRepository } from './pg-read-repository.js';
import { buildServer } from './server.js';
import { createListUsageRecords } from './usage-query.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const API_KEY = 'integration-test-key-0123';
const CUSTOMER = `it-${randomUUID()}`;
const OTHER_CUSTOMER = `it-${randomUUID()}`;

let pool: pg.Pool;
let app: FastifyInstance;

const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()] as const;
const insert = (recordId: string, customerId: string, quantity: string, occurredAt: string) =>
  pool.query(
    `INSERT INTO usage_records (record_id, customer_id, dimension, quantity, occurred_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [recordId, customerId, 'api_calls', quantity, occurredAt],
  );

const get = (query: string, headers: Record<string, string> = { 'x-api-key': API_KEY }) =>
  app.inject({ method: 'GET', url: `/usage/records${query}`, headers });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  app = buildServer({
    ingest: createIngestUsage({ queue: { add: () => Promise.reject(new Error('unused')) } }),
    listUsageRecords: createListUsageRecords({ repo: createPgUsageReadRepository(pool) }),
    checkApiKey: createApiKeyChecker(API_KEY),
    health: createHealthCheck({
      ping: () => Promise.resolve('PONG'),
      pingDb: () => pool.query('SELECT 1'),
      timeoutMs: 1000,
    }),
    config: { bodyLimitBytes: 16_384, corsOrigins: ['http://localhost:5173'] },
  });
  await insert(ids[0], CUSTOMER, '1.25', '2026-01-01T10:00:00Z');
  await insert(ids[1], CUSTOMER, '3', '2026-01-01T12:00:00.123Z');
  await insert(ids[2], CUSTOMER, '0.5', '2026-01-01T11:00:00Z');
  await insert(ids[3], OTHER_CUSTOMER, '9', '2026-01-01T13:00:00Z');
});

afterAll(async () => {
  await app.close();
  await pool.query('DELETE FROM usage_records WHERE customer_id = ANY($1)', [
    [CUSTOMER, OTHER_CUSTOMER],
  ]);
  await pool.end();
});

describe('GET /usage/records against real Postgres', () => {
  it('returns only this customer, newest first, exact quantities, ISO Z timestamps', async () => {
    const res = await get(`?customerId=${CUSTOMER}`);
    expect(res.statusCode).toBe(200);
    const body = UsageRecordsResponseSchema.parse(res.json());
    expect(body.records.map((r) => r.recordId)).toEqual([ids[1], ids[2], ids[0]]);
    expect(body.records.map((r) => r.quantity)).toEqual([3, 0.5, 1.25]);
    expect(body.records.map((r) => r.timestamp)).toEqual([
      '2026-01-01T12:00:00.123Z',
      '2026-01-01T11:00:00.000Z',
      '2026-01-01T10:00:00.000Z',
    ]);
    expect(body.records.every((r) => r.customerId === CUSTOMER)).toBe(true);
    for (const r of body.records) expect(StoredUsageRecordSchema.safeParse(r).success).toBe(true);
  });

  it('honours limit', async () => {
    const res = await get(`?customerId=${CUSTOMER}&limit=2`);
    const body = UsageRecordsResponseSchema.parse(res.json());
    expect(body.records.map((r) => r.recordId)).toEqual([ids[1], ids[2]]);
  });

  it('returns an empty list for an unknown customer', async () => {
    const res = await get(`?customerId=it-${randomUUID()}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ records: [] });
  });

  it('treats SQL metacharacters in customerId as data', async () => {
    const res = await get(`?customerId=${encodeURIComponent("x' OR '1'='1")}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ records: [] });
  });

  it('requires the API key and validates the query', async () => {
    expect((await get(`?customerId=${CUSTOMER}`, {})).statusCode).toBe(401);
    expect((await get('?limit=5')).statusCode).toBe(400);
  });

  it('reports postgres up in /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok', redis: 'up', postgres: 'up' });
  });
});
