import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

export const MfaChallengeSchema = z.object({
  mfa_token: z.string(),
  code: z.string().min(6).max(10),
});

export class MfaChallengeDto extends createZodDto(MfaChallengeSchema) {}
