/**
 * Shared fixtures of the access intelligence tests, shaped as the API answers: lean
 * `reviewer_quality_scores` and `peer_groups` documents (`_id`, `tenantId`, timestamps, `__v`)
 * inside `{ data, total }` for the list routes, the bare outlier array of
 * GET /peer-groups/:groupKey/outliers and the recommendation array of GET /recommendations/:id
 * (no `riskLevel` key when the catalog has no entry). The numbers follow the backend's rules with
 * the default thresholds, so a score matches its signals and an outlier its group. A score scored
 * before the threshold was recorded has no `decisionTimeThresholdSeconds` (nor the bulk approval
 * rule), and a group built before the baseline recorded how members hold an entitlement has no
 * `grantedBy`.
 */
import { fireEvent, waitFor } from '@testing-library/react';
import type { ReviewCampaign } from '@api/intelligence-api';
import type {
  IAccessRecommendation,
  IPeerGroup,
  IPeerGroupOutlier,
  IReviewerQualityScore,
} from '../../../interfaces';

/**
 * Opens the select box and clicks the option with this text. In tests every rc-select shares one
 * list id, so the option is looked up in the dropdown that is open, not through aria-controls.
 */
export async function choose(box: HTMLElement, optionText: string) {
  fireEvent.mouseDown(box);
  const option = await waitFor(() => {
    const open = document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
    const found = Array.from(open)
      .flatMap((d) => Array.from(d.querySelectorAll('.ant-select-item-option')))
      .find((o) => o.textContent === optionText);
    if (!found) throw new Error(`no option "${optionText}"`);
    return found as HTMLElement;
  });
  fireEvent.click(option);
}

/** The texts of the options the open select box offers. */
export const offeredOptions = () =>
  Array.from(
    document.querySelectorAll(
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option',
    ),
  ).map((o) => o.textContent);

/**
 * The open modal with this title. In tests every rc-dialog shares one aria-labelledby id, so a
 * role query by name would always read the first modal's title.
 */
export const dialog = (title: string) =>
  waitFor(() => {
    const found = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(
      (d) => d.querySelector('.ant-modal-title')?.textContent === title,
    );
    if (!found) throw new Error(`no dialog titled ${title}`);
    return found;
  });

export const apiError = (status: number, message: string) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { statusCode: status, message } },
  });

const calculatedAt = '2026-11-23T04:00:12.000Z';
const stamps = { createdAt: calculatedAt, updatedAt: calculatedAt, __v: 0 };

// ── Campaigns (GET /access-reviews/campaigns) ─────────────────────────

const campaign = (
  fields: Pick<ReviewCampaign, 'campaignId' | 'name' | 'status'>,
): ReviewCampaign => ({
  scope: { type: 'all' },
  createdBy: 'admin@euroid.local',
  deadline: '2026-11-20T00:00:00.000Z',
  autoRevokeOnExpiry: false,
  stats: { totalItems: 12, approved: 10, revoked: 2, pending: 0, expired: 0 },
  ...fields,
});

export const q3Campaign = campaign({
  campaignId: '4b4e1f0e-6c1b-4f5e-9a51-0c2a6b9d0003',
  name: 'Q3 2026 access certification',
  status: 'COMPLETED',
});
export const financeCampaign = campaign({
  campaignId: '4b4e1f0e-6c1b-4f5e-9a51-0c2a6b9d0007',
  name: 'Finance systems review',
  status: 'COMPLETED',
});
export const q4Campaign = campaign({
  campaignId: '4b4e1f0e-6c1b-4f5e-9a51-0c2a6b9d0004',
  name: 'Q4 2026 access certification',
  status: 'ACTIVE',
});
export const CAMPAIGNS = [q4Campaign, q3Campaign, financeCampaign];

// ── Reviewer quality (GET /intelligence/reviewer-quality) ─────────────

type ScoreDoc = IReviewerQualityScore & { __v: number };

