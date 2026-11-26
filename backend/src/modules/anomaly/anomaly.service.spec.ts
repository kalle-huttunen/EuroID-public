/**
 * Unit tests for anomaly detection rules and risk score computation
 */

import {
  timeBasedRule,
  peerDeviationRule,
  velocityRule,
  privilegeEscalationRule,
  orphanAccessRule,
  isWithinBusinessHours,
  isHumanActor,
  ANOMALY_TYPE_SCORES,
  type AnomalyCandidate,
} from './anomaly-rules';
import { AccessAnomalyService } from './anomaly.service';

describe('timeBasedRule', () => {
  it('flags events at 02:00 and at 19:00 (the end of business hours) as suspicious', () => {
    const result = timeBasedRule(
      [
        {
          eventId: 'e1',
          timestamp: new Date('2026-02-12T02:00:00Z'),
          actor: 'admin@example.com',
          action: 'provisioning.completed',
        },
        {
          eventId: 'e2',
          timestamp: new Date('2026-02-12T19:00:00Z'),
          actor: 'admin@example.com',
          action: 'provisioning.completed',
        },
      ],
      'UTC',
      7,
      19,
    );
    expect(result).not.toBeNull();
    expect(result?.type).toBe('TIME_BASED');
    expect(result?.evidence.pattern).toBe('time_based_outside_hours');
    expect(result?.evidence.events).toEqual(['e1', 'e2']);
  });

  it('does not flag events at 10:00 and at 07:00 (the start of business hours)', () => {
    const result = timeBasedRule(
      [
        {
          eventId: 'e1',
          timestamp: new Date('2026-02-12T10:00:00Z'),
          actor: 'admin@example.com',
          action: 'provisioning.completed',
        },
        {
          eventId: 'e2',
          timestamp: new Date('2026-02-12T07:00:00Z'),
          actor: 'admin@example.com',
          action: 'provisioning.completed',
        },
      ],
      'UTC',
      7,
      19,
    );
    expect(result).toBeNull();
  });

  it('does not flag event by system actor', () => {
    const event = new Date('2026-02-12T02:00:00Z');
    const result = timeBasedRule(
      [
        {
          eventId: 'e1',
          timestamp: event,
          actor: 'Temporal Worker',
          action: 'provisioning.completed',
        },
      ],
      'UTC',
      7,
      19,
    );
    expect(result).toBeNull();
  });
});

describe('peerDeviationRule', () => {
  it('flags user with unique entitlement', () => {
    const identityEntitlements = ['GroupA', 'GroupB', 'UniqueGroup'];
    const peerEntitlements = [
      ['GroupA', 'GroupB'],
      ['GroupA', 'GroupB'],
      ['GroupA', 'GroupB'],
    ];
    const result = peerDeviationRule(identityEntitlements, peerEntitlements, 0.1);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('PEER_DEVIATION');
    expect(result?.evidence.details.uniqueEntitlements).toContain('UniqueGroup');
  });

  it('does not flag when all peers have same entitlements', () => {
    const identityEntitlements = ['GroupA', 'GroupB'];
    const peerEntitlements = [
      ['GroupA', 'GroupB'],
      ['GroupA', 'GroupB'],
    ];
    const result = peerDeviationRule(identityEntitlements, peerEntitlements, 0.1);
    expect(result).toBeNull();
  });
});

describe('velocityRule', () => {
  it('flags 15 events in 3 minutes', () => {
    const base = new Date('2026-02-12T10:00:00Z');
    const events = Array.from({ length: 15 }, (_, i) => ({
      eventId: `e${i}`,
      timestamp: new Date(base.getTime() + i * 10000),
      operationCount: 1,
    }));
    const result = velocityRule(events, 10, 5);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('VELOCITY');
    expect(result?.evidence.details.maxChangesInWindow).toBeGreaterThanOrEqual(10);
  });

  it('does not flag 3 events in 3 minutes', () => {
    const base = new Date('2026-02-12T10:00:00Z');
    const events = Array.from({ length: 3 }, (_, i) => ({
      eventId: `e${i}`,
      timestamp: new Date(base.getTime() + i * 60000),
      operationCount: 1,
    }));
    const result = velocityRule(events, 10, 5);
    expect(result).toBeNull();
  });
});

