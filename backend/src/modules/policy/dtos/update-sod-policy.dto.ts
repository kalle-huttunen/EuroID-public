import { z } from 'zod';

export const UpdateSodPolicySchema = z.object({
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
  action: z.enum(['BLOCK', 'WARN']).optional(),
  isActive: z.boolean().optional(),
});

export type UpdateSodPolicyDto = z.infer<typeof UpdateSodPolicySchema>;
