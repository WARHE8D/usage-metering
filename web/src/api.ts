import {
  UsageRecordsResponseSchema,
  type UsageRecord,
  type UsageRecordError,
} from '@usage-metering/shared';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
}

export type ApiErrorKind =
  'validation' | 'unauthorized' | 'unavailable' | 'network' | 'bad_response' | 'http';

/** Error with a message that is safe to show to the user. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  readonly errors: UsageRecordError[];

  constructor(
    kind: ApiErrorKind,
    message: string,
    options: { status?: number; errors?: UsageRecordError[] } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = options.status;
    this.errors = options.errors ?? [];
  }
}

export interface ListOptions {
  limit?: number;
  signal?: AbortSignal;
}

export interface ApiClient {
  listRecords(customerId: string, options?: ListOptions): Promise<UsageRecord[]>;
  submitRecord(record: UsageRecord, signal?: AbortSignal): Promise<{ recordId: string }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readFieldErrors(body: unknown): UsageRecordError[] {
  if (!isObject(body) || !Array.isArray(body.errors)) return [];
  const out: UsageRecordError[] = [];
  for (const item of body.errors as unknown[]) {
    if (isObject(item) && typeof item.message === 'string') {
      out.push({ path: typeof item.path === 'string' ? item.path : '', message: item.message });
    }
  }
  return out;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function formatFieldErrors(errors: UsageRecordError[]): string {
  return errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ');
}

/** Maps a non-success response to an ApiError with a readable message. */
async function toApiError(response: Response): Promise<ApiError> {
  const body = await readJson(response);
  const apiMessage = isObject(body) && typeof body.message === 'string' ? body.message : undefined;
  const status = response.status;
  if (status === 400) {
    const errors = readFieldErrors(body);
    const detail =
      errors.length > 0 ? formatFieldErrors(errors) : (apiMessage ?? 'invalid request');
    return new ApiError('validation', `The request was rejected (400): ${detail}`, {
      status,
      errors,
    });
  }
  if (status === 401) {
    return new ApiError(
      'unauthorized',
      `Unauthorized (401): ${apiMessage ?? 'check VITE_API_KEY'}`,
      {
        status,
      },
    );
  }
  if (status === 503) {
    return new ApiError(
      'unavailable',
      `Service unavailable (503): ${apiMessage ?? 'try again shortly'}`,
      { status },
    );
  }
  return new ApiError(
    'http',
    `Unexpected response from the API (${String(status)}): ${apiMessage ?? response.statusText}`,
    { status },
  );
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const headers = { 'x-api-key': options.apiKey };

  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await options.fetch(url, init);
    } catch (cause) {
      // Let callers recognise their own cancellation.
      if (init.signal?.aborted) throw cause;
      const reason = cause instanceof Error ? cause.message : 'unknown error';
      throw new ApiError('network', `Could not reach the API: ${reason}`);
    }
  }

  return {
    async listRecords(customerId, { limit, signal }: ListOptions = {}) {
      const params = new URLSearchParams({ customerId });
      if (limit !== undefined) params.set('limit', String(limit));
      const init: RequestInit = { method: 'GET', headers };
      if (signal) init.signal = signal;
      const response = await send(`${base}/usage/records?${params.toString()}`, init);
      if (!response.ok) throw await toApiError(response);
      const parsed = UsageRecordsResponseSchema.safeParse(await readJson(response));
      if (!parsed.success) {
        throw new ApiError('bad_response', 'The API returned data in an unexpected format.', {
          status: response.status,
        });
      }
      return parsed.data.records;
    },

    async submitRecord(record, signal) {
      const init: RequestInit = {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(record),
      };
      if (signal) init.signal = signal;
      const response = await send(`${base}/usage`, init);
      if (response.status !== 202) throw await toApiError(response);
      const body = await readJson(response);
      const recordId =
        isObject(body) && typeof body.recordId === 'string' ? body.recordId : record.recordId;
      return { recordId };
    },
  };
}
