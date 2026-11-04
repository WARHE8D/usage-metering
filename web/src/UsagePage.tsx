import { useState, type SubmitEvent } from 'react';
import type { ApiClient } from './api.js';
import { SubmitRecordForm } from './SubmitRecordForm.js';
import { REFRESH_INTERVAL_MS, useUsageRecords } from './useUsageRecords.js';

const timestampFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'UTC',
});

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${timestampFormat.format(date)} UTC`;
}

export interface UsagePageProps {
  client: ApiClient;
  refreshIntervalMs?: number;
}

export function UsagePage({ client, refreshIntervalMs = REFRESH_INTERVAL_MS }: UsagePageProps) {
  const [draft, setDraft] = useState('');
  const [customerId, setCustomerId] = useState('');
  const { records, error, loading, refresh } = useUsageRecords(
    client,
    customerId,
    refreshIntervalMs,
  );

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = draft.trim();
    if (next === '') return;
    if (next === customerId) {
      refresh();
    } else {
      setCustomerId(next);
    }
  }

  const showTable = records !== null && records.length > 0;

  return (
    <main>
      <h1>Usage records</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="customer-id">Customer ID</label>{' '}
        <input
          id="customer-id"
          value={draft}
          maxLength={64}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />{' '}
        <button type="submit" disabled={draft.trim() === ''}>
          Refresh
        </button>
      </form>

      <div role="status" aria-live="polite">
        {customerId === '' && <p>Enter a customer ID to see its usage records.</p>}
        {customerId !== '' && loading && <p>Loading usage records...</p>}
        {records !== null && records.length === 0 && !loading && (
          <p>No usage records for {customerId}</p>
        )}
      </div>
      {error !== null && <p role="alert">{error}</p>}

      {customerId !== '' && records !== null && (
        <div aria-busy={loading}>
          {showTable && (
            <table>
              <caption>Usage records for {customerId} (newest first)</caption>
              <thead>
                <tr>
                  <th scope="col">Timestamp</th>
                  <th scope="col">Dimension</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Record ID</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.recordId}>
                    <td>
                      <time dateTime={record.timestamp} title={record.timestamp}>
                        {formatTimestamp(record.timestamp)}
                      </time>
                    </td>
                    <td>{record.dimension}</td>
                    <td>{record.quantity}</td>
                    <td>{record.recordId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <SubmitRecordForm client={client} activeCustomerId={customerId} onAccepted={refresh} />
    </main>
  );
}
