import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';
import { STRONG_PASSWORD_SCHEMA } from './password.schema';

/** POST /auth/password-reset/request: the address of the account. */
export const PasswordResetRequestSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
});

export class PasswordResetRequestDto extends createZodDto(PasswordResetRequestSchema) {}

/** POST /auth/password-reset/confirm: the token from the link or the code, and the new password. */
export const PasswordResetConfirmSchema = z.object({
  token: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[0-9a-f]{64}$/,
      'The reset code is 64 characters, the digits 0-9 and the letters a-f.',
    ),
  newPassword: STRONG_PASSWORD_SCHEMA,
});

export class PasswordResetConfirmDto extends createZodDto(PasswordResetConfirmSchema) {}
