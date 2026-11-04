import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageRecord } from '@usage-metering/shared';
import type { ApiClient } from './api.js';

export const REFRESH_INTERVAL_MS = 10_000;

interface State {
  /** Customer these values belong to; values for another customer are ignored. */
  customerId: string;
  records: UsageRecord[] | null;
  error: string | null;
  loading: boolean;
}

export interface UsageRecordsView {
  records: UsageRecord[] | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Loads records for a customer and re-polls every `intervalMs` while customerId is set.
 * Each load aborts the previous one, and a result is applied only if its request was
 * not aborted, so stale responses (old customer, overlapping refreshes) are dropped.
 */
export function useUsageRecords(
  client: ApiClient,
  customerId: string,
  intervalMs: number = REFRESH_INTERVAL_MS,
): UsageRecordsView {
  const [state, setState] = useState<State>({
    customerId: '',
    records: null,
    error: null,
    loading: false,
  });
  const controllerRef = useRef<AbortController | null>(null);

  // Starts a request, aborting the previous one. Only async callbacks call setState here.
  const fetchRecords = useCallback(() => {
    if (!customerId) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    client
      .listRecords(customerId, { signal: controller.signal })
      .then((records) => {
        if (controller.signal.aborted) return;
        setState({ customerId, records, error: null, loading: false });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const error = cause instanceof Error ? cause.message : 'Something went wrong.';
        setState((prev) => ({ ...prev, customerId, error, loading: false }));
      });
  }, [client, customerId]);

  // Background/manual refresh: flags loading (keeping current rows), then fetches.
  const refresh = useCallback(() => {
    if (!customerId) return;
    setState((prev) => {
      const same = prev.customerId === customerId;
      return {
        customerId,
        records: same ? prev.records : null,
        error: same ? prev.error : null,
        loading: true,
      };
    });
    fetchRecords();
  }, [customerId, fetchRecords]);

  useEffect(() => {
    if (!customerId) return undefined;
    // The first load of a customer needs no setState: `loading` is derived below
    // because there is no state for this customer yet.
    fetchRecords();
    const timer = setInterval(refresh, intervalMs);
    return () => {
      clearInterval(timer);
      controllerRef.current?.abort();
    };
  }, [customerId, intervalMs, fetchRecords, refresh]);

  const current = customerId !== '' && state.customerId === customerId;
  return {
    records: current ? state.records : null,
    error: current ? state.error : null,
    // True until the first result for this customer arrives (covers the initial fetch).
    loading: customerId !== '' && (!current || state.loading),
    refresh,
  };
}
