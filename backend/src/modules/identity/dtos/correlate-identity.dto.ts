import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

export const CorrelateIdentitySchema = z.object({
  targetIdentityId: z.string(),
});

export class CorrelateIdentityDto extends createZodDto(CorrelateIdentitySchema) {}
