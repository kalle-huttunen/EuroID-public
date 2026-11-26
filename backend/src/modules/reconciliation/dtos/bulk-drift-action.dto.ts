import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

export const BulkDriftActionSchema = z.object({
  // A drift's _id: one other id failed the whole request with a CastError ("Invalid ID format")
  driftIds: z
    .array(z.string().regex(/^[0-9a-f]{24}$/i, 'A drift id is 24 hex characters'))
    .max(500, 'Bulk operations limited to 500 drift IDs'),
});

export class BulkDriftActionDto extends createZodDto(BulkDriftActionSchema) {}
