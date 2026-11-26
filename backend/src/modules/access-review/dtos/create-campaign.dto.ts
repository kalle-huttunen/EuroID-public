import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';
import { EmploymentType } from '@shared/dtos/standard-user.dto';

const ScopeSchema = z.object({
  type: z.enum(['department', 'role', 'system', 'all']),
  value: z.string().optional(),
});

const RecurrenceSchema = z.object({
  enabled: z.boolean(),
  frequency: z.enum(['MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL']),
});

const EscalationSchema = z.object({
  enabled: z.boolean(),
  escalateAfterDays: z.number().min(1).max(365),
  escalateTo: z.enum(['MANAGER', 'ADMIN']),
});

export const CreateCampaignBodySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  scope: ScopeSchema,
  /** ISO 8601 date-time, in the future (default: 30 days ahead). */
  deadline: z
    .string()
    .datetime({ offset: true, message: 'deadline must be an ISO 8601 date-time' })
    .refine((value) => new Date(value).getTime() > Date.now(), 'deadline must be in the future')
    .optional(),
  autoRevokeOnExpiry: z.boolean().optional(),
  allowSelfReview: z.boolean().optional(),
  selfReviewRiskLevels: z.array(z.string()).optional(),
  /** Employment types to review (default: the human types); SERVICE_ACCOUNT and ADMIN_ACCOUNT too. */
  targetEmploymentTypes: z.array(z.nativeEnum(EmploymentType)).min(1).optional(),
  recurrence: RecurrenceSchema.optional(),
  escalation: EscalationSchema.optional(),
});

export class CreateCampaignBodyDto extends createZodDto(CreateCampaignBodySchema) {}
