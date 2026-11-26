import { z } from 'zod';
import { toOperationType } from '@shared/utils/entitlement-operation-type';
import { systemKey } from '@shared/utils/normalize-system-name';

export const SodEntitlementRefSchema = z.object({
  system: z.string().min(1),
  type: z.string().min(1),
  targetId: z.string().min(1),
});

type SodEntitlementRefInput = z.infer<typeof SodEntitlementRefSchema>;

/**
 * Each entitlement once, compared as SodService.validate matches them (the system as the
 * policy engine names it, so `entra` is entra-id and `active-directory` is ad; the type
 * case-insensitively, a directory role as `role`; the id exactly): a policy naming one
 * entitlement twice would match anyone who holds that one entitlement.
 */
function refineDistinctEntitlements(refs: SodEntitlementRefInput[], ctx: z.RefinementCtx) {
  const seen = new Map<string, number>();
  refs.forEach((ref, index) => {
    const key = `${systemKey(ref.system)}|${toOperationType(ref.type)}|${ref.targetId}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, index);
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [index],
      message:
        `repeats conflictingEntitlements.${first} (same system, type and id). List each ` +
        'entitlement once: a policy that names one entitlement twice matches anyone who holds it.',
    });
  });
}

export const CreateSodPolicySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).default('HIGH'),
  conflictingEntitlements: z
    .array(SodEntitlementRefSchema)
    .min(2, 'At least 2 conflicting entitlements required')
    .superRefine(refineDistinctEntitlements),
  action: z.enum(['BLOCK', 'WARN']).default('BLOCK'),
  isActive: z.boolean().default(true),
});

export type CreateSodPolicyDto = z.infer<typeof CreateSodPolicySchema>;
