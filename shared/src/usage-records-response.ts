import { z } from 'zod';
import { StoredUsageRecordSchema } from './usage-record.js';

/** Body of a 200 from GET /usage/records; web clients validate responses with this. */
export const UsageRecordsResponseSchema = z.object({
  records: z.array(StoredUsageRecordSchema),
});

export type UsageRecordsResponse = z.infer<typeof UsageRecordsResponseSchema>;
