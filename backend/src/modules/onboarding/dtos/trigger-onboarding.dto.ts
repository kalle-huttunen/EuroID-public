import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

export const TriggerOnboardingSchema = z.object({
  email: z.string().email(),
});

export class TriggerOnboardingDto extends createZodDto(TriggerOnboardingSchema) {}