/** 100 - 30 (all approvals) - 25 (8 s) - 20 (bulk) = 25. */
export const rubberStamper: ScoreDoc = {
  _id: '6741c0f2a9d3e5b1c2f40c01',
  tenantId: 'tenant-a',
  reviewerId: 'mika.virtanen@corp.example',
  campaignId: q3Campaign.campaignId,
  qualityScore: 25,
  signals: {
    approvalRate: 1,
    avgDecisionTimeSeconds: 8.4,
    bulkApproveCount: 1,
    noJustificationRate: 0.2,
  },
  flaggedDecisions: ['item-11', 'item-12', 'item-13'],
  decisionTimeThresholdSeconds: 30,
  calculatedAt,
  ...stamps,
};

/** 100 - 30 (97 % approvals) = 70: medium, as 70 is not above 70. */
export const quickApprover: ScoreDoc = {
  _id: '6741c0f2a9d3e5b1c2f40c02',
  tenantId: 'tenant-a',
  reviewerId: 'liisa.korhonen@corp.example',
  campaignId: financeCampaign.campaignId,
  qualityScore: 70,
  signals: {
    approvalRate: 0.97,
    avgDecisionTimeSeconds: 600,
    bulkApproveCount: 0,
    noJustificationRate: 0.1,
  },
  flaggedDecisions: [],
  calculatedAt,
  ...stamps,
};

/**
 * Scored with INTELLIGENCE_RUBBER_STAMP_THRESHOLD_MS=60000: 100 - 25 (45 s, under 60 s) = 75.
 * Not in SCORES.
 */
export const slowThresholdReviewer: ScoreDoc = {
  _id: '6741c0f2a9d3e5b1c2f40c04',
  tenantId: 'tenant-a',
  reviewerId: 'olli.nieminen@corp.example',
  campaignId: financeCampaign.campaignId,
  qualityScore: 75,
  signals: {
    approvalRate: 0.8,
    avgDecisionTimeSeconds: 45,
    bulkApproveCount: 0,
    noJustificationRate: 0,
  },
  flaggedDecisions: [],
  decisionTimeThresholdSeconds: 60,
  calculatedAt,
  ...stamps,
};

/**
 * Scored with INTELLIGENCE_BULK_APPROVE_WINDOW_COUNT=4: 100 - 20 (4 approvals within 5 minutes) =
 * 80. Not in SCORES.
 */
export const smallBulkWindowReviewer: ScoreDoc = {
  _id: '6741c0f2a9d3e5b1c2f40c05',
  tenantId: 'tenant-a',
  reviewerId: 'sami.laine@corp.example',
  campaignId: financeCampaign.campaignId,
  qualityScore: 80,
  signals: {
    approvalRate: 0.8,
    avgDecisionTimeSeconds: 45,
    bulkApproveCount: 1,
    noJustificationRate: 0,
  },
  flaggedDecisions: [],
  decisionTimeThresholdSeconds: 30,
  bulkApproveWindowCount: 4,
  bulkApproveWindowMinutes: 5,
  calculatedAt,
  ...stamps,
};

/** No signal: 100. */
export const carefulReviewer: ScoreDoc = {
  _id: '6741c0f2a9d3e5b1c2f40c03',
  tenantId: 'tenant-a',
  reviewerId: 'admin@euroid.local',
  campaignId: q3Campaign.campaignId,
  qualityScore: 100,
  signals: {
    approvalRate: 0.72,
    avgDecisionTimeSeconds: 7200,
    bulkApproveCount: 0,
    noJustificationRate: 0,
  },
  flaggedDecisions: [],
  calculatedAt,
  ...stamps,
};

export const SCORES = [rubberStamper, quickApprover, carefulReviewer];

// ── Peer groups (GET /intelligence/peer-groups) ───────────────────────

export const AINO_ID = '64b7f0c2a1b2c3d4e5f60201';
export const EERO_ID = '64b7f0c2a1b2c3d4e5f60202';
const financeMembers = [
  AINO_ID,
  EERO_ID,
  '64b7f0c2a1b2c3d4e5f60203',
  '64b7f0c2a1b2c3d4e5f60204',
  '64b7f0c2a1b2c3d4e5f60205',
  '64b7f0c2a1b2c3d4e5f60206',
];

/** The catalog's native id of SG-Payroll-Admins: the peer baseline names it by it. */
const PAYROLL_ADMINS = 'entra-id::4b1e2f3a-6c7d-4e8f-9a0b-1c2d3e4f5a6b';

