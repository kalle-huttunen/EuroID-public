/**
 * Which connector removes a revoked review entitlement, or why EuroID cannot (pure).
 *
 * EuroID removes group memberships in Entra ID, Active Directory, Okta (OKTA_GROUP only) and
 * SCIM targets (direct memberships). In a target whose memberships it cannot read, the review
 * item is the account itself, removed through offboarding's per-target deprovision (runs with
 * the workflow patch access-review:account-revocation). Everything else a review can contain is
 * recorded as `manual-action-needed` with what an admin must do, never as revoked: Entra
 * directory roles and administrative units, Okta groups whose members come from an app or
 * directory import, nested SCIM memberships, EuroID's own SCIM token scopes and admin roles,
 * and any other system.
 */
import type {
  RevocationConnector,
  RevocationOutcome,
  RevocationSummary,
} from '@shared/types/access-review-revocation';

export type RevocationRoute =
  | { connector: RevocationConnector }
  | { account: true }
  | { manual: string };

/** Entitlement `type` values written by ReviewTargetAccessService.gather. */
export const REVIEW_ENTITLEMENT_TYPES = {
  group: 'group',
  entraDirectoryRole: 'directory-role',
  entraAdministrativeUnit: 'administrative-unit',
  oktaAppGroup: 'app-group',
  oktaOtherGroup: 'other-group',
  scimIndirectGroup: 'indirect-group',
  /** The identity's account in a target without readable memberships (review-account-items.ts). */
  account: 'account',
} as const;

const T = REVIEW_ENTITLEMENT_TYPES;

const MANUAL: Record<string, string> = {
  [`entra:${T.entraDirectoryRole}`]:
    'Entra ID directory role: EuroID removes only group memberships. Remove the role ' +
    'assignment in Entra ID (Roles and administrators).',
  [`entra:${T.entraAdministrativeUnit}`]:
    'Entra ID administrative unit: EuroID removes only group memberships. Remove the user ' +
    'from the administrative unit in Entra ID.',
  [`okta:${T.oktaAppGroup}`]:
    'Okta app group (APP_GROUP): its members come from an application or directory import, ' +
    'and Okta does not let them be removed through the Groups API. Remove the membership in ' +
    'the source the group is imported from.',
  [`okta:${T.oktaOtherGroup}`]:
    'Okta group that is not an Okta-mastered group (OKTA_GROUP): Okta does not let its ' +
    'members be removed through the Groups API. Remove the membership where it is managed.',
  [`scim:${T.scimIndirectGroup}`]:
    'Nested membership: the user is in this group through another group. Remove the user ' +
    'from the group that grants it, in the target system.',
  'euroid-scim':
    'EuroID SCIM token scope: EuroID does not change tokens from a review. Remove the scope ' +
    "from the service account's SCIM token in EuroID.",
  'euroid-admin':
    'EuroID admin role: EuroID does not change admin users from a review. Change or remove ' +
    "the admin user's role in EuroID.",
};

/** Canonical connector of a review system name, or null for systems EuroID cannot revoke in. */
function connectorOf(system: string): RevocationConnector | null {
  switch (system.trim().toLowerCase()) {
    case 'entra':
    case 'entra-id':
    case 'entraid':
      return 'entra';
    case 'ad':
    case 'active-directory':
    case 'activedirectory':
      return 'ad';
    case 'okta':
      return 'okta';
    case 'scim':
      return 'scim';
    default:
      return null;
  }
}

/** True for the targets a campaign reviews per group membership (Entra ID, AD, Okta, SCIM). */
export function readsMemberships(system: string): boolean {
  return connectorOf(String(system ?? '')) !== null;
}

/**
 * `accounts`: the run removes account items (patch access-review:account-revocation); runs
 * from before it record them as manual action. An account in a target whose memberships are
 * reviewed is never removed from a review.
 */
export function routeRevocation(
  entitlement: { system: string; type: string },
  options: { accounts?: boolean } = {},
): RevocationRoute {
  const system = String(entitlement.system ?? '');
  const type = String(entitlement.type ?? '')
    .trim()
    .toLowerCase();
  const connector = connectorOf(system);
  if (connector && type === T.group) return { connector };
  if (options.accounts && !connector && type === T.account) return { account: true };
  const manual =
    (connector && MANUAL[`${connector}:${type}`]) || MANUAL[system.trim().toLowerCase()];
  if (manual) return { manual };
  return {
    manual:
      `EuroID has no revocation for "${entitlement.type}" access in "${system}". ` +
      'Remove it in that system.',
  };
}

const SUMMARY_KEY: Record<RevocationOutcome, keyof RevocationSummary> = {
  removed: 'removed',
  'already-gone': 'alreadyGone',
  'manual-action-needed': 'manualActionNeeded',
  failed: 'failed',
};

/** Outcome counts over the items' entitlements; null when nothing has a revocation result. */
export function summarizeRevocations(
  items: Array<{ entitlements?: Array<{ revocation?: { outcome: RevocationOutcome } }> }>,
): RevocationSummary | null {
  const summary: RevocationSummary = {
    removed: 0,
    alreadyGone: 0,
    manualActionNeeded: 0,
    failed: 0,
  };
  let any = false;
  for (const item of items) {
    for (const ent of item.entitlements ?? []) {
      const key = ent.revocation ? SUMMARY_KEY[ent.revocation.outcome] : undefined;
      if (!key) continue;
      summary[key]++;
      any = true;
    }
  }
  return any ? summary : null;
}
