import { z } from 'zod';

/** PUT /joiners/policy: the whole policy. The floor may not exceed the count limit. */
export const UpdateJoinerPolicySchema = z
  .object({
    massJoinerMaxCount: z.number().int().min(0).max(100000),
    massJoinerMaxPercent: z.number().min(0).max(100),
    massJoinerMinCount: z.number().int().min(0).max(100000),
  })
  .strict()
  .refine((p) => p.massJoinerMinCount <= p.massJoinerMaxCount, {
    message: 'massJoinerMinCount may not exceed massJoinerMaxCount',
    path: ['massJoinerMinCount'],
  });

export type UpdateJoinerPolicyDto = z.infer<typeof UpdateJoinerPolicySchema>;

/** POST /joiners/batches/:id/approve | reject */
export const JoinerBatchDecisionSchema = z
  .object({
    comment: z.string().trim().max(500).optional(),
  })
  .strict();

/** GET /joiners/batches?status= */
export const ListJoinerBatchesQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});
