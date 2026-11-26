import { z } from 'zod';

const EntitlementItemSchema = z.object({
  catalogEntryId: z.string().min(1, 'Catalog entry ID is required'),
  justification: z.string().min(10, 'Justification must be at least 10 characters'),
});

export const CreateAccessRequestSchema = z.object({
  entitlements: z
    .array(EntitlementItemSchema)
    .min(1, 'At least one entitlement is required')
    .max(50, 'At most 50 entitlements per request'),
  requestedDurationDays: z.number().int().min(1).max(730).optional(), // Max 2 years
  targetIdentityId: z.string().optional(),
});

export type CreateAccessRequestDto = z.infer<typeof CreateAccessRequestSchema>;
