/**
 * What reconciliation and the risk engines found about the demo people: drift records (open,
 * corrected, ignored, two quarantined orphan accounts), anomalies and risk scores.
 */
import { daysFrom, seededObjectId, seededUuid, type SeededRandom } from './random';
import {
  DEMO_SEED_MARKER,
  fullName,
  personId,
  sectionRandom,
  workingPeople,
  type SeedContext,
} from './context';
import type { DemoPerson } from './people';
import { targetsOf } from './provisioning';

type DriftSpec = [
  string,
  string,
  string,
  string | undefined,
  string | undefined,
  string | undefined,
  boolean,
];

/** [type, severity, target, field, hub value, target value, auto-correct eligible] per drift. */
function driftSpecs(person: DemoPerson): DriftSpec[] {
  const old = person.previous?.jobTitle ?? 'Associate';
  return [
    ['FIELD_MISMATCH', 'medium', 'entra', 'jobTitle', person.jobTitle, old, true],
    ['FIELD_MISMATCH', 'low', 'entra', 'officeLocation', person.office.office, 'Helsinki HQ', true],
    ['FIELD_MISMATCH', 'medium', 'ad', 'department', person.department.name, 'Operations', true],
    ['STATUS_MISMATCH', 'high', 'ad', 'accountEnabled', 'true', 'false', false],
    ['GROUP_MISMATCH', 'high', 'okta', 'groups', 'Salesforce', 'Salesforce, Zendesk', false],
    [
      'LICENSE_MISMATCH',
      'medium',
      'entra',
      'licenses',
      'Microsoft 365 E3',
      'Microsoft 365 E5',
      false,
    ],
    ['MISSING_USER', 'critical', 'github', undefined, person.email.split('@')[0], undefined, true],
  ];
}

const STATUSES: Array<'open' | 'corrected' | 'ignored'> = [
  'open',
  'open',
  'open',
  'open',
  'open',
  'open',
  'open',
  'open',
  'corrected',
  'corrected',
  'corrected',
  'corrected',
  'ignored',
  'ignored',
];

export function buildDrifts(ctx: SeedContext): Record<string, unknown>[] {
  const rng = sectionRandom('drifts');
  const people = rng.shuffle(workingPeople(ctx).filter((p) => p.role === 'member'));
  const drifts: Record<string, unknown>[] = STATUSES.map((status, i) => {
    const person = people[i];
    const specs = driftSpecs(person).filter(([, , target]) =>
      targetsOf(person).includes(target as never),
    );
    const [type, severity, targetSystem, field, hubValue, targetValue, eligible] = rng.pick(specs);
    const detectedAt = daysFrom(ctx.anchor, -rng.int(1, 20), rng.int(1, 5));
    return {
      _id: seededObjectId(ctx.tenantId, 'drift', i),
      tenantId: ctx.tenantId,
      type,
      severity,
      userId: personId(ctx, person),
      userDisplayName: fullName(person),
      userEmail: person.email,
      targetSystem,
      ...(field ? { field } : {}),
      ...(hubValue ? { hubValue } : {}),
      ...(targetValue ? { targetValue } : {}),
      detectedAt,
      autoCorrectEligible: eligible,
      status,
      ...(status === 'corrected' ? { correctedAt: daysFrom(detectedAt, 0, 3) } : {}),
      workflowId: DEMO_SEED_MARKER,
    };
  });
  const orphans: Array<[string, string, string]> = [
    [
      'ad',
      'svc-legacy-backup',
      'CN=svc-legacy-backup,OU=Service,DC=corp,DC=demo,DC=example,DC=com',
    ],
    ['entra', 'temp.migration', seededUuid(ctx.tenantId, 'orphan|entra')],
  ];
  orphans.forEach(([targetSystem, accountName, externalId], k) => {
    const discoveredAt = daysFrom(ctx.anchor, -3 - k * 4, 2);
    drifts.push({
      _id: seededObjectId(ctx.tenantId, 'drift', STATUSES.length + k),
      tenantId: ctx.tenantId,
      type: 'ORPHAN_ACCOUNT',
      severity: 'high',
      userId: externalId,
      userDisplayName: accountName,
      userEmail: accountName,
      targetSystem,
      status: 'quarantined',
      autoCorrectEligible: false,
      detectedAt: discoveredAt,
      workflowId: DEMO_SEED_MARKER,
      orphanDetails: {
        targetSystem,
        externalId,
        accountName,
        discoveredAt,
        gracePeriodEndsAt: daysFrom(ctx.anchor, 14 + k * 14),
      },
    });
  });
  return drifts;
}

