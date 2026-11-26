/**
 * Linked admin accounts (PAM): the profile of an admin identity PrivilegedAccessService creates
 * (`parentIdentityId`, `adminTier` on the identity) carries `employmentType: ADMIN_ACCOUNT` and
 * `sourceSystem: euroid-pam`. Its accounts in the target systems stand disabled and are enabled
 * only for a privileged session (privilegedSessionWorkflow), whose activity sets the profile
 * ACTIVE once they are enabled and INACTIVE once they are disabled again.
 *
 * Pure and dependency-free: the connector mappers use it, and workflow code may import it.
 */

/** `profile.sourceSystem` of a linked admin identity. */
export const PAM_SOURCE_SYSTEM = 'euroid-pam';

interface ProfileKind {
  status?: string;
  employmentType?: string;
  sourceSystem?: string;
}

/**
 * A linked admin identity's profile. An ADMIN_ACCOUNT identity of another source (the EuroID
 * platform admins machine-identity-sync.service.ts mirrors) is not one.
 */
export function isLinkedAdminProfile(user: ProfileKind): boolean {
  return user.employmentType === 'ADMIN_ACCOUNT' && user.sourceSystem === PAM_SOURCE_SYSTEM;
}

/**
 * Whether the user's account in a target system is enabled: a linked admin account only during
 * its session (status ACTIVE), so it is created and updated disabled otherwise; anyone else when
 * ACTIVE or PENDING, as before.
 */
export function targetAccountEnabled(user: ProfileKind): boolean {
  if (isLinkedAdminProfile(user)) return user.status === 'ACTIVE';
  return user.status === 'ACTIVE' || user.status === 'PENDING';
}
