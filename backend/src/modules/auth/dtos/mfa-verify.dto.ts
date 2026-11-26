import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

export const MfaVerifySchema = z.object({
  code: z.string().min(6).max(10),
});

export class MfaVerifyDto extends createZodDto(MfaVerifySchema) {}
