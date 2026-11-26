import { z } from 'zod';

/**
 * Zod schemas for role bundle create/update validation.
 * Ensures runtime type safety at the API boundary (Safety Rule #4: Zod at the gate).
 */

const RoleBundleActionSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  type: z.string().min(1).max(100),
  target: z.string().min(1).max(200),
  targetId: z.string().min(1).max(200).optional(),
  params: z.record(
    z.string().max(100),
    z.union([z.string().max(1000), z.number(), z.boolean()]),
  ).optional(),
  label: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  timeConstraint: z.object({
    durationDays: z.number().int().min(1).max(3650).optional(),
    expiresAt: z.coerce.date().optional(),
  }).optional(),
});

export const CreateRoleBundleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  icon: z.string().max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/, 'Must be a valid hex color').optional(),
  actions: z.array(RoleBundleActionSchema).max(50).optional(),
  inheritance: z.array(z.string().min(1).max(100)).max(20).optional(),
  tags: z.array(z.string().min(1).max(100)).max(50).optional(),
});

export const UpdateRoleBundleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  icon: z.string().max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/, 'Must be a valid hex color').optional(),
  actions: z.array(RoleBundleActionSchema).max(50).optional(),
  inheritance: z.array(z.string().min(1).max(100)).max(20).optional(),
  tags: z.array(z.string().min(1).max(100)).max(50).optional(),
});

export type CreateRoleBundleDto = z.infer<typeof CreateRoleBundleSchema>;
export type UpdateRoleBundleDto = z.infer<typeof UpdateRoleBundleSchema>;
