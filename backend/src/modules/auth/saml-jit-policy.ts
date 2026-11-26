/**
 * The tenant and role of an admin a first SAML sign-in creates (JIT provisioning). The IdP may
 * name both (SAML_TENANT_ATTR, SAML_ROLE_ATTR), and an IdP admin is not a EuroID admin, so:
 *
 * - The tenant is the configured default tenant (SAML_DEFAULT_TENANT_ID, else DEFAULT_TENANT_ID),
 *   or one the assertion names that is on SAML_ALLOWED_TENANT_IDS. Without a list only the default
 *   tenant is allowed. A tenant the assertion names must have a `tenants` document and be active;
 *   the default tenant may have none (a single-tenant deployment), and is refused only when its
 *   document is not active.
 * - The role is the asserted one (else SAML_DEFAULT_ROLE) held to SAML_JIT_MAX_ROLE (roleWithin),
 *   whose default is viewer, the lowest console role. super-admin is never given: as the cap it
 *   is refused and viewer used.
 *
 * An existing admin keeps the role and tenant stored: findOrCreateUser returns it unchanged.
 * docs/architecture/security/PLATFORM_AUTH_ARCHITECTURE.md, JIT Provisioning.
 */
import { UnauthorizedException } from '@nestjs/common';
import { roleWithin } from '@infrastructure/auth/roles.guard';
import { tenantAllowsUse } from '@infrastructure/multi-tenancy/tenant-status.service';

const LOWEST_ROLE = 'viewer';
const NEVER_JIT_ROLE = 'super-admin';

export interface SamlJitConfig {
  defaultTenantId: string;
  /** The tenants an assertion may name, the default tenant included. */
  allowedTenantIds: ReadonlySet<string>;
  maxRole: string;
  defaultRole: string;
}

export function samlJitConfig(
  get: (key: string) => string | undefined,
  logger: { error(message: string): void },
): SamlJitConfig {
  const defaultTenantId = get('SAML_DEFAULT_TENANT_ID') || get('DEFAULT_TENANT_ID') || 'dev-tenant';
  const listed = (get('SAML_ALLOWED_TENANT_IDS') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  let maxRole = get('SAML_JIT_MAX_ROLE') || LOWEST_ROLE;
  if (maxRole === NEVER_JIT_ROLE || !roleWithin(maxRole, maxRole)) {
    logger.error(
      `[SECURITY] SAML_JIT_MAX_ROLE="${maxRole}" is not allowed: SAML never creates a ` +
        `super-admin, and the value must be a tenant role. Using ${LOWEST_ROLE}.`,
    );
    maxRole = LOWEST_ROLE;
  }
  return {
    defaultTenantId,
    allowedTenantIds: new Set([defaultTenantId, ...listed]),
    maxRole,
    defaultRole: get('SAML_DEFAULT_ROLE') || LOWEST_ROLE,
  };
}

/** The role of a new SAML admin: the asserted one, else the default, held to the cap. */
export function jitRole(asserted: string | undefined, config: SamlJitConfig): string {
  return (
    (asserted && roleWithin(asserted, config.maxRole)) ||
    roleWithin(config.defaultRole, config.maxRole) ||
    LOWEST_ROLE
  );
}

/**
 * The tenant of a new SAML admin: the asserted one, else the default tenant, when allowed (see
 * above). UnauthorizedException otherwise: no admin is created.
 */
export async function jitTenant(
  asserted: string | undefined,
  config: SamlJitConfig,
  findTenant: (tenantId: string) => Promise<{ status?: string } | null>,
): Promise<string> {
  const tenantId = asserted || config.defaultTenantId;
  const refused = new UnauthorizedException(
    'Your identity provider placed this account in a tenant it may not create accounts in. ' +
      'Contact your administrator.',
  );
  if (!config.allowedTenantIds.has(tenantId)) throw refused;
  const doc = await findTenant(tenantId);
  if (!doc && tenantId !== config.defaultTenantId) throw refused;
  if (!tenantAllowsUse(doc)) throw refused;
  return tenantId;
}
