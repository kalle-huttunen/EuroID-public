import { z } from 'zod';

/** PUT /movers/policy: the whole policy. The floor may not exceed the count limit. */
export const UpdateMoverPolicySchema = z
  .object({
    massMoverMaxCount: z.number().int().min(0).max(100000),
    massMoverMaxPercent: z.number().min(0).max(100),
    massMoverMinCount: z.number().int().min(0).max(100000),
  })
  .strict()
  .refine((p) => p.massMoverMinCount <= p.massMoverMaxCount, {
    message: 'massMoverMinCount may not exceed massMoverMaxCount',
    path: ['massMoverMinCount'],
  });

export type UpdateMoverPolicyDto = z.infer<typeof UpdateMoverPolicySchema>;

/** POST /movers/batches/:id/approve | reject */
export const MoverBatchDecisionSchema = z
  .object({
    comment: z.string().trim().max(500).optional(),
  })
  .strict();

/** GET /movers/batches?status= */
export const ListMoverBatchesQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});
