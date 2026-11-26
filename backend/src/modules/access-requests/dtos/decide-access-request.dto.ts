import { z } from 'zod';

export const DecideAccessRequestSchema = z.object({
  stepIndex: z.number().int().min(0),
  decision: z.enum(['approve', 'reject']),
  justification: z.string().optional(),
});

export type DecideAccessRequestDto = z.infer<typeof DecideAccessRequestSchema>;

/**
 * PUT /access-requests/:id/delegate. A delegation hands the step to another approver and is no
 * decision, so the body has no `decision` (one sent by an older client is ignored).
 */
export const DelegateAccessRequestSchema = z.object({
  stepIndex: z.number().int().min(0),
  /** Email or identity id of the new approver. */
  delegateTo: z.string().trim().min(1, 'delegateTo is required').max(320),
});

export type DelegateAccessRequestDto = z.infer<typeof DelegateAccessRequestSchema>;

/**
 * POST /access-requests/:id/removed-manually: the admin's note on how the access was removed in
 * the target (required). The admin comes from the token, never the body.
 */
export const RemovedManuallySchema = z
  .object({
    note: z.string().trim().min(1, 'note is required').max(500),
  })
  .strict();
