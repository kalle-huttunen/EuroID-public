import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';
import { PolicyStatus, RiskLevel } from '../schemas/policy.schema';

const ALLOWED_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'starts_with',
  'ends_with',
  'in',
  'not_in',
  'regex',
  'greater_than',
  'less_than',
  'is_empty',
  'is_not_empty',
] as const;

const PolicyConditionSchema = z.object({
  id: z.string().min(1).max(100),
  field: z.string().min(1).max(200),
  operator: z.enum(ALLOWED_OPERATORS),
  value: z.union([z.string().max(1000), z.array(z.string().max(1000)).max(100)]).optional(),
});

const ConditionGroupSchema = z.object({
  id: z.string().min(1).max(100),
  join: z.enum(['AND', 'OR']),
  // An empty group would match every identity (an AND of nothing is true)
  conditions: z.array(PolicyConditionSchema).min(1, 'A condition group needs a condition').max(50),
});

const PolicyActionSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.string().min(1).max(100),
  target: z.string().min(1).max(200),
  params: z
    .record(z.string().max(100), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]))
    .optional(),
  label: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
});

export const UpdatePolicySchema = z.object({
  name: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).optional(),
  status: z.nativeEnum(PolicyStatus).optional(),
  priority: z.number().min(1).max(5).optional(),
  risk: z.nativeEnum(RiskLevel).optional(),
  conditionGroups: z.array(ConditionGroupSchema).optional(),
  actions: z.array(PolicyActionSchema).optional(),
  tags: z.array(z.string().max(100)).optional(),
  roleBundleId: z.string().max(100).optional(),
});

export class UpdatePolicyDto extends createZodDto(UpdatePolicySchema) {}
