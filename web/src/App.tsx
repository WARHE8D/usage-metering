import { useMemo } from 'react';
import { createApiClient, type FetchLike } from './api.js';
import { loadConfig } from './config.js';
import { UsagePage } from './UsagePage.js';

export interface AppProps {
  env?: { VITE_API_URL?: string | undefined; VITE_API_KEY?: string | undefined };
  fetchImpl?: FetchLike;
  refreshIntervalMs?: number;
}

const browserFetch: FetchLike = (input, init) => fetch(input, init);

export function App({
  env = import.meta.env,
  fetchImpl = browserFetch,
  refreshIntervalMs,
}: AppProps) {
  const result = useMemo(() => loadConfig(env), [env]);
  const client = useMemo(
    () =>
      result.ok
        ? createApiClient({
            baseUrl: result.config.apiUrl,
            apiKey: result.config.apiKey,
            fetch: fetchImpl,
          })
        : null,
    [result, fetchImpl],
  );

  if (!result.ok || client === null) {
    return (
      <main>
        <h1>Configuration error</h1>
        <div role="alert">
          <p>The app is not configured. Copy web/.env.example to web/.env and set:</p>
          <ul>
            {(result.ok ? [] : result.errors).map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      </main>
    );
  }
  return refreshIntervalMs === undefined ? (
    <UsagePage client={client} />
  ) : (
    <UsagePage client={client} refreshIntervalMs={refreshIntervalMs} />
  );
}
