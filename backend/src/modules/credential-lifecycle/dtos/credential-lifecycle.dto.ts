/**
 * Credential Lifecycle DTOs — Zod at the gate.
 */

import { z } from 'zod';

// ── Credential Policy DTOs ───────────────────────────────────────────────

/**
 * The settings objects of a policy. A create gets the defaults below for the fields it leaves out;
 * an update (UpdateCredentialPolicySchema) gets no defaults: it changes only the fields it sends.
 */
export const TargetScopeSchema = z
  .object({
    connectorTypes: z.array(z.string()).optional(),
    employmentTypes: z.array(z.string()).optional(),
    entitlementTiers: z.array(z.number().int()).optional(),
  })
  .strict();

export const PasswordPolicySchema = z
  .object({
    maxAgeDays: z.number().int().min(1).max(365).default(90),
    minLength: z.number().int().min(8).max(128).default(16),
    requireComplexity: z.boolean().default(true),
    preventReuse: z.number().int().min(0).max(24).default(5),
  })
  .strict();

export const RotationPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    intervalDays: z.number().int().min(1).max(365).default(90),
    notifyDaysBefore: z.number().int().min(1).max(30).default(7),
    vaultStorage: z.boolean().default(false),
  })
  .strict();

export const MfaRequirementSchema = z
  .object({
    required: z.boolean().default(false),
    methods: z.array(z.string()).default([]),
    gracePeriodDays: z.number().int().min(0).max(90).default(14),
  })
  .strict();

export const CreateCredentialPolicySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  targetScope: TargetScopeSchema.optional(),
  passwordPolicy: PasswordPolicySchema.optional(),
  rotationPolicy: RotationPolicySchema.optional(),
  mfaRequirement: MfaRequirementSchema.optional(),
  isActive: z.boolean().default(true),
});

export type CreateCredentialPolicyDto = z.infer<typeof CreateCredentialPolicySchema>;

/**
 * PATCH: every field optional, also inside a settings object, and no defaults, so a body naming
 * one setting (`{ rotationPolicy: { notifyDaysBefore: 3 } }`) leaves the others as stored.
 */
export const UpdateCredentialPolicySchema = CreateCredentialPolicySchema.extend({
  targetScope: TargetScopeSchema.partial(),
  passwordPolicy: PasswordPolicySchema.partial(),
  rotationPolicy: RotationPolicySchema.partial(),
  mfaRequirement: MfaRequirementSchema.partial(),
}).partial();

export type UpdateCredentialPolicyDto = z.infer<typeof UpdateCredentialPolicySchema>;

// ── Query DTOs ───────────────────────────────────────────────────────────

export const ExpiringQuerySchema = z.object({
  daysAhead: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export type ExpiringQueryDto = z.infer<typeof ExpiringQuerySchema>;

/** GET /credential-lifecycle/inventory: the credentials in one password status. */
export const InventoryStatusQuerySchema = z.object({
  status: z.enum(['COMPLIANT', 'EXPIRING_SOON', 'EXPIRED', 'UNKNOWN']),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export type InventoryStatusQueryDto = z.infer<typeof InventoryStatusQuerySchema>;
