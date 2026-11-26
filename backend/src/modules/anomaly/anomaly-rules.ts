/**
 * Anomaly Detection Rules
 *
 * Rule-based heuristics for access anomaly detection. Each rule returns
 * an AnomalyCandidate or null. Composable and testable.
 */

import type { AnomalyType, AnomalySeverity } from './schemas/anomaly.schema';

export interface AnomalyCandidate {
  type: AnomalyType;
  severity: AnomalySeverity;
  title: string;
  description: string;
  evidence: {
    events: string[];
    pattern: string;
    details: Record<string, unknown>;
  };
}

/** Risk score contribution per anomaly type (task spec) */
export const ANOMALY_TYPE_SCORES: Record<AnomalyType, number> = {
  TIME_BASED: 15,
  PEER_DEVIATION: 20,
  VELOCITY: 25,
  PRIVILEGE_ESCALATION: 30,
  ORPHAN_ACCESS: 10,
};

/** Privilege tier keywords (heuristic: group name contains these = higher tier) */
const PRIVILEGE_TIER_KEYWORDS: Record<number, string[]> = {
  3: ['admin', 'owner', 'superuser', 'global-admin'],
  2: ['manager', 'moderator', 'power-user'],
  1: ['member', 'user', 'standard'],
};

/**
 * The tier of an entitlement the catalog marks as privileged: an admin tier (Tier 0 and 1 rank as
 * admin, Tier 2 as elevated), else a CRITICAL or HIGH risk level; 0 when it marks nothing.
 */
export function catalogPrivilegeTier(entry: {
  adminTier?: string;
  requiresAdminAccount?: boolean;
  riskLevel?: string;
}): number {
  if (entry.adminTier === 'TIER_0' || entry.adminTier === 'TIER_1') return 3;
  if (entry.adminTier === 'TIER_2') return 2;
  if (entry.requiresAdminAccount) return 3;
  if (entry.riskLevel === 'CRITICAL') return 3;
  if (entry.riskLevel === 'HIGH') return 2;
  return 0;
}

function getPrivilegeTier(groupName: string): number {
  const lower = String(groupName || '').toLowerCase();
  for (let tier = 3; tier >= 1; tier--) {
    if (PRIVILEGE_TIER_KEYWORDS[tier].some((k) => lower.includes(k))) {
      return tier;
    }
  }
  return 0;
}

/** Check if hour is within business hours (default 07:00–19:00) */
export function isWithinBusinessHours(
  date: Date,
  startHour = 7,
  endHour = 19,
  tz = 'UTC',
): boolean {
  // h23: 'en-CA' alone reads 2 p.m. as hour 2
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const totalMinutes = hour * 60 + minute;
  const startMinutes = startHour * 60;
  const endMinutes = endHour * 60;
  return totalMinutes >= startMinutes && totalMinutes < endMinutes;
}

/** System/workflow actors that should not trigger time-based anomalies */
const SYSTEM_ACTORS = ['system', 'Temporal Worker', 'ReconciliationService', 'OnboardingService'];

export function isHumanActor(actor: string): boolean {
  const a = String(actor || '')
    .trim()
    .toLowerCase();
  return !SYSTEM_ACTORS.some((s) => a.includes(s.toLowerCase()));
}

/** Time-based rule: access changes outside business hours by human actor */
export function timeBasedRule(
  events: Array<{ eventId: string; timestamp: Date; actor: string; action: string }>,
  businessHoursTz = 'UTC',
  startHour = 7,
  endHour = 19,
): AnomalyCandidate | null {
  const suspicious = events.filter(
    (e) =>
      (e.action === 'provisioning.completed' || e.action === 'provisioning.started') &&
      !isWithinBusinessHours(e.timestamp, startHour, endHour, businessHoursTz) &&
      isHumanActor(e.actor),
  );
  if (suspicious.length === 0) return null;
  return {
    type: 'TIME_BASED',
    severity: 'medium',
    title: 'Access changes outside business hours',
    description: `${suspicious.length} access change(s) made outside business hours (${startHour}:00–${endHour}:00) by a human actor.`,
    evidence: {
      events: suspicious.map((e) => e.eventId),
      pattern: 'time_based_outside_hours',
      details: {
        count: suspicious.length,
        actors: [...new Set(suspicious.map((e) => e.actor))],
        timezone: businessHoursTz,
      },
    },
  };
}

