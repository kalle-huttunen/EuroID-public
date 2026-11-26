import { z } from 'zod';

export const CreateInviteSchema = z.object({
  email: z.string().email(),
  roles: z.array(z.string()).min(1).default(['viewer']),
});

export const RegisterWithInviteSchema = z.object({
  token: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(12),
  displayName: z.string().min(1),
});

export type CreateInviteDto = z.infer<typeof CreateInviteSchema>;
export type RegisterWithInviteDto = z.infer<typeof RegisterWithInviteSchema>;
