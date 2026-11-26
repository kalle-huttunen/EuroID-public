import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

export const GrantConsentSchema = z.object({
  purpose: z.string().min(1, 'purpose is required'),
  method: z.string().optional(),
  // A date Mongoose cannot cast would be a 500: refuse it here as a 400 the caller can fix.
  expiresAt: z
    .string()
    .refine((v) => !isNaN(Date.parse(v)), {
      message: 'must be a date, e.g. 2026-12-31 or 2026-12-31T23:59:59.999Z',
    })
    .optional(),
});

export class GrantConsentDto extends createZodDto(GrantConsentSchema) {}
