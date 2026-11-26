/**
 * The drift thresholds of a reconciliation run (maxDriftsBeforeAlert,
 * criticalDriftAlertThreshold): reached when the run found at least that many drifts, or that
 * many CRITICAL drifts, counted per drift and not per identity. 0 turns a threshold off.
 */
import { driftThresholdAlerts } from './reconciliation-alerts';
import type { SystemDrift } from './workflow-types';

const drift = (severity: SystemDrift['severity']) => ({ severity }) as SystemDrift;

/** Two identities: one with a CRITICAL and a LOW drift, one with a CRITICAL drift. */
const results = [{ drifts: [drift('CRITICAL'), drift('LOW')] }, { drifts: [drift('CRITICAL')] }];

describe('driftThresholdAlerts', () => {
  it('names each threshold the run reached, with its limit and what was found', () => {
    expect(
      driftThresholdAlerts({ maxDriftsBeforeAlert: 3, criticalDriftAlertThreshold: 2 }, results),
    ).toEqual({
      totalDrifts: 3,
      criticalDrifts: 2,
      alerts: [
        { threshold: 'maxDriftsBeforeAlert', limit: 3, found: 3 },
        { threshold: 'criticalDriftAlertThreshold', limit: 2, found: 2 },
      ],
    });
  });

  it('names none below the thresholds', () => {
    expect(
      driftThresholdAlerts({ maxDriftsBeforeAlert: 4, criticalDriftAlertThreshold: 3 }, results)
        .alerts,
    ).toEqual([]);
  });

  it('counts CRITICAL drifts, not identities whose worst drift is CRITICAL', () => {
    const oneIdentity = [{ drifts: [drift('CRITICAL'), drift('CRITICAL')] }];
    expect(
      driftThresholdAlerts({ maxDriftsBeforeAlert: 0, criticalDriftAlertThreshold: 2 }, oneIdentity)
        .alerts,
    ).toEqual([{ threshold: 'criticalDriftAlertThreshold', limit: 2, found: 2 }]);
  });

  it('treats 0 as off', () => {
    expect(
      driftThresholdAlerts({ maxDriftsBeforeAlert: 0, criticalDriftAlertThreshold: 0 }, results)
        .alerts,
    ).toEqual([]);
    expect(
      driftThresholdAlerts({ maxDriftsBeforeAlert: 0, criticalDriftAlertThreshold: 0 }, []).alerts,
    ).toEqual([]);
  });
});
