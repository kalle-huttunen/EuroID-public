/**
 * Access intelligence (backend `modules/intelligence`): reviewer quality scores (collection
 * `reviewer_quality_scores`), peer groups with their entitlement baseline and outliers
 * (`peer_groups`), an identity's recommended entitlements and the unusual-request check. Written
 * out from the Mongoose schemas and the service: the generated types carry no response bodies for
 * these routes. The nightly intelligence batch computes the scores and the groups; the API only
 * reads them.
 */

/** The four signals behind a reviewer's score in one campaign. */
export interface IReviewerSignals {
  /** Approved decisions out of all decisions, 0 to 1. Above 0.95 costs 30 points. */
  approvalRate: number;
  /**
   * From the item's creation to the decision, averaged. Under the decision time threshold
   * (`decisionTimeThresholdSeconds`, 30 s by default) costs 25 points.
   */
  avgDecisionTimeSeconds: number;
  /**
   * 1 when the score's bulk approval rule was met (`bulkApproveWindowCount` approvals within
   * `bulkApproveWindowMinutes`, 10 within 5 by default), else 0. Costs 20 points.
   */
  bulkApproveCount: number;
  /** Approvals without a justification out of all approvals, 0 to 1. Above 0.5 costs 25 points. */
  noJustificationRate: number;
}

/** One reviewer in one completed campaign, as GET /intelligence/reviewer-quality answers it. */
export interface IReviewerQualityScore {
  _id: string;
  tenantId: string;
  /** Who decided: the reviewer's email as the decide route records it. */
  reviewerId: string;
  /** The campaign's `campaignId` (a UUID). */
  campaignId: string;
  /** 0 to 100: 100 minus the signals' penalties. */
  qualityScore: number;
  signals: IReviewerSignals;
  /** `itemId`s approved without a justification in under 15 seconds. */
  flaggedDecisions: string[];
  /**
   * The decision time threshold the score was computed with (INTELLIGENCE_RUBBER_STAMP_THRESHOLD_MS).
   * Absent on a score from before it was stored, which used 30 s.
   */
  decisionTimeThresholdSeconds?: number;
  /**
   * The bulk approval rule the score was computed with: this many approvals
   * (INTELLIGENCE_BULK_APPROVE_WINDOW_COUNT) within `bulkApproveWindowMinutes`. Absent on a score
   * from before they were stored, which used 10 approvals within 5 minutes.
   */
  bulkApproveWindowCount?: number;
  bulkApproveWindowMinutes?: number;
  calculatedAt: string;
  createdAt?: string;
  updatedAt?: string;
}

/** A page of scores, lowest score first. */
export interface IReviewerQualityPage {
  data: IReviewerQualityScore[];
  total: number;
}

/**
 * How the members holding an entitlement got it: role-based rules (`policy`) or access requests
 * (`request`).
 */
export type PeerGrantedBy = 'policy' | 'request';

/**
 * How many of a group's members hold an entitlement: rule-given access on a synced account and
 * what their active access requests give them.
 */
export interface IEntitlementBaseline {
  /** `system::id`: a rule's target id, or a requested entitlement's native id. */
  entitlementId: string;
  system: string;
  /** The rule's target id, or the requested entitlement's name. */
  name: string;
  /** 0 to 1. */
  holdRate: number;
  /** Absent on a group built before it was recorded. */
  grantedBy?: PeerGrantedBy[];
}

/** A member whose access differs from the group's. */
export interface IPeerGroupOutlier {
  /** The identity's `_id`. */
  identityId: string;
  /** `system::id` the member has and few peers have. */
  uniqueEntitlements: string[];
  /** `system::id` most peers have and the member does not. */
  missingBaseline: string[];
  /** 0 to 100: 10 per unusual and 5 per missing entitlement. */
  deviationScore: number;
}

/** One peer group as GET /intelligence/peer-groups answers it (the lean document). */
export interface IPeerGroup {
  _id: string;
  tenantId: string;
  /** Hash of the group's attributes; GET /peer-groups/:groupKey/outliers takes it. */
  groupKey: string;
  attributes: { department?: string; jobTitle?: string; location?: string };
  memberCount: number;
  /** Members' identity `_id`s. */
  memberIds: string[];
  entitlementBaseline: IEntitlementBaseline[];
  outliers: IPeerGroupOutlier[];
  calculatedAt: string;
  createdAt?: string;
  updatedAt?: string;
}

/** A page of peer groups, largest first. */
export interface IPeerGroupPage {
  data: IPeerGroup[];
  total: number;
}

/** An entitlement most of the identity's peers have and the identity does not. */
export interface IAccessRecommendation {
  entitlementId: string;
  system: string;
  name: string;
  /** Share of the peer group holding it, 0 to 1. */
  holdRate: number;
  /** How the peers hold it; empty when the group was built before it was recorded. */
  grantedBy: PeerGrantedBy[];
  /** A catalog entry matches it and is requestable. */
  requestable: boolean;
  /** From the entitlement catalog; absent when the catalog has no matching entry. */
  riskLevel?: string;
}

/** Answer of POST /intelligence/unusual-check: null when the request is usual or unknown. */
export interface IUnusualRequestWarning {
  warning: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
}
