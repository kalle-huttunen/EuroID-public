/**
 * The drift thresholds of a reconciliation run (ReconciliationConfig.maxDriftsBeforeAlert and
 * criticalDriftAlertThreshold, 0 = off): reached when the drifts the run gathered are at least
 * that many, or the CRITICAL ones are. Drifts are counted one by one, not per identity.
 *
 * Pure and dependency-free: dailyReconciliationWorkflow imports it (the workflow bundle).
 */
import type { ReconciliationAlert, ReconciliationConfig, SystemDrift } from './workflow-types';

export interface DriftThresholdCounts {
  totalDrifts: number;
  criticalDrifts: number;
  /** Each threshold reached, in the order of the settings; empty when none was. */
  alerts: ReconciliationAlert[];
}

export function driftThresholdAlerts(
  config: Pick<ReconciliationConfig, 'maxDriftsBeforeAlert' | 'criticalDriftAlertThreshold'>,
  results: ReadonlyArray<{ drifts: ReadonlyArray<Pick<SystemDrift, 'severity'>> }>,
): DriftThresholdCounts {
  let totalDrifts = 0;
  let criticalDrifts = 0;
  for (const result of results) {
    for (const drift of result.drifts) {
      totalDrifts += 1;
      if (drift.severity === 'CRITICAL') criticalDrifts += 1;
    }
  }
  const alerts: ReconciliationAlert[] = [];
  const reached = (threshold: ReconciliationAlert['threshold'], limit: number, found: number) => {
    if (limit > 0 && found >= limit) alerts.push({ threshold, limit, found });
  };
  reached('maxDriftsBeforeAlert', config.maxDriftsBeforeAlert, totalDrifts);
  reached('criticalDriftAlertThreshold', config.criticalDriftAlertThreshold, criticalDrifts);
  return { totalDrifts, criticalDrifts, alerts };
}
