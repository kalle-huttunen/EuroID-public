import { z } from 'zod';

const KNOWN_ROLES = [
  'super-admin',
  'connector-admin',
  'policy-admin',
  'operator',
  'viewer',
] as const;

export const LoginResponseSchema = z.object({
  access_token: z.string().max(4096).optional(),
  refresh_token: z.string().max(4096).optional(),
  mfa_required: z.boolean().optional(),
  mfa_token: z.string().max(2048).optional(),
  mfa_enrollment_required: z.boolean().optional(),
  /** With mfa_enrollment_required: a token that can only set up MFA (auth/mfa-enrollment.ts). */
  mfa_enrollment_token: z.string().max(4096).optional(),
  user: z
    .object({
      id: z.string(),
      email: z.string().email(),
      role: z.enum(KNOWN_ROLES),
      displayName: z.string().optional(),
      tenantId: z.string().optional(),
    })
    .optional(),
});

export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const JwtClaimsSchema = z
  .object({
    sub: z.string(),
    email: z.string().optional(),
    roles: z.array(z.string()).optional(),
    name: z.string().optional(),
    tenantId: z.string().optional(),
    tenantName: z.string().optional(),
  })
  .passthrough();

export type JwtClaims = z.infer<typeof JwtClaimsSchema>;
