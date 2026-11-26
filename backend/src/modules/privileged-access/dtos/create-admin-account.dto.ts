import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

export const CreateAdminAccountSchema = z.object({
  adminTier: z.enum(['TIER_0', 'TIER_1', 'TIER_2']),
});

export class CreateAdminAccountDto extends createZodDto(CreateAdminAccountSchema) {}
