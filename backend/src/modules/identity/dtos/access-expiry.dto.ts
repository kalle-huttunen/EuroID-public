import { z } from 'zod';

/** Body of POST /identity/:id/access/expiry/retry: the provisioning entry's target system. */
export const RetryExpirySchema = z
  .object({
    targetSystem: z.string().trim().min(1).max(100),
  })
  .strict();

/**
 * Body of POST /identity/:id/access/expiry/removed-manually: the target system and the admin's
 * note on how the access was removed (required). The admin comes from the token, never the body.
 */
export const ExpiryRemovedManuallySchema = RetryExpirySchema.extend({
  reason: z.string().trim().min(1).max(500),
}).strict();
