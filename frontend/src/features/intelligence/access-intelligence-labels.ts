/**
 * Labels and formatting for the access intelligence views: reviewer quality (Access reviews tab),
 * peer groups and outliers (`/intelligence/peer-groups`) and an identity's recommendations
 * (identity page tab). The score and threshold rules restate the backend's
 * (`modules/intelligence/intelligence.service.ts`).
 */
import dayjs from 'dayjs';
import type { IReviewerQualityScore, PeerGrantedBy } from '../../interfaces';

/** Where the data comes from; no route computes it on demand. */
export const NIGHTLY_BATCH =
  'The nightly intelligence batch computes this (04:00 UTC by default, INTELLIGENCE_BATCH_CRON).';

export const formatDateTime = (iso: string | undefined): string =>
  iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : '—';

/** A 0 to 1 rate as a whole percentage. */
export const formatPercent = (rate: number): string => `${Math.round(rate * 100)}%`;

/** Seconds as the largest whole unit: "12 s", "4 min", "3 h", "2 d". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

/**
 * `system::id`, as the peer baseline names an entitlement (`system::nativeId` when the catalog
 * has it), shown as "system: name" when its name is known, else as "system: id".
 */
export function entitlementLabel(entitlementId: string, name?: string): string {
  const at = entitlementId.indexOf('::');
  if (at < 0) return name ?? entitlementId;
  return `${entitlementId.slice(0, at)}: ${name ?? entitlementId.slice(at + 2)}`;
}

/** The latest of the rows' computation times, or undefined for none. */
export function latestCalculatedAt(rows: Array<{ calculatedAt?: string }>): string | undefined {
  return rows
    .map((r) => r.calculatedAt)
    .filter((t): t is string => !!t)
    .sort()
    .at(-1);
}

/** The trust level thresholds of the backend: above 70 high, above 40 medium, else low. */
export function qualityLevel(score: number): { label: string; color: string } {
  if (score > 70) return { label: 'High', color: 'success' };
  if (score > 40) return { label: 'Medium', color: 'warning' };
  return { label: 'Low', color: 'error' };
}

/** The rules of a score that does not name them (scored before they were stored). */
const DEFAULT_DECISION_THRESHOLD_SECONDS = 30;
const DEFAULT_BULK_APPROVE_WINDOW_COUNT = 10;
const DEFAULT_BULK_APPROVE_WINDOW_MINUTES = 5;

/**
 * The signals that cost the reviewer points, each with its penalty. The decision time threshold
 * and the bulk approval rule are the ones the score was computed with.
 */
export function scorePenalties(
  score: Pick<
    IReviewerQualityScore,
    | 'signals'
    | 'decisionTimeThresholdSeconds'
    | 'bulkApproveWindowCount'
    | 'bulkApproveWindowMinutes'
  >,
): Array<{ label: string; points: number }> {
  const {
    signals,
    decisionTimeThresholdSeconds = DEFAULT_DECISION_THRESHOLD_SECONDS,
    bulkApproveWindowCount = DEFAULT_BULK_APPROVE_WINDOW_COUNT,
    bulkApproveWindowMinutes = DEFAULT_BULK_APPROVE_WINDOW_MINUTES,
  } = score;
  const penalties: Array<{ label: string; points: number }> = [];
  if (signals.approvalRate > 0.95) penalties.push({ label: 'Approves over 95%', points: 30 });
  if (signals.avgDecisionTimeSeconds < decisionTimeThresholdSeconds) {
    penalties.push({ label: `Decides in under ${decisionTimeThresholdSeconds} s`, points: 25 });
  }
  if (signals.bulkApproveCount > 0) {
    penalties.push({
      label: `${bulkApproveWindowCount} approvals within ${bulkApproveWindowMinutes} min`,
      points: 20,
    });
  }
  if (signals.noJustificationRate > 0.5) {
    penalties.push({ label: 'Most approvals unjustified', points: 25 });
  }
  return penalties;
}

export const QUALITY_EXPLAINED =
  'A score from 0 to 100 per reviewer and completed campaign: 100, minus 30 when over 95% of the ' +
  'decisions are approvals, 25 when a decision takes under 30 seconds on average (from the item ' +
  'being created; INTELLIGENCE_RUBBER_STAMP_THRESHOLD_MS can set another threshold, which the ' +
  'score names), 20 for 10 approvals within 5 minutes (INTELLIGENCE_BULK_APPROVE_WINDOW_COUNT ' +
  'can set another count, which the score names), and 25 when most approvals have no ' +
  'justification. A low score suggests rubber-stamping; it changes nothing in the campaign.';

/** Deviation 0 to 100: 10 per unusual entitlement, 5 per missing one. */
export function deviationColor(score: number): string {
  if (score >= 50) return 'error';
  if (score >= 20) return 'warning';
  return 'default';
}

const GRANTED_BY_LABEL: Record<PeerGrantedBy, string> = {
  policy: 'Role-based rules',
  request: 'Access requests',
};

/**
 * How peers hold an entitlement: "Role-based rules", "Access requests" or both. A group built
 * before the batch recorded it has none: "Not recorded".
 */
export function grantedByLabel(grantedBy: PeerGrantedBy[] | undefined): string {
  if (!grantedBy?.length) return 'Not recorded';
  const labels = (['policy', 'request'] as const)
    .filter((g) => grantedBy.includes(g))
    .map((g) => GRANTED_BY_LABEL[g]);
  return labels.map((l, i) => (i === 0 ? l : l.toLowerCase())).join(', ');
}

/** The catalog's risk levels. */
export const RISK_COLOR: Record<string, string> = {
  LOW: 'default',
  MEDIUM: 'blue',
  HIGH: 'orange',
  CRITICAL: 'red',
};

export const groupLabel = (attributes: { department?: string; jobTitle?: string }): string =>
  [attributes.department || 'No department', attributes.jobTitle || 'No job title'].join(' · ');
