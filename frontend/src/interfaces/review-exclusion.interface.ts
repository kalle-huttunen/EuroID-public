/**
 * Access review exclusions (backend: modules/policy, review-exclusion.service.ts): a revoke in an
 * access review kept as a durable exception. While active, the policy engine leaves the revoked
 * entitlement (an account item: every grant in the system) out of the identity's access.
 * GET /identity/:id/access/review-exclusions, POST .../review-exclusions/:exclusionId/lift
 * (policy-admin; starts the identity's re-evaluation, for an account onboarding; backend
 * modules/mover), GET
 * /policy/review-exclusions/counts.
 */

export interface IReviewExclusionPolicy {
  policyId: string;
  /** The policy's name when the exclusion was recorded. */
  policyName: string;
}

export interface IReviewExclusion {
  /** The id the lift route takes. */
  _id: string;
  identityId: string;
  /** The system as the review named it (entra-id, ad, okta, scim, github, ...). */
  targetSystem: string;
  /** entitlement: one group, role or license; account: every grant in the system. */
  scope: 'entitlement' | 'account';
  /** The review entitlement type (group, directory-role, account, ...). */
  entitlementType: string;
  entitlementName: string;
  /** The entitlement's id in the target (group object id, DN); none for an account. */
  entitlementId?: string;
  campaignId: string;
  campaignName: string;
  itemId: string;
  /** revoked by a reviewer, or expired: not reviewed by the deadline and auto-revoked. */
  decision: 'revoked' | 'expired';
  /** The reviewer who revoked it; none for an auto-revoked expired item. */
  reviewer?: string;
  justification?: string;
  /** When the reviewer decided (ISO). */
  decidedAt?: string;
  /** When the campaign close recorded it (ISO). */
  createdAt?: string;
  grantingPolicies: IReviewExclusionPolicy[];
  status: 'active' | 'lifted';
  /** The policy-admin who lifted it, or 'system' (the identity's offboarding completed). */
  liftedBy?: string;
  liftedAt?: string;
  /** Why the system lifted it ('identity offboarded'). */
  liftReason?: string;
}

/** The run a lift starts: the re-evaluation (an entitlement) or onboarding (an account). */
export type ReviewExclusionLiftRunType = 'reevaluation' | 'onboarding';

/** POST /identity/:id/access/review-exclusions/:exclusionId/lift */
export interface IReviewExclusionLift {
  exclusion: IReviewExclusion;
  /** The run that gives the access back, or why it did not start (the lift stays done). */
  run:
    | { type: ReviewExclusionLiftRunType; started: true; workflowId: string }
    | { type: ReviewExclusionLiftRunType; started: false; reason: string };
}

/** Exclusions counted against the policy that granted the revoked entitlement. */
export interface IPolicyReviewExclusionCount {
  policyId: string;
  policyName: string;
  active: number;
  lifted: number;
}
