import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

export const ListItemsQuerySchema = z.object({
  decision: z.enum(['pending', 'approved', 'revoked', 'expired']).optional(),
  reviewerId: z.string().optional(),
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
});

export class ListItemsQueryDto extends createZodDto(ListItemsQuerySchema) {}