const ANOMALIES: Array<[string, string, number, string, string, string, string]> = [
  [
    'PRIVILEGE_ESCALATION',
    'critical',
    88,
    'open',
    'Rapid privilege escalation',
    'Three high-risk entitlements were added within 24 hours.',
    'privilege_escalation_rapid',
  ],
  [
    'TIME_BASED',
    'high',
    72,
    'open',
    'Access changes outside business hours',
    'Four access changes were made between 01:00 and 04:00 local time.',
    'time_based_outside_hours',
  ],
  [
    'PEER_DEVIATION',
    'medium',
    55,
    'open',
    'Entitlements differ from peer group',
    'Holds five entitlements no one else in the department holds.',
    'peer_deviation_unique_entitlements',
  ],
  [
    'VELOCITY',
    'medium',
    48,
    'acknowledged',
    'Excessive access changes in short window',
    'Eleven access changes within one hour.',
    'velocity_burst',
  ],
  [
    'ORPHAN_ACCESS',
    'low',
    30,
    'open',
    'Entitlements with no backing policy',
    'Two group memberships match no policy and no access request.',
    'orphan_access_no_policy',
  ],
  [
    'PEER_DEVIATION',
    'low',
    25,
    'resolved',
    'Entitlements differ from peer group',
    'Holds the Finance group outside the Finance department.',
    'peer_deviation_unique_entitlements',
  ],
];

function anomalyPeople(ctx: SeedContext, rng: SeededRandom): DemoPerson[] {
  return rng.shuffle(workingPeople(ctx).filter((p) => p.role !== 'ceo')).slice(0, ANOMALIES.length);
}

export function buildAnomalies(ctx: SeedContext): Record<string, unknown>[] {
  const rng = sectionRandom('anomalies');
  const people = anomalyPeople(ctx, rng);
  return ANOMALIES.map(([type, severity, riskScore, status, title, description, pattern], i) => {
    const detectedAt = daysFrom(ctx.anchor, -rng.int(1, 25), rng.int(1, 20));
    return {
      tenantId: ctx.tenantId,
      anomalyId: seededUuid(ctx.tenantId, `anomaly|${i}`),
      identityId: personId(ctx, people[i]),
      type,
      severity,
      riskScore,
      title,
      description,
      evidence: { events: [], pattern, details: { department: people[i].department.name } },
      status,
      detectedAt,
      ...(status === 'acknowledged' ? { acknowledgedBy: 'admin' } : {}),
      ...(status === 'resolved' ? { resolvedAt: daysFrom(detectedAt, 2) } : {}),
      metadata: { demoSeed: true },
    };
  });
}

/** The anomaly module's per-identity score: the highest of its anomalies. */
export function buildAnomalyRiskScores(ctx: SeedContext): Record<string, unknown>[] {
  const people = anomalyPeople(ctx, sectionRandom('anomalies'));
  const best = new Map<string, number>();
  ANOMALIES.forEach(([, , score], i) => {
    const id = personId(ctx, people[i]);
    best.set(id, Math.max(best.get(id) ?? 0, score));
  });
  return [...best].map(([identityId, riskScore]) => ({
    tenantId: ctx.tenantId,
    identityId,
    riskScore,
    updatedAt: daysFrom(ctx.anchor, -1, 2),
  }));
}

/** The nightly composite score of every working person, with six months of history. */
export function buildIdentityRiskScores(ctx: SeedContext): Record<string, unknown>[] {
  const rng = sectionRandom('risk-scores');
  const flagged = new Set(buildAnomalyRiskScores(ctx).map((s) => s.identityId));
  const sensitive = ['Finance', 'Human Resources', 'Executive Office'];
  return workingPeople(ctx).map((person) => {
    const id = personId(ctx, person);
    const factors = [
      { factor: 'entitlement_count', weight: 0.2, rawValue: targetsOf(person).length + 3 },
      {
        factor: 'high_risk_entitlements',
        weight: 0.3,
        rawValue:
          sensitive.includes(person.department.name) || person.role !== 'member'
            ? rng.int(2, 4)
            : rng.int(0, 1),
      },
      { factor: 'anomaly_count', weight: 0.25, rawValue: flagged.has(id) ? 1 : 0 },
      { factor: 'peer_deviation', weight: 0.15, rawValue: rng.int(0, 3) },
      { factor: 'dormant', weight: 0.1, rawValue: rng.chance(0.05) ? 1 : 0 },
    ].map((f) => ({ ...f, contribution: Math.round(f.weight * Math.min(100, f.rawValue * 22)) }));
    const score = Math.min(
      100,
      factors.reduce((sum, f) => sum + f.contribution, 0),
    );
    const trend = flagged.has(id) ? 'INCREASING' : rng.pick(['STABLE', 'STABLE', 'DECREASING']);
    const history = Array.from({ length: 6 }, (_, k) => ({
      date: daysFrom(ctx.anchor, -30 * (6 - k)),
      score: Math.max(
        0,
        Math.min(100, score + (trend === 'INCREASING' ? -(6 - k) * 4 : rng.int(-4, 4))),
      ),
    }));
    return {
      tenantId: ctx.tenantId,
      identityId: id,
      score,
      factors,
      trend,
      history,
      calculatedAt: daysFrom(ctx.anchor, 0, -rng.int(2, 6)),
    };
  });
}
