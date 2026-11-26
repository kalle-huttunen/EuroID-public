import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';
import { STRONG_PASSWORD_SCHEMA } from './password.schema';

export const ChangePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: STRONG_PASSWORD_SCHEMA,
});

export class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}
