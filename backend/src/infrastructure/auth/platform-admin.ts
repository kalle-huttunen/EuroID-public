/**
 * Platform admin: the deployment operator who manages tenants (create, update, suspend,
 * migrate) and reads deployment-wide diagnostics. It is not a tenant role. Every tenant has its
 * own `super-admin` (the first registered user, invited admins, SAML/OIDC role claims), whose
 * powers stay inside that tenant.
 *
 * The capability is granted only by deployment configuration: PLATFORM_ADMIN_USER_IDS, a
 * comma-separated list of authenticated user ids (`sub`: the AdminUser id for local login, the
 * IdP subject for OIDC). Ids, not emails: emails are not verified here, and an address a tenant
 * admin invites or an IdP asserts could claim one. Nothing a tenant controls (registration,
 * invites, SAML/OIDC role claims, the token's `roles`) can grant it: RolesGuard checks
 * `@Roles(PLATFORM_ADMIN_ROLE)` against this list only, and no tenant role implies it.
 */

export const PLATFORM_ADMIN_ROLE = 'platform-admin';

/** The user ids PLATFORM_ADMIN_USER_IDS names (comma-separated, blanks ignored). */
export function parsePlatformAdminIds(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/** Whether the authenticated user is a platform admin by deployment configuration. */
export function isPlatformAdmin(
  user: { sub?: unknown } | undefined,
  platformAdminIds: ReadonlySet<string>,
): boolean {
  return typeof user?.sub === 'string' && platformAdminIds.has(user.sub);
}
