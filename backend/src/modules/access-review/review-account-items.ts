/**
 * Review entitlements for the targets whose memberships a campaign cannot read (GitHub,
 * ServiceNow, the targets that keep no account such as File outbound, and any other target
 * that is not Entra ID, AD, Okta or SCIM): the entitlement is the identity's account there.
 * One per target the identity has an account in, by the rule the mover uses
 * (hasProvisionedAccount: provisioned once, until a deprovision). Revoking one removes the
 * account at campaign close through offboarding's per-target deprovision
 * (activities/access-review-account-revocation.ts).
 */
import { hasProvisionedAccount, targetAccountId } from '../identity/identity-provisioning.service';
import type { LinkedAccount, ProvisioningState } from '../identity/schemas/identity.schema';
import type { ReviewEntitlement } from './schemas/review-item.schema';
import { readsMemberships, REVIEW_ENTITLEMENT_TYPES as T } from './review-revocation';

type AccountEntry = Pick<
  ProvisioningState,
  'targetSystem' | 'status' | 'provisionedAt' | 'writebackComplete' | 'grantedBy'
>;

export function accountEntitlements(identity: {
  provisioning?: AccountEntry[];
  sources?: Array<Pick<LinkedAccount, 'sourceName' | 'externalId' | 'sourceRole'>>;
}): ReviewEntitlement[] {
  const entitlements: ReviewEntitlement[] = [];
  for (const entry of identity.provisioning ?? []) {
    if (readsMemberships(entry.targetSystem)) continue;
    const accountId = targetAccountId(identity.sources, entry.targetSystem);
    if (!hasProvisionedAccount(entry, accountId)) continue;
    entitlements.push({
      system: entry.targetSystem,
      type: T.account,
      name: 'Account',
      ...(accountId ? { accountId } : {}),
      policyManaged: (entry.grantedBy ?? 'policy') === 'policy',
    });
  }
  return entitlements;
}
