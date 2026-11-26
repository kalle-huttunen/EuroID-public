/**
 * Pure delta & risk helpers for ImpactAnalysisService.
 * No DI, no side effects — makes unit testing and reuse straightforward.
 */

import { UserPriority, UserStatus } from '@shared/dtos/standard-user.dto';
import type { StandardUserDto, EmploymentContract } from '@shared/dtos/standard-user.dto';
import type { ProvisioningState } from '../identity/schemas/identity.schema';
import {
  DEFAULT_RISK_THRESHOLD,
  EntitlementChange,
  ImpactAnalysisResult,
  ImpactDelta,
  RISK_THRESHOLDS,
  RiskAssessment,
} from './impact-analysis.types';

export function isUserOffboarded(user: StandardUserDto): boolean {
  if (user.status === UserStatus.TERMINATED || user.status === UserStatus.DELETED) {
    return true;
  }
  if (user.endDate && new Date(user.endDate) < new Date()) {
    return true;
  }
  const primaryContract =
    user.contracts?.find((c: EmploymentContract) => c?.isPrimary === true) ?? user.contracts?.[0];
  if (primaryContract?.status === 'TERMINATED') {
    return true;
  }
  return false;
}

export function computeRiskLevel(
  operation: ImpactDelta['operation'],
  riskReasons: string[],
  user: StandardUserDto,
): 'low' | 'medium' | 'high' | 'critical' {
  if (operation === 'REMOVE' || operation === 'DISABLE') {
    return user.priority === UserPriority.VIP ? 'critical' : 'high';
  }
  if (operation === 'CREATE') return 'low';
  if (operation === 'UPDATE' && riskReasons.length > 0) return 'medium';
  return 'low';
}

/** A policy operation as an added entitlement: a group, directory role or license, as typed. */
function addChange(op: { targetId: string; type: string }): EntitlementChange {
  const type = op.type === 'license' || op.type === 'role' ? op.type : 'group';
  return { type, action: 'add', targetId: op.targetId, targetName: op.targetId };
}

