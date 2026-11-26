/**
 * Anomaly labels, tag colours and the result messages of the anomaly actions
 * (`modules/anomaly/anomaly.controller.ts`: acknowledge, dismiss and resolve need operator,
 * analyze super-admin).
 */
import type {
  Anomaly,
  AnomalyAnalysisResult,
  AnomalySeverity,
  AnomalyStatus,
} from '@api/intelligence-api';

export const ANOMALY_TYPE_LABELS: Record<string, string> = {
  TIME_BASED: 'Time-based',
  PEER_DEVIATION: 'Peer Deviation',
  VELOCITY: 'Velocity',
  PRIVILEGE_ESCALATION: 'Privilege Escalation',
  ORPHAN_ACCESS: 'Orphan Access',
};

export const SEVERITY_COLORS: Record<AnomalySeverity, string> = {
  low: 'default',
  medium: 'warning',
  high: 'orange',
  critical: 'red',
};

export const STATUS_COLORS: Record<AnomalyStatus, string> = {
  open: 'red',
  acknowledged: 'orange',
  dismissed: 'default',
  resolved: 'default',
};

/** Still to be handled: open, or acknowledged and not yet closed. */
export function isActive(anomaly: Pick<Anomaly, 'status'>): boolean {
  return anomaly.status === 'open' || anomaly.status === 'acknowledged';
}

export interface AnomalyOutcome {
  type: 'success' | 'info' | 'warning' | 'error';
  message: string;
  description?: string;
}

/** None of the status changes touches access or recalculates a risk score. */
const NO_SIDE_EFFECTS = 'Access is not changed and no risk score is recalculated.';

export function acknowledgeOutcome(after: Anomaly): AnomalyOutcome {
  return {
    type: 'success',
    message: after.acknowledgedBy ? `Acknowledged by ${after.acknowledgedBy}.` : 'Acknowledged.',
    description: `It stays on the list as acknowledged until it is resolved or dismissed. ${NO_SIDE_EFFECTS}`,
  };
}

export function resolveOutcome(): AnomalyOutcome {
  return {
    type: 'success',
    message: 'Resolved. The anomaly is closed.',
    description: `Recorded in the audit log as anomaly.resolved. ${NO_SIDE_EFFECTS}`,
  };
}

export function dismissOutcome(reason?: string): AnomalyOutcome {
  return {
    type: 'success',
    message: reason ? `Dismissed: ${reason}` : 'Dismissed without a reason.',
    description: `Recorded in the audit log as anomaly.resolved with status dismissed. ${NO_SIDE_EFFECTS}`,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const DEDUPE_NOTE = 'An anomaly already open with the same type and pattern is not created again.';

/** "Failed: Time-based (1 identity), Orphan Access (36 identities)." in the rules' own order. */
function failedRulesText(result: AnomalyAnalysisResult, withCounts: boolean): string {
  const byRule = result.ruleFailures?.byRule ?? {};
  const names = Object.keys(ANOMALY_TYPE_LABELS)
    .filter((rule) => byRule[rule as keyof typeof byRule])
    .map((rule) => {
      const label = ANOMALY_TYPE_LABELS[rule];
      const count = byRule[rule as keyof typeof byRule] ?? 0;
      return withCounts ? `${label} (${plural(count, 'identity', 'identities')})` : label;
    });
  const they = result.ruleFailures.rules === 1 ? 'it' : 'they';
  return `Failed: ${names.join(', ')}. What ${they} would find is missing from this result; the server log has the cause.`;
}

/**
 * What a run of the rules says: what it found, out of how many identities, and which rules
 * failed. A failed rule found nothing it could report, so its identities are not shown as clean.
 */
export function analysisOutcome(
  result: AnomalyAnalysisResult,
  scope: 'identity' | 'batch',
): AnomalyOutcome {
  const created = result.anomaliesCreated;
  const found =
    created === 0 ? 'no new anomalies' : plural(created, 'new anomaly', 'new anomalies');
  const failures = result.ruleFailures?.rules ? result.ruleFailures : null;
  const type = created > 0 || failures ? 'warning' : 'success';
  if (scope === 'identity') {
    if (result.analyzed === 0) {
      return {
        type: 'warning',
        message: 'Nothing was analysed: the API did not find this identity.',
      };
    }
    return {
      type,
      message: failures
        ? `Analysis found ${found}; ${plural(failures.rules, 'rule', 'rules')} failed.`
        : `Analysis found ${found}.`,
      description: [failures && failedRulesText(result, false), DEDUPE_NOTE]
        .filter(Boolean)
        .join(' '),
    };
  }
  const total = result.totalIdentities;
  const analysed =
    total === undefined
      ? plural(result.analyzed, 'identity', 'identities')
      : `${result.analyzed} of ${plural(total, 'identity', 'identities')}`;
  const left = total === undefined ? 0 : total - result.analyzed;
  return {
    type,
    message:
      `Analysed ${analysed}: ${found}.` +
      (failures
        ? ` ${plural(failures.rules, 'rule', 'rules')} failed for ${plural(failures.identities, 'identity', 'identities')}.`
        : ''),
    description: [
      left === 1 &&
        'The other identity is analysed when it is provisioned or drift is detected for it, or from one of its anomalies.',
      left > 1 &&
        `The other ${left} are analysed when they are provisioned or drift is detected for them, or one by one from an anomaly.`,
      failures && failedRulesText(result, true),
      DEDUPE_NOTE,
    ]
      .filter(Boolean)
      .join(' '),
  };
}
