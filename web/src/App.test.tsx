import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from './api.js';
import { App } from './App.js';
import { deferred, jsonResponse, makeRecord } from './test-utils.js';

const ENV = { VITE_API_URL: 'http://api.test', VITE_API_KEY: 'k-123' };

type Handler = (url: URL, init: RequestInit | undefined) => Promise<Response> | Response;

function makeFetch(handler: Handler) {
  return vi.fn<FetchLike>((input, init) => Promise.resolve(handler(new URL(input), init)));
}

function recordsFetch(byCustomer: Record<string, ReturnType<typeof makeRecord>[]>) {
  return makeFetch((url) =>
    jsonResponse(200, { records: byCustomer[url.searchParams.get('customerId') ?? ''] ?? [] }),
  );
}

function listCalls(fetchMock: ReturnType<typeof makeFetch>) {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'GET');
}

function renderApp(fetchImpl: FetchLike, props: { refreshIntervalMs?: number } = {}) {
  return render(<App env={ENV} fetchImpl={fetchImpl} {...props} />);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function firstDefined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

function enterCustomer(id: string) {
  fireEvent.change(screen.getByLabelText('Customer ID'), { target: { value: id } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('App configuration', () => {
  it('renders a configuration error instead of the page when env is missing', () => {
    const fetchMock = makeFetch(() => jsonResponse(200, { records: [] }));
    render(<App env={{ VITE_API_URL: 'http://api.test' }} fetchImpl={fetchMock} />);
    expect(screen.getByRole('heading', { name: 'Configuration error' })).toBeDefined();
    expect(screen.getByRole('alert').textContent).toContain('VITE_API_KEY');
    expect(screen.queryByLabelText('Customer ID')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('usage page', () => {
  it('shows an idle state and does not fetch without a customer ID', () => {
    const fetchMock = recordsFetch({});
    renderApp(fetchMock);
    expect(screen.getByText('Enter a customer ID to see its usage records.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(true);
    fireEvent.submit(
      firstDefined(screen.getByLabelText('Customer ID').closest('form') ?? undefined),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows loading, then rows in column order, sending the API key', async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn<FetchLike>(() => pending.promise);
    renderApp(fetchMock);
    enterCustomer('acme');
    expect(screen.getByText('Loading usage records...')).toBeDefined();

    const record = makeRecord({ quantity: 12.5 });
    pending.resolve(jsonResponse(200, { records: [record] }));

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Usage records for acme (newest first)')).toBeDefined();
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Timestamp', 'Dimension', 'Quantity', 'Record ID']);
    const cells = within(firstDefined(within(table).getAllByRole('row')[1]))
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells).toEqual(['2 Jan 2026, 03:04:05 UTC', 'api_calls', '12.5', record.recordId]);
    const time = table.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe(record.timestamp);
    expect(time?.getAttribute('title')).toBe(record.timestamp);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://api.test/usage/records?customerId=acme');
    expect(new Headers(init?.headers).get('x-api-key')).toBe('k-123');
    expect(screen.queryByText('Loading usage records...')).toBeNull();
  });

  it('shows the empty state', async () => {
    renderApp(recordsFetch({}));
    enterCustomer('ghost');
    expect(await screen.findByText('No usage records for ghost')).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the API error message', async () => {
    renderApp(
      makeFetch(() =>
        jsonResponse(401, { error: 'unauthorized', message: 'Missing or invalid API key' }),
      ),
    );
    enterCustomer('acme');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Missing or invalid API key');
  });

  it('shows a network failure message', async () => {
    renderApp(vi.fn<FetchLike>(() => Promise.reject(new TypeError('Failed to fetch'))));
    enterCustomer('acme');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not reach the API: Failed to fetch',
    );
  });

  it('refetches when Refresh is clicked again for the same customer', async () => {
    const fetchMock = recordsFetch({ acme: [makeRecord()] });
    renderApp(fetchMock);
    enterCustomer('acme');
    await screen.findByRole('table');
    expect(listCalls(fetchMock)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await flush();
    expect(listCalls(fetchMock)).toHaveLength(2);
  });

  it('ignores a stale response after the customer ID changes', async () => {
    const first = deferred<Response>();
    const fetchMock = makeFetch((url) =>
      jsonResponse(200, {
        records: [
          makeRecord({
            customerId: url.searchParams.get('customerId') ?? '',
            dimension: 'beta_dim',
          }),
        ],
      }),
    );
    fetchMock.mockImplementationOnce(() => first.promise);
    renderApp(fetchMock);
    enterCustomer('alpha');
    enterCustomer('beta');
    expect(await screen.findByText('beta_dim')).toBeDefined();

    await act(async () => {
      await Promise.resolve();
      first.resolve(
        jsonResponse(200, {
          records: [makeRecord({ customerId: 'alpha', dimension: 'alpha_dim' })],
        }),
      );
    });
    expect(screen.queryByText('alpha_dim')).toBeNull();
    expect(screen.getByText('beta_dim')).toBeDefined();
    expect(screen.getByRole('table').querySelector('caption')?.textContent).toContain('beta');
  });
});

describe('usage page auto-refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('refetches every 10 seconds and stops after unmount', async () => {
    const fetchMock = recordsFetch({ acme: [makeRecord()] });
    const view = renderApp(fetchMock);
    enterCustomer('acme');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(listCalls(fetchMock)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999);
    });
    expect(listCalls(fetchMock)).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(listCalls(fetchMock)).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(listCalls(fetchMock)).toHaveLength(3);

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(listCalls(fetchMock)).toHaveLength(3);
  });

  it('keeps the last data visible and shows the error when a background refresh fails', async () => {
    let fail = false;
    const fetchMock = makeFetch(() =>
      fail
        ? jsonResponse(503, {
            error: 'database_unavailable',
            message: 'Database unavailable, retry later',
          })
        : jsonResponse(200, { records: [makeRecord({ dimension: 'kept_dim' })] }),
    );
    renderApp(fetchMock);
    enterCustomer('acme');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('kept_dim')).toBeDefined();

    fail = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText('kept_dim')).toBeDefined();
    expect(screen.getByRole('alert').textContent).toContain('Database unavailable, retry later');

    fail = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps rows visible while a background refresh is loading', async () => {
    const slow = deferred<Response>();
    const fetchMock = makeFetch(() => jsonResponse(200, { records: [makeRecord()] }));
    renderApp(fetchMock);
    enterCustomer('acme');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fetchMock.mockImplementationOnce(() => slow.promise);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByRole('table')).toBeDefined();
    expect(screen.getByRole('table').parentElement?.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      await Promise.resolve();
      slow.resolve(jsonResponse(200, { records: [makeRecord()] }));
    });
    expect(screen.getByRole('table').parentElement?.getAttribute('aria-busy')).toBe('false');
  });
});

describe('submit test record form', () => {
  function postCalls(fetchMock: ReturnType<typeof makeFetch>) {
    return fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
  }

  it('blocks the POST and shows field errors when the input is invalid', async () => {
    const fetchMock = recordsFetch({});
    renderApp(fetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'Submit record' }));
    await flush();
    expect(postCalls(fetchMock)).toHaveLength(0);
    expect(document.getElementById('submit-customer')?.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById('submit-customerId-error')).not.toBeNull();
    expect(document.getElementById('submit-dimension-error')).not.toBeNull();
  });

  it('posts the record, shows the recordId, and refetches the list', async () => {
    const fetchMock = makeFetch((url, init) =>
      init?.method === 'POST'
        ? jsonResponse(202, { status: 'accepted', recordId: 'ignored-by-test' })
        : jsonResponse(200, { records: [] }),
    );
    renderApp(fetchMock);
    enterCustomer('acme');
    await screen.findByText('No usage records for acme');
    expect(screen.getByLabelText<HTMLInputElement>('Record customer ID').value).toBe('acme');

    fireEvent.change(screen.getByLabelText('Dimension'), { target: { value: 'gb_stored' } });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit record' }));

    expect(await screen.findByText(/Record ignored-by-test accepted/)).toBeDefined();
    expect(screen.getByText(/may only appear on the next refresh/)).toBeDefined();

    const [url, init] = postCalls(fetchMock)[0] ?? [];
    expect(url).toBe('http://api.test/usage');
    expect(new Headers(init?.headers).get('x-api-key')).toBe('k-123');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ customerId: 'acme', dimension: 'gb_stored', quantity: 3 });
    expect(typeof body.recordId).toBe('string');
    expect(Number.isNaN(Date.parse(String(body.timestamp)))).toBe(false);
    expect(listCalls(fetchMock).length).toBe(2);
  });

  it('displays server 400 errors', async () => {
    const fetchMock = makeFetch((url, init) =>
      init?.method === 'POST'
        ? jsonResponse(400, {
            error: 'validation_failed',
            errors: [{ path: 'dimension', message: 'Rejected by server' }],
          })
        : jsonResponse(200, { records: [] }),
    );
    renderApp(fetchMock);
    fireEvent.change(screen.getByLabelText('Record customer ID'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText('Dimension'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit record' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('dimension: Rejected by server');
    expect(document.getElementById('submit-dimension-error')?.textContent).toBe(
      'Rejected by server',
    );
    expect(screen.queryByText(/accepted/)).toBeNull();
  });
});