/** Peer deviation rule: entitlements that <10% of peers have */
export function peerDeviationRule(
  identityEntitlements: string[],
  peerEntitlements: string[][],
  threshold = 0.1,
): AnomalyCandidate | null {
  if (identityEntitlements.length === 0 || peerEntitlements.length === 0) return null;
  const _peerSet = new Set(peerEntitlements.flat());
  const uniqueToIdentity = identityEntitlements.filter((e) => {
    const peerCount = peerEntitlements.filter((peers) => peers.includes(e)).length;
    const pct = peerEntitlements.length > 0 ? peerCount / peerEntitlements.length : 0;
    return pct < threshold;
  });
  if (uniqueToIdentity.length === 0) return null;
  return {
    type: 'PEER_DEVIATION',
    severity: 'high',
    title: 'Entitlements differ from peer group',
    description: `Identity has ${uniqueToIdentity.length} entitlement(s) that fewer than ${Math.round(threshold * 100)}% of peers in the same department/job title have.`,
    evidence: {
      events: [],
      pattern: 'peer_deviation_unique_entitlements',
      details: {
        uniqueEntitlements: uniqueToIdentity,
        peerCount: peerEntitlements.length,
        threshold,
      },
    },
  };
}

/** Velocity rule: too many access changes in short time window */
export function velocityRule(
  events: Array<{ eventId: string; timestamp: Date; operationCount: number }>,
  thresholdN = 10,
  windowMinutesM = 5,
): AnomalyCandidate | null {
  if (events.length === 0) return null;
  const sorted = [...events].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const windowMs = windowMinutesM * 60 * 1000;
  let maxTotal = 0;
  let windowStart = 0;
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i].timestamp.getTime();
    while (windowStart < i && t - sorted[windowStart].timestamp.getTime() > windowMs) {
      total -= sorted[windowStart].operationCount;
      windowStart++;
    }
    total += sorted[i].operationCount;
    if (total > maxTotal) maxTotal = total;
  }
  if (maxTotal < thresholdN) return null;
  return {
    type: 'VELOCITY',
    severity: 'high',
    title: 'Excessive access changes in short window',
    description: `${maxTotal} access change(s) within ${windowMinutesM} minutes (threshold: ${thresholdN}).`,
    evidence: {
      events: sorted.map((e) => e.eventId),
      pattern: 'velocity_threshold_exceeded',
      details: {
        maxChangesInWindow: maxTotal,
        threshold: thresholdN,
        windowMinutes: windowMinutesM,
      },
    },
  };
}

/**
 * Privilege escalation rule: multiple privilege increases in window. A group ranks by keywords in
 * its name, or by `tier` (the catalog's privilege marking) when that is higher.
 */
export function privilegeEscalationRule(
  events: Array<{
    eventId: string;
    timestamp: Date;
    groupChanges: Array<{ groupName: string; action: 'add' | 'remove'; tier?: number }>;
  }>,
  windowHours = 24,
): AnomalyCandidate | null {
  const addEvents = events.flatMap((e) =>
    e.groupChanges
      .filter((g) => g.action === 'add')
      .map((g) => ({
        eventId: e.eventId,
        timestamp: e.timestamp,
        tier: Math.max(getPrivilegeTier(g.groupName), g.tier ?? 0),
      })),
  );
  if (addEvents.length < 2) return null;
  const sorted = [...addEvents].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const windowMs = windowHours * 60 * 60 * 1000;
  let maxIncreases = 0;
  for (let end = 0; end < sorted.length; end++) {
    const windowStart = sorted.findIndex(
      (s) => sorted[end].timestamp.getTime() - s.timestamp.getTime() <= windowMs,
    );
    const inWindow = sorted.slice(Math.max(0, windowStart), end + 1);
    let currentTier = 0;
    let increases = 0;
    for (const ev of inWindow) {
      const tier = ev.tier;
      if (tier > currentTier) {
        increases++;
        currentTier = tier;
      }
    }
    if (increases > maxIncreases) maxIncreases = increases;
  }
  if (maxIncreases < 2) return null;
  return {
    type: 'PRIVILEGE_ESCALATION',
    severity: 'critical',
    title: 'Rapid privilege escalation',
    description: `${maxIncreases} privilege increase(s) within ${windowHours} hours.`,
    evidence: {
      events: sorted.map((e) => e.eventId),
      pattern: 'privilege_escalation_rapid',
      details: {
        count: maxIncreases,
        windowHours,
      },
    },
  };
}

/** Orphan access rule: entitlements not in policy and not EXTERNAL/OPEN in catalog */
export function orphanAccessRule(
  actualEntitlements: string[],
  policyOutputEntitlements: string[],
  catalogExternalOrOpen: string[],
): AnomalyCandidate | null {
  const policySet = new Set(policyOutputEntitlements.map((s) => s.toLowerCase()));
  const catalogSet = new Set(catalogExternalOrOpen.map((s) => s.toLowerCase()));
  const orphans = actualEntitlements.filter((e) => {
    const lower = e.toLowerCase();
    return !policySet.has(lower) && !catalogSet.has(lower);
  });
  if (orphans.length === 0) return null;
  return {
    type: 'ORPHAN_ACCESS',
    severity: 'medium',
    title: 'Entitlements with no backing policy',
    description: `${orphans.length} entitlement(s) exist on the target system but are not generated by any active policy and not in the catalog as EXTERNAL/OPEN.`,
    evidence: {
      events: [],
      pattern: 'orphan_access_no_policy',
      details: {
        orphanEntitlements: orphans,
      },
    },
  };
}
