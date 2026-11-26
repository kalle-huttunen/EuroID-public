import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

/**
 * A tenant id: it names Temporal search attribute values, websocket rooms (`t:<id>:...`) and
 * archive object keys, so letters, digits, dot, underscore and hyphen only, up to 64 characters.
 */
export const TENANT_ID_SCHEMA = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    'A tenant id is 1 to 64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.',
  );

// No createdBy: the creator is the authenticated platform admin; a body value is stripped.
export const CreateTenantBodySchema = z.object({
  tenantId: TENANT_ID_SCHEMA,
  name: z.string().trim().min(1).max(200),
});

export class CreateTenantBodyDto extends createZodDto(CreateTenantBodySchema) {}

/** dryRun defaults to true: the counts per collection, nothing moved. */
export const MigrateTenantBodySchema = z.object({
  targetTenantId: TENANT_ID_SCHEMA,
  dryRun: z.boolean().default(true),
});

export class MigrateTenantBodyDto extends createZodDto(MigrateTenantBodySchema) {}

/**
 * The tenant settings a PATCH may change, each with its type: a string "false" for mfaRequired
 * was stored and read as true. A key sent is set, a key sent as null is removed, a key left out
 * keeps its stored value. Unknown keys are dropped.
 */
export const TenantSettingsPatchSchema = z.object({
  maxIdentities: z.number().int().positive().nullable().optional(),
  retentionDays: z.number().int().positive().nullable().optional(),
  allowedConnectors: z.array(z.string().trim().min(1)).nullable().optional(),
  features: z.record(z.string(), z.boolean()).nullable().optional(),
  mfaRequired: z.boolean().nullable().optional(),
});

export type TenantSettingsPatch = z.infer<typeof TenantSettingsPatchSchema>;

export const UpdateTenantBodySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  settings: TenantSettingsPatchSchema.optional(),
  status: z.enum(['active', 'suspended']).optional(),
});

export class UpdateTenantBodyDto extends createZodDto(UpdateTenantBodySchema) {}
