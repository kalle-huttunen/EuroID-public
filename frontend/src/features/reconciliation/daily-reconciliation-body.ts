/**
 * What [Run daily reconciliation] sends (POST /reconciliation/start-daily). Reconciliation reads
 * accounts in Entra ID, AD and SCIM only (`fetchUserFromSystem` in
 * backend/src/activities/reconciliation.activities.ts, system names `entra-id`, `ad`, `scim`).
 */

export const SYSTEM_LABELS: Record<string, string> = {
  'entra-id': 'Entra ID',
  ad: 'Active Directory',
  scim: 'SCIM',
};

/**
 * The systems a run scans: Entra ID always (its connector config or the ENTRA_* environment
 * variables; a run that cannot read it names it in the batch errors and changes nothing there),
 * AD and SCIM when the tenant installed their connector.
 */
export function dailyRunTargets(installed: string[]): string[] {
  return ['entra-id', ...['ad', 'scim'].filter((name) => installed.includes(name))];
}

/** The start body; auto-correct as the operator chose it in the confirmation. */
export function dailyRunBody(targetSystems: string[], autoCorrect: boolean) {
  return {
    // No enabled or cronSchedule: a run starts on request, the API refuses a schedule
    targetSystems,
    autoCorrect,
    autoCorrectTypes: autoCorrect ? ['MISSING_USER', 'STATUS_MISMATCH'] : [],
    requireApprovalForDeletes: true,
    notifyOnDrift: true,
    maxDriftsBeforeAlert: 10,
    criticalDriftAlertThreshold: 5,
  };
}
