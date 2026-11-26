import type { AdminRole } from '../../interfaces';

/**
 * The tenant roles an invite can grant, lowest first, as RolesGuard's hierarchy and
 * backend/README.md § RBAC Roles describe them. Only a super-admin invites, so every role is
 * one the caller holds itself.
 */
export const ROLE_OPTIONS: Array<{ value: AdminRole; label: string; description: string }> = [
  { value: 'viewer', label: 'Viewer', description: 'Reads every page and changes nothing.' },
  {
    value: 'operator',
    label: 'Operator',
    description:
      'Viewer, plus identities, onboarding and offboarding, reconciliation and provisioning.',
  },
  {
    value: 'policy-admin',
    label: 'Policy admin',
    description:
      'Operator, plus policies, simulation and deploy, segregation of duties, leaver and mover batches.',
  },
  {
    value: 'connector-admin',
    label: 'Connector admin',
    description: 'Operator, plus connector install, configuration and health checks.',
  },
  {
    value: 'super-admin',
    label: 'Super-admin',
    description:
      "Everything in this tenant, its admin users, SCIM and webhooks included. Never another tenant's.",
  },
];

export const ROLE_LABEL: Record<AdminRole, string> = Object.fromEntries(
  ROLE_OPTIONS.map((o) => [o.value, o.label]),
) as Record<AdminRole, string>;

/** Why an action is not offered on a platform admin's row (the API answers 403). */
export const PLATFORM_ADMIN_REASON =
  'A platform admin is named in the deployment configuration (PLATFORM_ADMIN_USER_IDS): a tenant role cannot change its role, sign the account out, deactivate it or issue it a password reset code.';
