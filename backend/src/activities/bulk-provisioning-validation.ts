/**
 * Pre-flight validation and risk assessment for bulk provisioning batches.
 * BulkProvisioningActivities.validateBatch is the Temporal activity; this module holds its logic.
 */

import { Logger } from '@nestjs/common';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import {
  BulkOperationInput,
  BulkOperationType,
  ValidationResult,
  ValidationError,
  ValidationWarning,
} from '@shared/dtos/bulk-operation.dto';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { PolicyEngineService } from '../modules/policy/policy-engine.service';

const logger = new Logger('BulkProvisioningActivities');

/**
 * Validate a batch of operations before execution.
 * PE-2: SoD validation — for each CREATE, policy-derived intent is checked against SoD policies.
 */
export async function validateBulkBatch(
  operations: BulkOperationInput[],
  tenantId: string | undefined,
  policyEngine: PolicyEngineService,
): Promise<ValidationResult> {
  logger.log(`[BulkProvisioning] Validating batch of ${operations.length} operations`);

  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  let destructiveOps = 0;
  let vipUsersAffected = 0;

  // PE-2: SoD validation for CREATE operations — prevents entitlement over-provisioning bypass
  if (tenantId && tenantId.trim()) {
    const createOps = operations.filter((op) => op.type === BulkOperationType.CREATE);
    for (const op of createOps) {
      const u = op.user as StandardUserDto;
      try {
        const result = await withTenantContext(tenantId, () => policyEngine.evaluate(u, tenantId));
        if (result.sodValidation && !result.sodValidation.passed) {
          const viols = result.sodValidation.blockers || [];
          for (const v of viols) {
            errors.push({
              operationId: op.id,
              field: 'sod',
              message: `SoD violation: ${v.policyName} — conflicting entitlements: ${v.conflictingEntitlements?.map((e) => `${e.system}:${e.type}:${e.targetId}`).join(', ') || 'unknown'}`,
              severity: 'CRITICAL',
            });
          }
        }
      } catch (err) {
        // Re-throw (e.g. tenant context) — let caller handle
        throw err;
      }
    }
  }

  for (const op of operations) {
    const u = op.user as StandardUserDto;
    if (!u.email || !u.firstName || !u.lastName) {
      errors.push({
        operationId: op.id,
        field: 'user',
        message: 'Missing required fields: email, firstName, or lastName',
        severity: 'CRITICAL',
      });
    }

    // Messages name the operation, never the person: the workflow puts them in its failure
    // message, which Temporal stores in clear (the payload codec covers payloads only)
    if (u.email && !isValidEmail(u.email)) {
      errors.push({
        operationId: op.id,
        field: 'email',
        message: `Invalid email format in operation ${op.id}`,
        severity: 'ERROR',
      });
    }

    // Track destructive operations
    if (op.type === BulkOperationType.DELETE || op.type === BulkOperationType.DISABLE) {
      destructiveOps++;

      // VIP users should not be deleted without approval
      if (u.priority === 'VIP') {
        vipUsersAffected++;
        warnings.push({
          operationId: op.id,
          message: `Destructive operation on a VIP user in operation ${op.id}`,
          suggestion: 'Consider manual review before execution',
        });
      }
    }

    // Validate target systems
    if (!op.targetSystems || op.targetSystems.length === 0) {
      errors.push({
        operationId: op.id,
        field: 'targetSystems',
        message: 'No target systems specified',
        severity: 'ERROR',
      });
    }

    // Warn about UPN conflicts (for Entra)
    if (op.targetSystems.includes('entra-id') && op.type === BulkOperationType.CREATE) {
      if (!u.userPrincipalName && !u.email) {
        warnings.push({
          operationId: op.id,
          message: 'No UPN specified, will use email as UPN',
          suggestion: 'Set userPrincipalName explicitly for better control',
        });
      }
    }
  }

  // Assess risk level
  const riskLevel = assessRiskLevel(
    operations.length,
    destructiveOps,
    vipUsersAffected,
    errors.length,
  );

  const result: ValidationResult = {
    safe: errors.filter((e) => e.severity === 'CRITICAL').length === 0,
    errors,
    warnings,
    risk: {
      level: riskLevel,
      reasons: buildRiskReasons(operations.length, destructiveOps, vipUsersAffected),
      destructiveOps,
      vipUsersAffected,
    },
  };

  logger.log(
    `[BulkProvisioning] Validation complete. Safe: ${result.safe}, Risk: ${riskLevel}, Errors: ${errors.length}, Warnings: ${warnings.length}`,
  );

  return result;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function assessRiskLevel(
  totalOps: number,
  destructiveOps: number,
  vipUsers: number,
  criticalErrors: number,
): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  if (criticalErrors > 0) return 'CRITICAL';
  if (vipUsers > 0 || destructiveOps > totalOps * 0.3) return 'HIGH';
  if (destructiveOps > 0 || totalOps > 50) return 'MEDIUM';
  return 'LOW';
}

function buildRiskReasons(totalOps: number, destructiveOps: number, vipUsers: number): string[] {
  const reasons: string[] = [];

  if (totalOps > 100) reasons.push(`Large batch size: ${totalOps} operations`);
  if (destructiveOps > 0)
    reasons.push(`Contains ${destructiveOps} destructive operations (DELETE/DISABLE)`);
  if (vipUsers > 0) reasons.push(`Affects ${vipUsers} VIP users`);
  if (destructiveOps > totalOps * 0.3)
    reasons.push(
      `High percentage of destructive operations: ${Math.round((destructiveOps / totalOps) * 100)}%`,
    );

  return reasons;
}
