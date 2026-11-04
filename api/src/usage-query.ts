import type { UsageRecord, UsageRecordError } from '@usage-metering/shared';
import { z } from 'zod';

export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 500;

/** The only read capability the use case needs; a pg adapter or a fake implements it. */
export interface UsageReadRepository {
  /** Newest first (occurred_at DESC, record_id DESC). */
  listByCustomer(customerId: string, limit: number): Promise<UsageRecord[]>;
}

/**
 * Unknown query params are rejected (strict): a typo such as `custmerId` or `limt`
 * would otherwise be silently ignored and return a misleading default result.
 */
export const ListUsageQuerySchema = z.strictObject({
  customerId: z.string().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
});

export type ListUsageResult =
  | { status: 'ok'; records: UsageRecord[] }
  | { status: 'invalid'; errors: UsageRecordError[] }
  | { status: 'unavailable'; cause: unknown };

export type ListUsageRecords = (query: unknown) => Promise<ListUsageResult>;

export interface ListUsageDeps {
  repo: UsageReadRepository;
}

/** Pure read use case: validate the query, then ask the repository. No HTTP, no logging. */
export function createListUsageRecords(deps: ListUsageDeps): ListUsageRecords {
  return async (query) => {
    const parsed = ListUsageQuerySchema.safeParse(query);
    if (!parsed.success) {
      const errors = parsed.error.issues.flatMap((issue): UsageRecordError[] =>
        issue.code === 'unrecognized_keys'
          ? issue.keys.map((key) => ({ path: key, message: 'Unrecognized query parameter' }))
          : [{ path: issue.path.map(String).join('.'), message: issue.message }],
      );
      return { status: 'invalid', errors };
    }
    try {
      const records = await deps.repo.listByCustomer(parsed.data.customerId, parsed.data.limit);
      return { status: 'ok', records };
    } catch (cause) {
      return { status: 'unavailable', cause };
    }
  };
}
