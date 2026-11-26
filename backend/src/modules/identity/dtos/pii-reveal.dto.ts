import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';
import { PiiFieldSchema } from '../identity-pii';

/** Body of POST /identity/:id/pii/reveal. `field` must be on the PII allow-list. */
export const PiiRevealSchema = z.object({
  field: PiiFieldSchema,
});

export class PiiRevealDto extends createZodDto(PiiRevealSchema) {}
