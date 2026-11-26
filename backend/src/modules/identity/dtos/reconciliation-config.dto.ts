import { z } from 'zod';

/**
 * A source name as identity sources carry it (toSourceName): HR tags and the priority order are
 * compared with lower-cased source names, so they are stored lower-cased.
 */
const sourceName = z.string().trim().toLowerCase().min(1);

export const UpsertReconciliationConfigSchema = z.object({
  hrSourceTags: z.array(sourceName).min(1, 'At least one HR source tag is required'),
  sourcePriorityOrder: z.array(sourceName).min(1, 'At least one source in priority order'),
  contractCriticalFields: z.array(z.string().min(1)),
  defaultMastery: z.record(z.string(), z.array(z.string().min(1)).min(1)),
  targetIdKeys: z.array(z.string().min(1)),
});

export type UpsertReconciliationConfigDto = z.infer<typeof UpsertReconciliationConfigSchema>;
