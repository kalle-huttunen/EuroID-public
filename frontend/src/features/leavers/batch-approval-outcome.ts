/**
 * What approving a paused HR batch (joiners, movers, leavers) started, for the toast. The approve
 * routes answer 200 also when some or all members did not start: a run that could not be started
 * (Temporal down), or a member who left, changed or was handled otherwise since the batch paused.
 * So the toast is a success only when every member started, or is starting; otherwise it is a
 * warning that says how many did not, with the reason the answer gives.
 *
 * Every approve route answers before the runs start (they start right after, one by one): a
 * member the answer shows not started yet (leavers `queued`, joiners `waiting`, movers
 * `pending-approval`) and without a start error is starting, and the toast says "Starting". What
 * becomes of each one shows in the batch history, not in this answer.
 */

/** Member statuses an approve answer shows before the member's run is started. */
const NOT_STARTED_YET = new Set(['queued', 'waiting', 'pending-approval']);

/** The fields of an approve answer the outcome is read from. */
interface ApprovedBatch {
  identityCount: number;
  startedCount?: number;
  items: Array<{ status?: string; startError?: string; closeReason?: string }>;
}

/** How long the warning toast stays: long enough to read the reason. */
export const APPROVAL_WARNING_SECONDS = 10;

export interface ApprovalOutcome {
  level: 'success' | 'warning';
  text: string;
}

/** `run` names one started workflow in the singular: "onboarding run", "offboarding". */
export function approvalOutcome(batch: ApprovedBatch, run: string): ApprovalOutcome {
  const total = batch.identityCount;
  const starting = batch.items.filter(
    (i) => NOT_STARTED_YET.has(i.status ?? '') && !i.startError,
  ).length;
  // Started, or starting right after the answer
  const begun = (batch.startedCount ?? 0) + starting;
  const verb = starting > 0 ? 'Starting' : 'Started';
  const runs = (n: number) => `${n} ${n === 1 ? run : `${run}s`}`;
  if (begun >= total) {
    const text =
      starting > 0
        ? `Starting ${runs(begun)}. The batch history shows each one as it starts, or why it does not.`
        : `Started ${runs(begun)}`;
    return { level: 'success', text };
  }

  // A start that failed is what the admin can act on, so it comes before a closed member.
  const reasons = [
    ...batch.items.map((item) => item.startError),
    ...batch.items.map((item) => item.closeReason),
  ].filter((reason): reason is string => !!reason);
  const label = new Set(reasons).size > 1 ? 'First reason' : 'Reason';
  const why = reasons.length ? ` ${label}: ${reasons[0].replace(/\.$/, '')}.` : '';
  return {
    level: 'warning',
    text: `${verb} ${begun} of ${runs(total)}. Not started: ${total - begun}.${why} The batch history shows each one.`,
  };
}
