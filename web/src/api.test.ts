import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, type FetchLike } from './api.js';
import { jsonResponse, makeRecord } from './test-utils.js';

function setup(impl: FetchLike) {
  const fetchMock = vi.fn<FetchLike>(impl);
  const client = createApiClient({
    baseUrl: 'http://api.test/',
    apiKey: 'k-123',
    fetch: fetchMock,
  });
  return { client, fetchMock };
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected rejection');
}

describe('api client: listRecords', () => {
  it('builds the URL with encoded customerId and limit and sends x-api-key', async () => {
    const { client, fetchMock } = setup(() => Promise.resolve(jsonResponse(200, { records: [] })));
    await client.listRecords('a b&c/d', { limit: 25 });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://api.test/usage/records?customerId=a+b%26c%2Fd&limit=25');
    expect(init?.method).toBe('GET');
    expect(headerOf(init, 'x-api-key')).toBe('k-123');
  });

  it('omits limit when not given', async () => {
    const { client, fetchMock } = setup(() => Promise.resolve(jsonResponse(200, { records: [] })));
    await client.listRecords('acme');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://api.test/usage/records?customerId=acme');
  });

  it('returns records from a valid body', async () => {
    const record = makeRecord();
    const { client } = setup(() => Promise.resolve(jsonResponse(200, { records: [record] })));
    await expect(client.listRecords('acme')).resolves.toEqual([record]);
  });

  it('rejects a body that does not match the schema', async () => {
    const { client } = setup(() =>
      Promise.resolve(jsonResponse(200, { records: [{ recordId: 'nope' }] })),
    );
    const error = await rejection(client.listRecords('acme'));
    expect(error.kind).toBe('bad_response');
    expect(error.message).toMatch(/unexpected format/);
  });

  it('maps 400 to a readable validation error with field errors', async () => {
    const errors = [{ path: 'limit', message: 'Too big' }];
    const { client } = setup(() =>
      Promise.resolve(jsonResponse(400, { error: 'validation_failed', errors })),
    );
    const error = await rejection(client.listRecords('acme'));
    expect(error.kind).toBe('validation');
    expect(error.message).toContain('limit: Too big');
    expect(error.errors).toEqual(errors);
  });

  it('maps 401 to an unauthorized error using the API message', async () => {
    const { client } = setup(() =>
      Promise.resolve(
        jsonResponse(401, { error: 'unauthorized', message: 'Missing or invalid API key' }),
      ),
    );
    const error = await rejection(client.listRecords('acme'));
    expect(error.kind).toBe('unauthorized');
    expect(error.message).toContain('Missing or invalid API key');
  });

  it('maps 503 to an unavailable error', async () => {
    const { client } = setup(() =>
      Promise.resolve(
        jsonResponse(503, {
          error: 'database_unavailable',
          message: 'Database unavailable, retry later',
        }),
      ),
    );
    const error = await rejection(client.listRecords('acme'));
    expect(error.kind).toBe('unavailable');
    expect(error.message).toContain('Database unavailable, retry later');
  });

  it('maps a network failure to a readable error', async () => {
    const { client } = setup(() => Promise.reject(new TypeError('Failed to fetch')));
    const error = await rejection(client.listRecords('acme'));
    expect(error.kind).toBe('network');
    expect(error.message).toBe('Could not reach the API: Failed to fetch');
  });

  it('rethrows the original error when the caller aborted', async () => {
    const controller = new AbortController();
    const abortError = new DOMException('aborted', 'AbortError');
    const { client } = setup(() => {
      controller.abort();
      return Promise.reject(abortError);
    });
    await expect(client.listRecords('acme', { signal: controller.signal })).rejects.toBe(
      abortError,
    );
  });
});

describe('api client: submitRecord', () => {
  it('POSTs the record as JSON with x-api-key and returns the recordId on 202', async () => {
    const record = makeRecord();
    const { client, fetchMock } = setup(() =>
      Promise.resolve(jsonResponse(202, { status: 'accepted', recordId: record.recordId })),
    );
    await expect(client.submitRecord(record)).resolves.toEqual({ recordId: record.recordId });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://api.test/usage');
    expect(init?.method).toBe('POST');
    expect(headerOf(init, 'x-api-key')).toBe('k-123');
    expect(headerOf(init, 'content-type')).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual(record);
  });

  it('maps 400 to a validation error carrying the server field errors', async () => {
    const errors = [{ path: 'dimension', message: 'Too small' }];
    const { client } = setup(() =>
      Promise.resolve(jsonResponse(400, { error: 'validation_failed', errors })),
    );
    const error = await rejection(client.submitRecord(makeRecord()));
    expect(error.kind).toBe('validation');
    expect(error.errors).toEqual(errors);
    expect(error.message).toContain('dimension: Too small');
  });
});
