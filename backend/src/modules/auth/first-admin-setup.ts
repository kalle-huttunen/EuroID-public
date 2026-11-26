import { ForbiddenException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { isDevOrTest } from '@infrastructure/config/runtime-env';

/** What the first registration answers outside development and test while SETUP_TOKEN is unset. */
export const SETUP_TOKEN_MISSING_MESSAGE =
  'Initial setup is disabled until SETUP_TOKEN is set on the server. Set SETUP_TOKEN, restart the API and register with it as the invite token.';

const SETUP_TOKEN_WRONG_MESSAGE =
  'Initial setup requires the SETUP_TOKEN. Check your environment configuration.';

/**
 * Whether POST /auth/register may create the deployment's first admin, a super-admin. With
 * SETUP_TOKEN set the registration must carry it (`inviteToken`), compared in constant time. Without
 * it the setup is open only in development and test (isDevOrTest): in any other environment
 * an outsider who reaches a fresh deployment first would own it. ForbiddenException (403) when not.
 */
export function assertFirstAdminSetupAllowed(opts: {
  setupToken?: string;
  nodeEnv?: string;
  provided?: string;
}): void {
  const { setupToken, nodeEnv, provided } = opts;
  if (!setupToken) {
    if (!isDevOrTest(nodeEnv ?? '')) throw new ForbiddenException(SETUP_TOKEN_MISSING_MESSAGE);
    return;
  }
  if (!provided || !sameSecret(provided, setupToken)) {
    throw new ForbiddenException(SETUP_TOKEN_WRONG_MESSAGE);
  }
}

/** Constant-time comparison of two secrets of any length (their SHA-256 digests are compared). */
function sameSecret(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}
