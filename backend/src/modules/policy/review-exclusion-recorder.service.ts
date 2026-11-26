/**
 * Turns the revokes an access review campaign close takes up into review exclusions
 * (AccessReviewRevocationActivities.listRevocationTasks, before any revocation result is written,
 * so a failed recording is taken up again by the activity's retry).
 *
 * Every revoked entitlement becomes one: a group membership, a directory role, an EuroID scope
 * or role, whatever the outcome of its removal (removed, already gone, manual action, failed),
 * and an account item (the identity's account in a target whose memberships the review cannot
 * read) as an exclusion of the whole system. An expired item the campaign auto-revokes is kept
 * the same way, without a reviewer.
 *
 * Each exclusion names the active policies that grant the entitlement now: the identity's
 * policy profile evaluated without exclusions (evaluateWithPolicies, once per identity), the
 * operations the new exclusion suppresses, their source policies. An identity that no longer
 * exists gets an exclusion without granting policies.
 */
import { Injectable } from '@nestjs/common';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { systemKey } from '@shared/utils/normalize-system-name';
import { IdentityService } from '../identity/identity.service';
import { PolicyEngineService, type ProvisioningOperation } from './policy-engine.service';
import { PolicyService } from './policy.service';
import type { PolicyDocument } from './schemas/policy.schema';
import type { ReviewExclusionPolicy } from './schemas/review-exclusion.schema';
import { ReviewExclusionService, type NewReviewExclusion } from './review-exclusion.service';
import { suppresses } from './review-exclusion-match';

/** Review entitlement type of an account item (review-revocation.ts REVIEW_ENTITLEMENT_TYPES). */
const ACCOUNT_TYPE = 'account';

/** One revoked review entitlement a campaign close takes up. */
export interface ReviewRevocationDecision {
  campaignId: string;
  campaignName: string;
  itemId: string;
  identityId: string;
  /** revoked by a reviewer, or expired and auto-revoked at the deadline. */
  decision: 'revoked' | 'expired';
  decidedBy?: string;
  decidedAt?: Date;
  justification?: string;
  entitlement: { system: string; type: string; name: string; nativeId?: string };
}

type ExclusionFields = Omit<NewReviewExclusion, 'grantingPolicies'>;

/** The exclusion a decision keeps, without its granting policies. */
export function exclusionOf(d: ReviewRevocationDecision): ExclusionFields {
  const { entitlement: e } = d;
  const account = e.type.trim().toLowerCase() === ACCOUNT_TYPE;
  return {
    identityId: d.identityId,
    targetSystem: e.system,
    scope: account ? 'account' : 'entitlement',
    entitlementType: e.type,
    entitlementName: e.name,
    ...(!account && e.nativeId ? { entitlementId: e.nativeId } : {}),
    campaignId: d.campaignId,
    campaignName: d.campaignName,
    itemId: d.itemId,
    decision: d.decision,
    ...(d.decision === 'revoked' && d.decidedBy ? { reviewer: d.decidedBy } : {}),
    ...(d.justification ? { justification: d.justification } : {}),
    ...(d.decidedAt ? { decidedAt: d.decidedAt } : {}),
  };
}

@Injectable()
export class ReviewExclusionRecorder {
  constructor(
    private readonly exclusions: ReviewExclusionService,
    private readonly engine: PolicyEngineService,
    private readonly policies: PolicyService,
    private readonly identityService: IdentityService,
  ) {}

  /** Record an exclusion for each decision (runs in the tenant's context). */
  async record(decisions: ReviewRevocationDecision[], tenantId: string): Promise<void> {
    if (decisions.length === 0) return;
    const active = await this.policies.findActive();
    const grants = new Map<string, Promise<ProvisioningOperation[]>>();
    for (const decision of decisions) {
      const exclusion = exclusionOf(decision);
      let granted = grants.get(decision.identityId);
      if (!granted) {
        granted = this.policyGrants(decision.identityId, active, tenantId);
        grants.set(decision.identityId, granted);
      }
      const grantingPolicies = grantingPoliciesOf(exclusion, await granted, active);
      await this.exclusions.record({ ...exclusion, grantingPolicies }, tenantId);
    }
  }

  /** What the active policies grant the identity now, no exclusion applied. */
  private async policyGrants(
    identityId: string,
    policies: PolicyDocument[],
    tenantId: string,
  ): Promise<ProvisioningOperation[]> {
    const identity = await this.identityService.findIdentityById(identityId);
    if (!identity) return [];
    const profile = await this.identityService.buildProfileWithContractsForPolicy(identity);
    const intent = await this.engine.evaluateWithPolicies(
      { ...profile, _id: identityId } as unknown as StandardUserDto,
      policies,
      tenantId,
    );
    return intent.operations;
  }
}

/** The active policies (by id) whose operations the exclusion suppresses. */
function grantingPoliciesOf(
  exclusion: ExclusionFields,
  operations: ProvisioningOperation[],
  policies: PolicyDocument[],
): ReviewExclusionPolicy[] {
  const match = {
    id: '',
    campaignId: exclusion.campaignId,
    systemKey: systemKey(exclusion.targetSystem),
    scope: exclusion.scope,
    entitlementType: exclusion.entitlementType,
    entitlementName: exclusion.entitlementName,
    ...(exclusion.entitlementId ? { entitlementId: exclusion.entitlementId } : {}),
  };
  const names = new Set(
    operations.filter((op) => suppresses(match, op)).map((op) => op.sourcePolicy),
  );
  return policies
    .filter((p) => names.has(p.name))
    .map((p) => ({ policyId: String(p._id), policyName: p.name }));
}
