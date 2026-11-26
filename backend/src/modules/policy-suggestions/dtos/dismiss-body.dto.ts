import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

export const DismissBodySchema = z.object({
  reason: z.string().max(2000).optional(),
});

export class DismissBodyDto extends createZodDto(DismissBodySchema) {}
