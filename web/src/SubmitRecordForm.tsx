import { useState, type SubmitEvent } from 'react';
import { parseUsageRecord, type UsageRecordError } from '@usage-metering/shared';
import { ApiError, type ApiClient } from './api.js';

export interface SubmitRecordFormProps {
  client: ApiClient;
  /** Customer currently shown in the page; used as the default customer. */
  activeCustomerId: string;
  /** Called after the API accepted a record (202). */
  onAccepted: () => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; recordId: string }
  | { kind: 'error'; message: string };

const FIELDS = ['customerId', 'dimension', 'quantity'] as const;
type Field = (typeof FIELDS)[number];

function isField(path: string): path is Field {
  return (FIELDS as readonly string[]).includes(path);
}

function groupErrors(errors: UsageRecordError[]): {
  byField: Partial<Record<Field, string[]>>;
  general: string[];
} {
  const byField: Partial<Record<Field, string[]>> = {};
  const general: string[] = [];
  for (const { path, message } of errors) {
    if (isField(path)) {
      byField[path] = [...(byField[path] ?? []), message];
    } else {
      general.push(path ? `${path}: ${message}` : message);
    }
  }
  return { byField, general };
}

export function SubmitRecordForm({ client, activeCustomerId, onAccepted }: SubmitRecordFormProps) {
  // null = follow the page's customer; a string = the user edited this field.
  const [customerOverride, setCustomerOverride] = useState<string | null>(null);
  const [dimension, setDimension] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [fieldErrors, setFieldErrors] = useState<UsageRecordError[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const customerId = customerOverride ?? activeCustomerId;
  const { byField, general } = groupErrors(fieldErrors);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status.kind === 'submitting') return;
    const candidate = {
      recordId: crypto.randomUUID(),
      customerId,
      dimension,
      quantity: quantity.trim() === '' ? undefined : Number(quantity),
      timestamp: new Date().toISOString(),
    };
    const parsed = parseUsageRecord(candidate);
    if (!parsed.ok) {
      setFieldErrors(parsed.errors);
      setStatus({ kind: 'idle' });
      return;
    }
    setFieldErrors([]);
    setStatus({ kind: 'submitting' });
    try {
      const { recordId } = await client.submitRecord(parsed.data);
      setStatus({ kind: 'success', recordId });
      onAccepted();
    } catch (cause) {
      if (cause instanceof ApiError && cause.errors.length > 0) {
        setFieldErrors(cause.errors);
      }
      setStatus({
        kind: 'error',
        message: cause instanceof Error ? cause.message : 'Submitting the record failed.',
      });
    }
  }

  function fieldError(field: Field) {
    const messages = byField[field];
    if (!messages) return null;
    return (
      <span id={`submit-${field}-error`} className="field-error">
        {messages.join('; ')}
      </span>
    );
  }

  function describedBy(field: Field) {
    return byField[field] ? `submit-${field}-error` : undefined;
  }

  return (
    <section aria-labelledby="submit-heading">
      <h2 id="submit-heading">Submit test record</h2>
      <form onSubmit={(event) => void handleSubmit(event)} noValidate>
        <p>
          <label htmlFor="submit-customer">Record customer ID</label>{' '}
          <input
            id="submit-customer"
            value={customerId}
            onChange={(event) => {
              setCustomerOverride(event.target.value);
            }}
            aria-invalid={byField.customerId ? true : undefined}
            aria-describedby={describedBy('customerId')}
          />{' '}
          {fieldError('customerId')}
        </p>
        <p>
          <label htmlFor="submit-dimension">Dimension</label>{' '}
          <input
            id="submit-dimension"
            value={dimension}
            onChange={(event) => {
              setDimension(event.target.value);
            }}
            aria-invalid={byField.dimension ? true : undefined}
            aria-describedby={describedBy('dimension')}
          />{' '}
          {fieldError('dimension')}
        </p>
        <p>
          <label htmlFor="submit-quantity">Quantity</label>{' '}
          <input
            id="submit-quantity"
            type="number"
            step="any"
            value={quantity}
            onChange={(event) => {
              setQuantity(event.target.value);
            }}
            aria-invalid={byField.quantity ? true : undefined}
            aria-describedby={describedBy('quantity')}
          />{' '}
          {fieldError('quantity')}
        </p>
        <button type="submit" disabled={status.kind === 'submitting'}>
          Submit record
        </button>
      </form>
      {general.length > 0 && <p role="alert">{general.join('; ')}</p>}
      <div role="status" aria-live="polite">
        {status.kind === 'success' && (
          <p>
            Record {status.recordId} accepted. It is written asynchronously by the worker, so the
            row may only appear on the next refresh.
          </p>
        )}
      </div>
      {status.kind === 'error' && <p role="alert">{status.message}</p>}
    </section>
  );
}
