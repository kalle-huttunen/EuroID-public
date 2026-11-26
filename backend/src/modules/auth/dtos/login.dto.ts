import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

export const LoginSchema = z.object({
  email: z.string().email(),
  // The password is checked against the stored hash, not the current policy: an account whose
  // password predates the policy answered 400 instead of 401. The policy applies when one is set.
  password: z.string().min(1).max(128),
});

export class LoginDto extends createZodDto(LoginSchema) {}
