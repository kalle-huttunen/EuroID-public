import { SetMetadata } from '@nestjs/common';

export const MFA_ENROLLMENT_ACCESS_KEY = 'mfaEnrollmentAccess';

/**
 * How a route serves an MFA enrollment token (MfaEnrollmentScopeGuard). `read`: it serves it.
 * `setup`: the route sets up MFA, so it serves the enrollment token and, of all other tokens,
 * only those with a role.
 */
export type MfaEnrollmentAccess = 'read' | 'setup';

/** Lets an MFA enrollment token call this route: @AllowMfaEnrollmentToken() or ('setup'). */
export const AllowMfaEnrollmentToken = (access: MfaEnrollmentAccess = 'read') =>
  SetMetadata(MFA_ENROLLMENT_ACCESS_KEY, access);
