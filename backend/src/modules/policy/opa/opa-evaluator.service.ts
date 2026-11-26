/**
 * OPA Evaluator Service
 *
 * Wraps the OPA client with EuroID-specific input/output mapping.
 * Handles the translation between StandardUserDto/Policy and OPA's
 * JSON input format, and maps OPA results back to PolicyProvisioningIntent.
 *
 * The evaluate() method is called by PolicyEngineService when OPA is enabled.
 * If OPA returns null (unavailable/error), the caller falls back to TypeScript evaluation.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpaClientService, OpaQueryResult } from '@infrastructure/opa/opa-client.service';
import { RegoCompilerService } from './rego-compiler.service';
import { PolicyService } from '../policy.service';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { Policy } from '../schemas/policy.schema';
import type { ProvisioningOperation } from '../policy-engine.service';

const DEFAULT_EVAL_TIMEOUT_MS = 2000;

@Injectable()
export class OpaEvaluatorService {
  private readonly logger = new Logger(OpaEvaluatorService.name);
  private lastSyncedHash: string | null = null;
  private readonly evalTimeoutMs: number;

  constructor(
    private readonly opaClient: OpaClientService,
    private readonly regoCompiler: RegoCompilerService,
    private readonly policyService: PolicyService,
    config: ConfigService,
  ) {
    const raw = config.get<string | number>('OPA_EVAL_TIMEOUT_MS');
    const parsed = Number(raw);
    this.evalTimeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EVAL_TIMEOUT_MS;
  }

  /** Whether OPA evaluation is available. */
  isAvailable(): boolean {
    return this.opaClient.isAvailable();
  }

  /** Whether fallback to TypeScript is allowed. */
  shouldFallback(): boolean {
    return this.opaClient.shouldFallback();
  }

  /**
   * Evaluate a user against OPA policies.
   * Returns null if OPA is unavailable (triggers TypeScript fallback).
   */
  async evaluate(
    user: StandardUserDto,
    policies: Policy[],
    tenantId: string,
  ): Promise<ProvisioningOperation[] | null> {
    if (!this.opaClient.isAvailable()) return null;

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutSentinel = Symbol('opa-eval-timeout');

    try {
      const queryPromise = this.opaClient.query({
        user: this.mapUserToInput(user),
        policies: policies.map((p) => this.mapPolicyToInput(p)),
        tenantId,
      });
      const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(timeoutSentinel), this.evalTimeoutMs);
      });

      const raced = await Promise.race([queryPromise, timeoutPromise]);

      if (raced === timeoutSentinel) {
        this.logger.warn(`OPA evaluation exceeded ${this.evalTimeoutMs}ms, falling back to TS`);
        return null;
      }

      if (!raced) return null;
      return this.mapResultToOperations(raced);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`OPA evaluation failed: ${message}`);
      return null;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  /**
   * Sync current active policies to OPA as a compiled Rego bundle.
   * Called periodically or on policy changes.
   */
  async syncPolicies(tenantId: string): Promise<boolean> {
    if (!this.opaClient.isAvailable()) return false;

    try {
      const activePolicies = await this.policyService.findActive();
      // Hash policy content (not the full Rego which includes timestamp)
      const policyFingerprint = activePolicies
        .map(
          (p) =>
            `${p.name}:${p.priority}:${p.status}:${JSON.stringify(p.conditionGroups)}:${JSON.stringify(p.actions)}`,
        )
        .join('|');
      const hash = this.simpleHash(policyFingerprint);
      const regoSource = this.regoCompiler.compile(activePolicies, tenantId);
      if (hash === this.lastSyncedHash) {
        this.logger.debug('Rego bundle unchanged, skipping push');
        return true;
      }

      const success = await this.opaClient.pushPolicy(`euroid-${tenantId}`, regoSource);
      if (success) {
        this.lastSyncedHash = hash;
        this.logger.log(`Synced ${activePolicies.length} policies to OPA for tenant ${tenantId}`);
      }
      return success;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to sync policies to OPA: ${message}`);
      return false;
    }
  }

  /**
   * Get the compiled Rego source for the current active policies.
   * Useful for debugging and audit.
   */
  async getCompiledRego(tenantId: string): Promise<string> {
    const activePolicies = await this.policyService.findActive();
    return this.regoCompiler.compile(activePolicies, tenantId);
  }

  // ── Input mapping ─────────────────────────────────────────────────

  private mapUserToInput(user: StandardUserDto): Record<string, unknown> {
    return {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      department: user.departmentName ?? user.departmentCode,
      departmentName: user.departmentName,
      departmentCode: user.departmentCode,
      jobTitle: user.jobTitle,
      employmentType: user.employmentType,
      location: user.location ?? user.officeLocation ?? user.officeName ?? user.city,
      country: user.countryCode,
      countryCode: user.countryCode,
      status: user.status,
      displayName: user.displayName,
      division: user.division,
      costCenter: user.costCenter,
      managerEmail: user.managerEmail,
      managerId: user.managerId,
      startDate: user.startDate ? String(user.startDate) : undefined,
      endDate: user.endDate ? String(user.endDate) : undefined,
      sourceSystem: user.sourceSystem,
      customAttributes: user.customAttributes ?? {},
      contracts: (user.contracts ?? []).map((c) => ({
        id: c.id,
        title: c.title,
        department: c.department,
        status: c.status,
        isPrimary: c.isPrimary,
      })),
    };
  }

  private mapPolicyToInput(policy: Policy): Record<string, unknown> {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose document has _id but Policy class type doesn't declare it
      _id: (policy as any)._id?.toString(),
      name: policy.name,
      priority: policy.priority,
      status: policy.status,
      conditionGroups: policy.conditionGroups,
      actions: policy.actions,
      roleBundleId: policy.roleBundleId,
    };
  }

  // ── Output mapping ────────────────────────────────────────────────

  private mapResultToOperations(result: OpaQueryResult): ProvisioningOperation[] {
    return result.operations.map((op) => ({
      type: op.type as ProvisioningOperation['type'],
      action: (op.action as ProvisioningOperation['action']) || 'add',
      target: op.target,
      targetId: op.targetId,
      params: op.params as Record<string, string | number | boolean> | undefined,
      sourcePolicy: op.sourcePolicy,
      timeConstraint: op.timeConstraint
        ? {
            durationDays: op.timeConstraint.durationDays,
            expiresAt: op.timeConstraint.expiresAt
              ? new Date(op.timeConstraint.expiresAt)
              : undefined,
          }
        : undefined,
    }));
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return String(hash);
  }
}
