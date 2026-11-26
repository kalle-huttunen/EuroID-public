import { z } from 'zod';

const PreCheckEntitlementSchema = z.object({
  catalogEntryId: z.string().min(1, 'Catalog entry ID is required'),
});

export const PreCheckSodSchema = z.object({
  entitlements: z
    .array(PreCheckEntitlementSchema)
    .min(1, 'At least one entitlement is required')
    .max(50, 'At most 50 entitlements per pre-check'),
  targetIdentityId: z.string().optional(),
});

export type PreCheckSodDto = z.infer<typeof PreCheckSodSchema>;