describe('privilegeEscalationRule', () => {
  it('flags 3 privilege increases in 12 hours', () => {
    const base = new Date('2026-02-12T10:00:00Z');
    const events = [
      {
        eventId: 'e1',
        timestamp: base,
        groupChanges: [{ groupName: 'Standard-Members', action: 'add' as const }],
      },
      {
        eventId: 'e2',
        timestamp: new Date(base.getTime() + 2 * 60 * 60 * 1000),
        groupChanges: [{ groupName: 'Department-Managers', action: 'add' as const }],
      },
      {
        eventId: 'e3',
        timestamp: new Date(base.getTime() + 4 * 60 * 60 * 1000),
        groupChanges: [{ groupName: 'Global-Admin', action: 'add' as const }],
      },
    ];
    const result = privilegeEscalationRule(events, 24);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('PRIVILEGE_ESCALATION');
  });

  it('does not flag single privilege add', () => {
    const events = [
      {
        eventId: 'e1',
        timestamp: new Date(),
        groupChanges: [{ groupName: 'Admin', action: 'add' as const }],
      },
    ];
    const result = privilegeEscalationRule(events, 24);
    expect(result).toBeNull();
  });
});

describe('orphanAccessRule', () => {
  it('flags entitlement not in any policy', () => {
    const actual = ['PolicyGroup', 'OrphanGroup'];
    const policyOutput = ['PolicyGroup'];
    const catalogExternal = ['ExternalGroup'];
    const result = orphanAccessRule(actual, policyOutput, catalogExternal);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('ORPHAN_ACCESS');
    expect(result?.evidence.details.orphanEntitlements).toContain('OrphanGroup');
  });

  it('does not flag when entitlement is in catalog as EXTERNAL', () => {
    const actual = ['PolicyGroup', 'ExternalGroup'];
    const policyOutput = ['PolicyGroup'];
    const catalogExternal = ['ExternalGroup'];
    const result = orphanAccessRule(actual, policyOutput, catalogExternal);
    expect(result).toBeNull();
  });
});

describe('isWithinBusinessHours', () => {
  // The hour was read on a 12-hour clock ("2 p.m." as 2): afternoons were outside business hours,
  // evenings and the hour after midnight inside.
  it.each([
    ['00:30', false],
    ['06:59', false],
    ['07:00', true],
    ['12:00', true],
    ['14:00', true],
    ['18:59', true],
    ['19:00', false],
    ['22:00', false],
  ])('reads %s UTC on a 24-hour clock: within business hours %p', (time, within) => {
    expect(isWithinBusinessHours(new Date(`2026-02-12T${time}:00Z`), 7, 19, 'UTC')).toBe(within);
  });

  it('reads the hour in the business hours time zone', () => {
    // 15:00 in Helsinki (UTC+2 in February), 06:00 in New York (UTC-5)
    const at = new Date('2026-02-12T11:00:00Z');
    expect(isWithinBusinessHours(at, 7, 19, 'Europe/Helsinki')).toBe(true);
    expect(isWithinBusinessHours(at, 7, 19, 'America/New_York')).toBe(false);
  });
});

describe('isHumanActor', () => {
  it('returns true for admin@example.com', () => {
    expect(isHumanActor('admin@example.com')).toBe(true);
  });

  it('returns false for Temporal Worker', () => {
    expect(isHumanActor('Temporal Worker')).toBe(false);
  });
});

describe('risk score computation', () => {
  it('uses correct contributions per anomaly type', () => {
    expect(ANOMALY_TYPE_SCORES.TIME_BASED).toBe(15);
    expect(ANOMALY_TYPE_SCORES.PEER_DEVIATION).toBe(20);
    expect(ANOMALY_TYPE_SCORES.VELOCITY).toBe(25);
    expect(ANOMALY_TYPE_SCORES.PRIVILEGE_ESCALATION).toBe(30);
    expect(ANOMALY_TYPE_SCORES.ORPHAN_ACCESS).toBe(10);
  });

  it('sums the contributions of the anomalies found and caps the score at 100', () => {
    // computeRiskScore reads none of the service's dependencies
    const service = Object.create(AccessAnomalyService.prototype) as AccessAnomalyService;
    const found = (...types: AnomalyCandidate['type'][]) =>
      types.map((type) => ({ type }) as AnomalyCandidate);

    expect(service.computeRiskScore(found('TIME_BASED', 'PRIVILEGE_ESCALATION'))).toBe(45);
    // 30 + 30 + 25 + 20 = 105
    expect(
      service.computeRiskScore(
        found('PRIVILEGE_ESCALATION', 'PRIVILEGE_ESCALATION', 'VELOCITY', 'PEER_DEVIATION'),
      ),
    ).toBe(100);
  });
});
