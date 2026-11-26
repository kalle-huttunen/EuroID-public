import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

export const DecideBodySchema = z.object({
  decision: z.enum(['approved', 'revoked']),
  justification: z.string().optional(),
});

export class DecideBodyDto extends createZodDto(DecideBodySchema) {}
