import { z } from 'zod';
import { isValidTimeZone } from '../leaver-policy.defaults';

/**
 * PUT /leavers/policy: the whole policy (the form always sends every field). The floor may not
 * exceed the count limit.
 */
export const UpdateLeaverPolicySchema = z
  .object({
    signals: z
      .object({
        terminated: z.boolean(),
        endDate: z.boolean(),
        missingFromSource: z.boolean(),
      })
      .strict(),
    terminatedStatuses: z.array(z.string().trim().min(1).max(50)).min(1).max(20),
    missingSyncThreshold: z.number().int().min(1).max(30),
    massLeaverMaxCount: z.number().int().min(0).max(100000),
    massLeaverMaxPercent: z.number().min(0).max(100),
    massLeaverMinCount: z.number().int().min(0).max(100000),
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine(isValidTimeZone, { message: 'Unknown IANA time zone' }),
  })
  .strict()
  .refine((p) => p.massLeaverMinCount <= p.massLeaverMaxCount, {
    message: 'massLeaverMinCount may not exceed massLeaverMaxCount',
    path: ['massLeaverMinCount'],
  });

export type UpdateLeaverPolicyDto = z.infer<typeof UpdateLeaverPolicySchema>;

/** POST /leavers/batches/:id/approve | reject */
export const LeaverBatchDecisionSchema = z
  .object({
    comment: z.string().trim().max(500).optional(),
  })
  .strict();

export type LeaverBatchDecisionDto = z.infer<typeof LeaverBatchDecisionSchema>;

/** POST /leavers/offboardings/:workflowId/removed-manually: which failed target, and the note. */
export const MarkRemovedManuallySchema = z
  .object({
    system: z.string().trim().min(1).max(100),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export type MarkRemovedManuallyDto = z.infer<typeof MarkRemovedManuallySchema>;

/** The :workflowId of an offboarding (`t-<tenant>-offboard-<identityId>`), an opaque string. */
export const OffboardingWorkflowIdSchema = z.string().trim().min(1).max(200);

/** GET /leavers/batches?status= */
export const ListLeaverBatchesQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});