/** Aino has what 1 of 6 has (+10) and lacks what 5 of 6 have (+5). */
export const ainoOutlier: IPeerGroupOutlier = {
  identityId: AINO_ID,
  uniqueEntitlements: [PAYROLL_ADMINS],
  missingBaseline: ['ad::CN=Finance-Share,OU=Groups,DC=corp,DC=example'],
  deviationScore: 15,
};

type GroupDoc = IPeerGroup & { __v: number };

export const financeGroup: GroupDoc = {
  _id: '6741c0f2a9d3e5b1c2f40d01',
  tenantId: 'tenant-a',
  groupKey: '3f9a1c2b4d5e6f70',
  attributes: { department: 'Finance', jobTitle: 'Accountant' },
  memberCount: 6,
  memberIds: financeMembers,
  entitlementBaseline: [
    {
      entitlementId: PAYROLL_ADMINS,
      system: 'entra-id',
      name: 'SG-Payroll-Admins',
      holdRate: 1 / 6,
      grantedBy: ['request'],
    },
    {
      entitlementId: 'entra-id::SG-Finance',
      system: 'entra-id',
      name: 'SG-Finance',
      holdRate: 1,
      grantedBy: ['policy', 'request'],
    },
    {
      entitlementId: 'ad::CN=Finance-Share,OU=Groups,DC=corp,DC=example',
      system: 'ad',
      name: 'CN=Finance-Share,OU=Groups,DC=corp,DC=example',
      holdRate: 5 / 6,
      grantedBy: ['policy'],
    },
  ],
  outliers: [ainoOutlier],
  calculatedAt,
  ...stamps,
};

export const salesGroup: GroupDoc = {
  _id: '6741c0f2a9d3e5b1c2f40d02',
  tenantId: 'tenant-a',
  groupKey: '9c0d1e2f3a4b5c6d',
  attributes: { department: 'Sales', jobTitle: 'Account Manager' },
  memberCount: 4,
  memberIds: [
    '64b7f0c2a1b2c3d4e5f60301',
    '64b7f0c2a1b2c3d4e5f60302',
    '64b7f0c2a1b2c3d4e5f60303',
    '64b7f0c2a1b2c3d4e5f60304',
  ],
  entitlementBaseline: [
    { entitlementId: 'entra-id::SG-Sales', system: 'entra-id', name: 'SG-Sales', holdRate: 1 },
  ],
  outliers: [],
  // Computed the night before: a batch run that stopped part way keeps the groups it did not
  // reach. Built before the baseline recorded how members hold an entitlement: no grantedBy.
  calculatedAt: '2026-11-22T04:00:09.000Z',
  ...stamps,
};

/** GET /identity/:id for Aino (profile flattened next to `_id`). */
export const ainoIdentity = {
  _id: AINO_ID,
  email: 'aino.laine@corp.example',
  firstName: 'Aino',
  lastName: 'Laine',
  status: 'ACTIVE',
  departmentName: 'Finance',
  jobTitle: 'Accountant',
};

// ── Recommendations (GET /intelligence/recommendations/:identityId) ───

export const RECOMMENDATIONS: IAccessRecommendation[] = [
  {
    entitlementId: 'ad::CN=Finance-Share,OU=Groups,DC=corp,DC=example',
    system: 'ad',
    name: 'CN=Finance-Share,OU=Groups,DC=corp,DC=example',
    holdRate: 5 / 6,
    grantedBy: ['request'],
    requestable: true,
    riskLevel: 'MEDIUM',
  },
  // Not in the catalog: the API leaves riskLevel out, and it cannot be requested.
  {
    entitlementId: 'entra-id::M365-E5',
    system: 'entra-id',
    name: 'M365-E5',
    holdRate: 0.75,
    grantedBy: ['policy'],
    requestable: false,
  },
  // In the catalog, not offered for request; from a group built before grantedBy was recorded.
  {
    entitlementId: 'entra-id::SG-Finance-Reports',
    system: 'entra-id',
    name: 'SG-Finance-Reports',
    holdRate: 0.7,
    grantedBy: [],
    requestable: false,
    riskLevel: 'HIGH',
  },
];