export function computeUserDelta(
  user: StandardUserDto,
  policyResult: { operations: Array<{ target: string; targetId: string; type: string }> },
  provisioning: ProvisioningState[],
  targetSystem: string,
): ImpactDelta {
  const provEntry = provisioning.find(
    (p) =>
      p.targetSystem === targetSystem ||
      p.targetSystem?.toLowerCase().includes(targetSystem.toLowerCase()),
  );

  const isOffboarded = isUserOffboarded(user);
  const opsForSystem = policyResult.operations.filter(
    (op) => op.target === targetSystem || op.target === `${targetSystem}-id` || op.target === 'all',
  );

  let operation: ImpactDelta['operation'];
  const riskReasons: string[] = [];
  const entitlementChanges: EntitlementChange[] = [];

  if (isOffboarded && provEntry) {
    operation = provEntry.status === 'SYNCED' ? 'DISABLE' : 'REMOVE';
    riskReasons.push('User is terminated or past end date');
  } else if (!provEntry || provEntry.status === 'PENDING' || provEntry.status === 'ERROR') {
    operation = 'CREATE';
    if (opsForSystem.length > 0) {
      entitlementChanges.push(...opsForSystem.map(addChange));
    }
  } else if (provEntry.status === 'SYNCED') {
    if (opsForSystem.length > 0) {
      operation = 'UPDATE';
      entitlementChanges.push(...opsForSystem.map(addChange));
      riskReasons.push(`${opsForSystem.length} entitlement(s) to sync`);
    } else {
      operation = 'NO_CHANGE';
    }
  } else {
    operation = 'UPDATE';
    riskReasons.push(`Provisioning status: ${provEntry.status}`);
  }

  const riskLevel = computeRiskLevel(operation, riskReasons, user);

  const displayName =
    user.displayName ?? (`${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email);
  // The person's UPN, else their email (required): never one made up on an invented domain
  const upn = user.userPrincipalName ?? user.email;

  return {
    userId: user._id?.toString() ?? user.sourceUserId ?? user.email,
    email: user.email,
    upn,
    displayName,
    operation,
    targetSystem,
    changes: [],
    entitlementChanges,
    riskLevel,
    riskReasons,
  };
}

export function aggregateDeltas(deltas: ImpactDelta[]): ImpactAnalysisResult['summary'] {
  const creates = deltas.filter((d) => d.operation === 'CREATE').length;
  const updates = deltas.filter((d) => d.operation === 'UPDATE').length;
  const removes = deltas.filter((d) => d.operation === 'REMOVE').length;
  const disables = deltas.filter((d) => d.operation === 'DISABLE').length;
  const noChange = deltas.filter((d) => d.operation === 'NO_CHANGE').length;
  const highRisk = deltas.filter(
    (d) => d.riskLevel === 'high' || d.riskReasons.some((r) => r.includes('VIP')),
  ).length;

  return {
    totalUsers: new Set(deltas.map((d) => d.userId)).size,
    creates,
    updates,
    deletes: removes + disables,
    noChange,
    highRisk,
    warnings: highRisk + (removes + disables),
  };
}

export function assessRisk(deltas: ImpactDelta[]): RiskAssessment {
  const removeCount = deltas.filter(
    (d) => d.operation === 'REMOVE' || d.operation === 'DISABLE',
  ).length;
  const createCount = deltas.filter((d) => d.operation === 'CREATE').length;
  const updateCount = deltas.filter((d) => d.operation === 'UPDATE').length;
  const noChangeCount = deltas.filter((d) => d.operation === 'NO_CHANGE').length;

  const totalDeltas = deltas.length;
  const affectedPercentage =
    totalDeltas > 0 ? Math.round(((totalDeltas - noChangeCount) / totalDeltas) * 100) : 0;

  const threshold = DEFAULT_RISK_THRESHOLD;
  const circuitBreakerTriggered = affectedPercentage > threshold;

  const highRiskOperations: string[] = [];
  if (removeCount > RISK_THRESHOLDS.CRITICAL.removeCount) {
    highRiskOperations.push(`${removeCount} users would be removed or disabled`);
  }
  if (removeCount > 0) {
    const vipRemoves = deltas.filter(
      (d) => (d.operation === 'REMOVE' || d.operation === 'DISABLE') && d.riskLevel === 'high',
    ).length;
    if (vipRemoves > 0) {
      highRiskOperations.push(`${vipRemoves} VIP user(s) would be disabled`);
    }
  }

  let overallRisk: RiskAssessment['overallRisk'];
  if (
    affectedPercentage > RISK_THRESHOLDS.CRITICAL.affectedPercentage ||
    removeCount > RISK_THRESHOLDS.CRITICAL.removeCount
  ) {
    overallRisk = 'critical';
  } else if (
    affectedPercentage > RISK_THRESHOLDS.HIGH.affectedPercentage ||
    removeCount > RISK_THRESHOLDS.HIGH.removeCount
  ) {
    overallRisk = 'high';
  } else if (
    affectedPercentage > RISK_THRESHOLDS.MEDIUM.affectedPercentage ||
    removeCount > RISK_THRESHOLDS.MEDIUM.removeCount
  ) {
    overallRisk = 'medium';
  } else {
    overallRisk = 'low';
  }

  return {
    overallRisk,
    affectedPercentage,
    createCount,
    updateCount,
    removeCount,
    disableCount: deltas.filter((d) => d.operation === 'DISABLE').length,
    noChangeCount,
    highRiskOperations,
    circuitBreakerTriggered,
    threshold,
  };
}

export function emptyImpactResult(): ImpactAnalysisResult {
  return {
    deltas: [],
    summary: {
      totalUsers: 0,
      creates: 0,
      updates: 0,
      deletes: 0,
      noChange: 0,
      highRisk: 0,
      warnings: 0,
    },
    risk: {
      overallRisk: 'low',
      affectedPercentage: 0,
      createCount: 0,
      updateCount: 0,
      removeCount: 0,
      disableCount: 0,
      noChangeCount: 0,
      highRiskOperations: [],
      circuitBreakerTriggered: false,
      threshold: DEFAULT_RISK_THRESHOLD,
    },
  };
}

/** Convert internal ImpactDelta to API IUserDelta format for frontend compatibility. */
export function toApiDelta(d: ImpactDelta): {
  userId: string;
  displayName: string;
  upn: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'NO_CHANGE';
  risk: 'Low' | 'Medium' | 'High' | 'Critical';
  changes?: {
    field: string;
    oldValue: string;
    newValue: string;
    impact: 'Low' | 'Medium' | 'High';
  }[];
  warnings?: string[];
  targetSystem: string;
} {
  const action = d.operation === 'REMOVE' || d.operation === 'DISABLE' ? 'DELETE' : d.operation;
  const riskMap: Record<ImpactDelta['riskLevel'], 'Low' | 'Medium' | 'High' | 'Critical'> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    critical: 'Critical',
  };
  const risk = riskMap[d.riskLevel] ?? 'Low';
  const changes = d.changes?.map((c) => ({
    field: c.field,
    oldValue: String(c.currentValue ?? ''),
    newValue: String(c.newValue ?? ''),
    impact: 'Medium' as const,
  }));
  const warnings = d.entitlementChanges.length
    ? d.entitlementChanges.map((e) => `${e.action} ${e.type}: ${e.targetName}`)
    : d.riskReasons;

  return {
    userId: d.userId,
    displayName: d.displayName,
    upn: d.upn ?? d.email,
    action,
    risk,
    changes,
    warnings: warnings.length > 0 ? warnings : undefined,
    targetSystem: d.targetSystem,
  };
}

/**
 * The target system a canvas node type or a requested connector name stands for in the impact
 * analysis: Entra ID for an `entra` or `azure` name, AD for `ad` or `active-directory` exactly
 * (a substring test read "workday" and "adp" as AD), the type itself otherwise.
 */
export function impactTargetSystem(type: string): string {
  const name = type.trim().toLowerCase();
  if (name.includes('entra') || name.includes('azure')) return 'entra-id';
  if (name === 'ad' || name === 'active-directory' || name === 'activedirectory') return 'ad';
  return type;
}
