/**
 * What an Auto-Fix (POST /reconciliation/drifts/bulk-correct) did, for the toast. The route
 * answers 201 also when some or all drifts were not corrected (a drift no longer open, or a
 * correction the target system could not make), each with its reason in `failures`. So the toast
 * is a success only when every selected drift was corrected; otherwise it is a warning that says
 * how many were not, with the reason the answer gives. Same shape as the batch approval toasts
 * (`features/leavers/batch-approval-outcome.ts`).
 */

/** A bulk-correct answer: `corrected` and `failed` are counts, `failures` the drifts not corrected. */
export interface BulkCorrectAnswer {
  corrected?: number;
  failed?: number;
  failures?: Array<{ driftId: string; error?: string }>;
}

/** How long the warning toast stays: long enough to read the reason. */
export const AUTO_FIX_WARNING_SECONDS = 10;

export interface AutoFixOutcome {
  level: 'success' | 'warning';
  text: string;
}

/** `selected`: how many drifts the admin chose to fix. */
export function autoFixOutcome(answer: BulkCorrectAnswer, selected: number): AutoFixOutcome {
  const corrected = answer.corrected ?? 0;
  const drifts = (n: number) => `${n} ${n === 1 ? 'drift' : 'drifts'}`;
  if (corrected >= selected) {
    return { level: 'success', text: `Auto-Fix corrected ${drifts(corrected)}.` };
  }

  const reasons = (answer.failures ?? [])
    .map((failure) => failure.error)
    .filter((reason): reason is string => !!reason);
  const label = new Set(reasons).size > 1 ? 'First reason' : 'Reason';
  const why = reasons.length ? ` ${label}: ${reasons[0].replace(/\.$/, '')}.` : '';
  return {
    level: 'warning',
    text: `Auto-Fix corrected ${corrected} of ${drifts(selected)}. Not corrected: ${selected - corrected}.${why}`,
  };
}
