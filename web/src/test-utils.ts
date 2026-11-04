import type { UsageRecord } from '@usage-metering/shared';

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    recordId: '3b241101-e2bb-4255-8caf-4136c566a962',
    customerId: 'acme',
    dimension: 'api_calls',
    quantity: 5,
    timestamp: '2026-01-02T03:04:05.000Z',
    ...overrides,
  };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
