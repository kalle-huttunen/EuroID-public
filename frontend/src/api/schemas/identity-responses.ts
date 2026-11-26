import { z } from 'zod';

export const IdentityOptionSchema = z
  .object({
    _id: z.string().optional(),
    id: z.string().optional(),
    email: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    displayName: z.string().optional(),
    /** GET /identity answers the profile flattened: `profile.status` (ACTIVE, SUSPENDED, ...). */
    status: z.string().nullish(),
    /** Only with includeDeleted=true: the identity is offboarded (soft-deleted). */
    deletedAt: z.string().nullish(),
    profile: z
      .object({
        email: z.string().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
      })
      .optional(),
  })
  .refine((v) => v._id || v.id, { message: 'Identity must have at least one identifier' });

export type IdentityOptionRaw = z.infer<typeof IdentityOptionSchema>;

export const IdentityListResponseSchema = z.union([
  z.array(IdentityOptionSchema),
  z
    .object({
      user: z.array(IdentityOptionSchema).optional(),
      data: z.array(IdentityOptionSchema).optional(),
    })
    .refine((v) => v.user || v.data, { message: 'Response must contain user or data array' }),
]);
