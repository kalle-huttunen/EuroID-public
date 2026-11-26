/**
 * Admin users: the people who sign in to the EuroID console (backend `modules/auth`, collection
 * `admin_users`), not the identities EuroID manages. Matches GET /auth/users, GET and POST
 * /auth/invites and the body of PATCH /auth/users/:id, all super-admin. The routes take `id`, the
 * admin's (or invite's) `_id`; an admin's is also the `sub` of the admin's token. Hand-written:
 * the generated types carry no response bodies for these routes.
 */

/** Tenant roles, highest first. None of them makes anyone a platform admin. */
export type AdminRole = 'super-admin' | 'connector-admin' | 'policy-admin' | 'operator' | 'viewer';

/** One admin as GET /auth/users answers it: no password, MFA or session data. */
export interface IAdminUser {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  /** False when deactivated: the admin cannot sign in. */
  isActive: boolean;
  mfaEnabled: boolean;
  /** `local`: email and password; `saml`: single sign-on. */
  authSource: 'local' | 'saml';
  /**
   * Named in the deployment's PLATFORM_ADMIN_USER_IDS. A tenant role cannot revoke the account's
   * sessions or deactivate it (403); the account's owner can still revoke their own sessions.
   */
  isPlatformAdmin: boolean;
  /** Absent for accounts stored before timestamps were kept. */
  createdAt?: string;
  /**
   * When a sign-in (password with its MFA step, or single sign-on) last gave the admin a session.
   * Null when none has since EuroID started recording it.
   */
  lastLoginAt: string | null;
}

/** PATCH /auth/users/:id body: one change at a time from this page. */
export interface IAdminUserUpdate {
  isActive?: boolean;
  /** Applies from the admin's next request; never your own role. */
  role?: AdminRole;
}

/** POST /auth/invites body. The invitee gets the first role only. */
export interface IAdminInviteCreate {
  email: string;
  roles: AdminRole[];
}

/**
 * POST /auth/users/:id/password-reset answer: a one-time reset code for the admin, shown once.
 * EuroID keeps only its hash; a newer code or reset link replaces it.
 */
export interface IPasswordResetCode {
  token: string;
  expiresAt: string;
}

/** POST /auth/invites answer: the invite code, shown once. EuroID keeps only its hash. */
export interface IAdminInvite {
  token: string;
  expiresAt: string;
}

/** One pending (unused, unexpired) invite as GET /auth/invites answers it: never the code. */
export interface IPendingInvite {
  id: string;
  email: string;
  /** The role the invitee gets. */
  role: AdminRole;
  /** The inviter's token `sub`: an admin's `id`, an OIDC subject, or `emergency-admin`. */
  createdBy: string;
  createdAt?: string;
  expiresAt: string;
}
