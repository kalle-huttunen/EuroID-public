import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

export const ResolveConflictSchema = z.object({
  action: z.enum(['merge', 'split', 'dismiss']),
});

export class ResolveConflictDto extends createZodDto(ResolveConflictSchema) {}
