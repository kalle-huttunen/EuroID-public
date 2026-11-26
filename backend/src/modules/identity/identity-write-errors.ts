import { ConflictException } from '@nestjs/common';

/** The answer when an update's national ID is another identity's (its hash, the correlationId). */
export const NATIONAL_ID_TAKEN =
  'Another identity has this national ID, so nothing was changed. Merge the two identities, or ' +
  'correct the value.';

/** The answer when a write gives an identity the email another live identity has. */
export const EMAIL_TAKEN =
  'Another identity has this email, so nothing was changed. Merge the two identities, or use ' +
  'another email.';

/**
 * A write the identities' unique indexes refused (E11000 on the email among live identities, or
 * on the correlationId), as the 409 a client can act on; null for any other error. The value
 * itself stays out of the answer. Used by every identity write a route answers: POST and PATCH
 * /identity, SCIM inbound (through the update) and the controls.
 */
export function uniqueValueConflict(err: unknown): ConflictException | null {
  const failure = err as { code?: unknown; keyPattern?: Record<string, unknown> } | null;
  if (failure?.code !== 11000) return null;
  const keys = Object.keys(failure.keyPattern ?? {});
  if (keys.includes('profile.correlationId')) return new ConflictException(NATIONAL_ID_TAKEN);
  if (keys.includes('profile.email')) return new ConflictException(EMAIL_TAKEN);
  return null;
}
