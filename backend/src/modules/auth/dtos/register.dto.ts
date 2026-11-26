import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';
import { STRONG_PASSWORD_SCHEMA } from './password.schema';

export const RegisterSchema = z.object({
  // Stored lowercased (AdminUser.email), so compared lowercased too.
  email: z.string().trim().toLowerCase().max(254).email(),
  password: STRONG_PASSWORD_SCHEMA,
  name: z.string().min(1, 'Name is required'),
  // tenantId removed: derived server-side from invite or DEFAULT_TENANT_ID env only
  inviteToken: z.string().optional(),
});

export class RegisterDto extends createZodDto(RegisterSchema) {}
