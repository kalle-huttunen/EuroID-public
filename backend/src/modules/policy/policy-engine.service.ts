import { Inject, Injectable } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { Policy, PolicyDocument } from './schemas/policy.schema';
import {
  StandardUserDto,
  EmploymentType,
  EmploymentContract,
} from '@shared/dtos/standard-user.dto';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { safeRegexTest } from '@shared/utils/safe-regex.util';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { POLICY_PAGE_SIZE } from '@infrastructure/config/defaults';
import { type AuthConfig, authConfig } from '@infrastructure/config/auth.config';
import {
  SodService,
  SodTarget,
  SodViolation,
  SoDValidationResult,
  toSoDValidationResult,
} from './sod.service';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { PamFilterService } from './pam-filter.service';
import { ReviewExclusionService } from './review-exclusion.service';
import { withoutReviewExclusions, type SuppressedOperation } from './review-exclusion-match';
import { IDENTITY_QUERY_PORT, IIdentityQueryPort } from '@shared/interfaces/identity-query.port';
import type { IPolicyDecisionPort } from '@shared/interfaces/policy-decision.port';
import {
  ROLE_BUNDLE_RESOLVER_PORT,
  IRoleBundleResolverPort,
} from '@shared/interfaces/role-bundle-resolver.port';
import { maskEmail } from '../identity/identity-pii';
// ── Field Accessor Maps (module-level for zero-allocation reuse) ────

type UserFieldValue = string | number | boolean | undefined;

const USER_FIELD_ACCESSORS: Readonly<Record<string, (u: StandardUserDto) => UserFieldValue>> = {
  email: (u) => u.email,
  department: (u) => u.departmentName ?? u.departmentCode,
  departmentName: (u) => u.departmentName,
  departmentCode: (u) => u.departmentCode,
  jobTitle: (u) => u.jobTitle,
  employmentType: (u) => u.employmentType,
  location: (u) => u.location ?? u.officeLocation ?? u.officeName ?? u.city,
  country: (u) => u.countryCode,
  countryCode: (u) => u.countryCode,
  status: (u) => u.status,
  firstName: (u) => u.firstName,
  lastName: (u) => u.lastName,
  middleName: (u) => u.middleName,
  displayName: (u) => u.displayName,
  division: (u) => u.division,
  costCenter: (u) => u.costCenter,
  employeeId: (u) => u.employeeId,
  managerEmail: (u) => u.managerEmail,
  managerId: (u) => u.managerId,
  officeLocation: (u) => u.officeLocation,
  officeName: (u) => u.officeName,
  city: (u) => u.city,
  stateProvince: (u) => u.stateProvince,
  address: (u) => u.address,
  postalCode: (u) => u.postalCode,
  timezone: (u) => u.timezone,
  userPrincipalName: (u) => u.userPrincipalName,
  samAccountName: (u) => u.samAccountName,
  employeeNumber: (u) => u.employeeNumber,
  priority: (u) => u.priority,
  startDate: (u) => (u.startDate != null ? String(u.startDate) : undefined),
  endDate: (u) => (u.endDate != null ? String(u.endDate) : undefined),
  score: (u) => u.customAttributes?.score,
  sourceSystem: (u) => u.sourceSystem,
};

const CONTRACT_FIELD_ACCESSORS: Readonly<
  Record<string, (c: EmploymentContract) => string | undefined>
> = {
  id: (c) => c.id,
  title: (c) => c.title,
  department: (c) => c.department,
  status: (c) => c.status,
  isPrimary: (c) => String(c.isPrimary),
};

// ── Output Types ────────────────────────────────────────────────────

export type AdminTier = 'TIER_0' | 'TIER_1' | 'TIER_2';

export type ProvisioningOperation = {
  type:
    | 'group'
    | 'license'
    | 'role'
    | 'attribute'
    | 'mfa'
    | 'conditional_access'
    | 'notification'
    | 'workflow';
  action: 'add' | 'remove' | 'set';
  target: string;
  targetId: string;
  params?: Record<string, string | number | boolean>;
  sourcePolicy: string;
  timeConstraint?: { durationDays?: number; expiresAt?: Date };
};

export type AdminOperation = ProvisioningOperation & { adminTier: AdminTier };

/**
 * Generic provisioning intent — system-agnostic output of the policy engine.
 * Connectors consume this to know what groups/licenses/attributes to apply.
 */
export type { SoDValidationResult } from './sod.service';

export interface PolicyProvisioningIntent {
  operations: ProvisioningOperation[];
  adminOperations?: AdminOperation[];
  sodWarnings?: SodViolation[];
  sodValidation?: SoDValidationResult;
  /**
   * evaluate() only: what the policies grant that an access review revoked (an active review
   * exclusion), left out of `operations` and `adminOperations`; the policy trace shows it.
   */
  suppressedOperations?: SuppressedOperation[];
}

/**
 * Everything the intent gives one person: their own account's operations and those
 * PamFilterService moved to their linked admin account. SoD checks this whole set.
 */
function allOperations(intent: PolicyProvisioningIntent): ProvisioningOperation[] {
  return [...intent.operations, ...(intent.adminOperations ?? [])];
}

export interface SimulationResult {
  totalUsers: number;
  matchedCount: number;
  matchPercentage: number;
  matchedUsers: Array<{
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    department: string;
    jobTitle: string;
    employmentType: string;
    location: string;
    status: string;
  }>;
  actionsBySystem: Record<string, number>;
  totalOperations: number;
}

/**
 * The Brain: ABAC policy engine. Evaluates users against active policies and returns ProvisioningIntent for connectors.
 */
@Injectable()
export class PolicyEngineService implements IPolicyDecisionPort {
  private readonly logger = this.loggerFactory.create(PolicyEngineService.name);

  constructor(
    private readonly policyService: PolicyService,
    @Inject(IDENTITY_QUERY_PORT) private readonly identityQuery: IIdentityQueryPort,
    private readonly sodService: SodService,
    private readonly pamFilter: PamFilterService,
    private readonly reviewExclusions: ReviewExclusionService,
    @Inject(ROLE_BUNDLE_RESOLVER_PORT) private readonly roleBundleResolver: IRoleBundleResolverPort,
    private readonly loggerFactory: LoggerFactoryService,
    private readonly eventEmitter: DomainEventEmitterService,
    @Inject(authConfig.KEY) private readonly authConf: AuthConfig,
    private readonly entitlementCatalog: EntitlementCatalogService,
  ) {}

  /**
   * SoD for the evaluated operations, each target compared as its catalog native id: a rule names
   * a group by its display name (params.groupName), an SoD policy by either form, so without this
   * a policy naming the GUID never met the rule's name. A target the catalog does not know, or
   * names twice on the system, keeps its own id (the access request check does the same,
   * AccessRequestSodService).
   */
  private validateSod(tenantId: string, intent: PolicyProvisioningIntent): Promise<SodViolation[]> {
    return this.sodService.validate(tenantId, allOperations(intent), {
      resolveTargets: async (targets: SodTarget[]) => {
        const entryOf = await this.entitlementCatalog.loadTargetLookup(tenantId, targets);
        return (target) => entryOf(target)?.nativeId;
      },
    });
  }

  // ── Evaluate: run all active policies against one user ────────────

  /**
   * policy.evaluated goes under the profile's identity id (`_id`), never its email; a profile
   * without one goes under 'policy-engine'. `forProvisioning`: a workflow provisions from this
   * result (PolicyActivities.evaluateUser), so the identity timeline records it.
   * `reviewExclusionsLiftedSince`: the "before" side of a mover run (evaluateHonouringReviews).
   */
  async evaluate(
    user: StandardUserDto,
    tenantId?: string,
    options?: { forProvisioning?: boolean; reviewExclusionsLiftedSince?: Date },
  ): Promise<PolicyProvisioningIntent> {
    const startTime = Date.now();
    const activePolicies = await this.policyService.findActive();
    this.logger.log(
      `[EVALUATE] Found ${activePolicies.length} active policies for user ${maskEmail(user.email)}`,
    );

    if (activePolicies.length === 0) {
      this.logger.warn(`[EVALUATE] ⚠️ No active policies found! Check policy status in UI.`);
    }

    const resolvedTenantId =
      tenantId ??
      (() => {
        try {
          return getCurrentTenantId();
        } catch {
          return this.authConf.DEFAULT_TENANT_ID;
        }
      })();

    const { intent, suppressed } = await this.evaluateHonouringReviews(
      user,
      activePolicies,
      resolvedTenantId,
      options?.reviewExclusionsLiftedSince,
    );

    const violations = await this.validateSod(resolvedTenantId, intent);
    const sodResult = toSoDValidationResult(violations);

    if (sodResult.blockers.length > 0) {
      this.logger.error('SoD violations detected', undefined, { violations: sodResult.blockers });
    }
    if (sodResult.warnings.length > 0) {
      this.logger.warn('SoD warnings', { violations: sodResult.warnings });
    }

    const durationMs = Date.now() - startTime;
    const matchedPolicies = [...new Set(intent.operations.map((op) => op.sourcePolicy))];

    const identityId = user._id ? String(user._id) : undefined;
    this.eventEmitter.emit(DomainEventType.POLICY_EVALUATED, identityId ?? 'policy-engine', {
      ...(identityId ? { identityId } : {}),
      matchedPolicies,
      generatedOperations: intent.operations.length,
      durationMs,
      ...(options?.forProvisioning ? { forProvisioning: true } : {}),
    });

    return {
      operations: intent.operations,
      ...(intent.adminOperations?.length ? { adminOperations: intent.adminOperations } : {}),
      ...(sodResult.warnings.length > 0 && { sodWarnings: sodResult.warnings }),
      sodValidation: sodResult,
      ...(suppressed.length > 0 && { suppressedOperations: suppressed }),
    };
  }

  /**
   * Evaluate for risk scoring (never throws). Returns intent and SoD violation count.
   * Used by RiskScoringService to compute SoD factor without blocking on BLOCK violations.
   */
  async evaluateForRiskScoring(
    user: StandardUserDto,
    tenantId: string,
  ): Promise<{ intent: PolicyProvisioningIntent; sodViolationCount: number }> {
    const activePolicies = await this.policyService.findActive();
    const { intent } = await this.evaluateHonouringReviews(user, activePolicies, tenantId);
    const violations = await this.validateSod(tenantId, intent);
    return {
      intent: {
        operations: intent.operations,
        ...(intent.adminOperations?.length ? { adminOperations: intent.adminOperations } : {}),
        ...(violations.length > 0 && { sodWarnings: violations }),
      },
      sodViolationCount: violations.length,
    };
  }

  /**
   * Evaluate operations without running SoD. Used by access-requests to build
   * the merged ops set for a single SoD validation (avoids double SoD query).
   * `includeAdminOperations`: also the operations PamFilterService moves to the linked admin
   * account (what one person holds, for SoD); without it the person's own account only.
   * `reviewExclusionsLiftedSince`: the "before" side of the access preview.
   */
  async evaluateOperationsWithoutSod(
    user: StandardUserDto,
    tenantId?: string,
    options?: { includeAdminOperations?: boolean; reviewExclusionsLiftedSince?: Date },
  ): Promise<ProvisioningOperation[]> {
    const activePolicies = await this.policyService.findActive();
    const resolvedTenantId =
      tenantId ??
      (() => {
        try {
          return getCurrentTenantId();
        } catch {
          return this.authConf.DEFAULT_TENANT_ID;
        }
      })();
    const { intent } = await this.evaluateHonouringReviews(
      user,
      activePolicies,
      resolvedTenantId,
      options?.reviewExclusionsLiftedSince,
    );
    return options?.includeAdminOperations ? allOperations(intent) : intent.operations;
  }

  /**
   * The policies' intent for the user without what an access review revoked for the identity
   * (its active review exclusions, review-exclusion-match.ts), split for PAM. The exclusions
   * apply before the split, so neither the person's own account nor the linked admin account
   * gets a suppressed operation, and SoD (run by the callers on the result) does not count it.
   * `liftedSince` (the access baseline's time, for the "before" side of a mover run or preview):
   * an exclusion lifted after it still counts there, since the review took that access away and
   * no run gave it back yet; the run's delta then adds it.
   */
  private async evaluateHonouringReviews(
    user: StandardUserDto,
    policies: Array<Policy | PolicyDocument>,
    tenantId: string,
    liftedSince?: Date,
  ): Promise<{ intent: PolicyProvisioningIntent; suppressed: SuppressedOperation[] }> {
    const evaluated = await this.evaluateWithPolicies(user, policies, tenantId);
    const exclusions = await this.reviewExclusions.activeForProfile(user, tenantId, liftedSince);
    const { operations, suppressed } = withoutReviewExclusions(evaluated.operations, exclusions);
    if (suppressed.length > 0) {
      this.logger.log(
        `[EVALUATE] ${suppressed.length} operations suppressed by access review exclusions`,
      );
    }
    const intent = await this.pamFilter.apply({ ...evaluated, operations }, tenantId);
    return { intent, suppressed };
  }

  /**
   * Pure evaluation logic — takes a user and a list of policies,
   * returns the merged provisioning intent.
   *
   * Split provisioning: evaluates against root (primary) AND each active contract.
   * Entitlements from all matching contracts are UNIONED and deduplicated.
   */
  async evaluateWithPolicies(
    user: StandardUserDto,
    policies: Array<Policy | PolicyDocument>,
    tenantId?: string,
  ): Promise<PolicyProvisioningIntent> {
    const operations: PolicyProvisioningIntent['operations'] = [];
    const employmentType = user.employmentType;
    const isMachineIdentity =
      employmentType === EmploymentType.SERVICE_ACCOUNT ||
      employmentType === EmploymentType.ADMIN_ACCOUNT;

    for (const policy of policies) {
      if (isMachineIdentity) {
        const targetTypes = policy.targetEmploymentTypes;
        const targetsMachine =
          Array.isArray(targetTypes) &&
          targetTypes.length > 0 &&
          targetTypes.includes(employmentType);
        if (!targetsMachine) {
          this.logger.log(
            `[EVALUATE] Skipping policy "${policy.name}" — machine identity (${employmentType}) not in targetEmploymentTypes`,
          );
          continue;
        }
      }

      this.logger.debug(
        `[EVALUATE] Checking policy "${policy.name}" against user ${maskEmail(user.email)}`,
      );
      this.logger.debug(
        `[EVALUATE] Policy has ${policy.conditionGroups?.length || 0} condition groups`,
      );

      // 1. Root-level evaluation (backward compatible — primary contract)
      const rootMatches = this.matchesPolicy(user, policy);
      this.logger.debug(`[EVALUATE] Policy "${policy.name}" root match: ${rootMatches}`);

      if (rootMatches) {
        await this.addPolicyActions(operations, policy, tenantId);
      }

      // 2. Per-contract evaluation (split provisioning — secondary contracts)
      const contracts = Array.isArray(user.contracts) ? user.contracts : [];
      if (contracts.length > 0) {
        for (const contract of contracts) {
          if (contract.status === 'TERMINATED') continue;
          const contractView: StandardUserDto = {
            ...user,
            jobTitle: contract.title,
            departmentName: contract.department,
            departmentCode: contract.department,
          };
          if (this.matchesPolicy(contractView, policy)) {
            this.logger.log(
              `[EVALUATE] ✅ Policy "${policy.name}" MATCHED via contract ${contract.id}`,
            );
            await this.addPolicyActions(operations, policy, tenantId);
          }
        }
      }
    }

    const deduped = this.deduplicateOperations(operations);
    this.logger.log(
      `[EVALUATE] Final result: ${deduped.length} operations (after dedup) for user ${maskEmail(user.email)}`,
    );
    return { operations: deduped };
  }

  private async addPolicyActions(
    operations: PolicyProvisioningIntent['operations'],
    policy: Policy | PolicyDocument,
    tenantId?: string,
  ): Promise<void> {
    const pushAction = (action: {
      type: string;
      target: string;
      params?: Record<string, string | number | boolean>;
      timeConstraint?: { durationDays?: number; expiresAt?: Date };
    }) => {
      operations.push({
        type: this.mapActionType(action.type),
        action: 'add' as const,
        target: action.target,
        targetId: String(
          action.params?.groupName ||
            action.params?.licenseSku ||
            action.params?.roleTemplateId ||
            action.params?.roleName ||
            action.params?.attributeName ||
            action.params?.policyName ||
            action.params?.mfaMethod ||
            action.type ||
            '',
        ),
        params: action.params,
        sourcePolicy: policy.name,
        ...(action.timeConstraint && { timeConstraint: action.timeConstraint }),
      });
    };

    if (policy.roleBundleId) {
      try {
        const bundleActions = await this.roleBundleResolver.resolveWithInheritance(
          policy.roleBundleId,
          tenantId,
        );
        for (const action of bundleActions) {
          pushAction(action);
        }
      } catch (err: unknown) {
        // No partial intent: without the bundle's operations a mover or reconcile run would read
        // their absence as a removal. The caller's failure handling (a retried activity) applies.
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Role bundle ${policy.roleBundleId} of policy "${policy.name}" could not be resolved: ${reason}`,
        );
      }
    }

    for (const action of policy.actions || []) {
      pushAction(action);
    }
  }

  private deduplicateOperations(
    operations: PolicyProvisioningIntent['operations'],
  ): PolicyProvisioningIntent['operations'] {
    const seen = new Set<string>();
    return operations.filter((op) => {
      const key = `${op.target}:${op.type}:${op.targetId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Return only the count of users that match the policy (for list/impact display).
   * Uses paginated streaming to avoid loading all users into memory.
   */
  async getImpactCount(policyId: string): Promise<number> {
    const policy = await this.policyService.findOne(policyId);
    let count = 0;
    let skip = 0;
    let total = 0;
    do {
      const [users, pageTotal] = await this.identityQuery.findAllPaginated(
        skip,
        skip + POLICY_PAGE_SIZE,
      );
      if (skip === 0) total = pageTotal;
      for (const user of users) {
        const typedUser = user as unknown as StandardUserDto;
        if (!this.shouldEvaluatePolicyForUser(typedUser, policy)) continue;
        if (this.matchesPolicy(typedUser, policy)) count++;
      }
      skip += POLICY_PAGE_SIZE;
    } while (skip < total);
    return count;
  }

  // ── Simulate: run a single policy against all hub users ───────────

  async simulate(policyOrId: string | Partial<Policy>): Promise<SimulationResult> {
    // Resolve policy
    let policy: Partial<Policy>;
    if (typeof policyOrId === 'string') {
      policy = await this.policyService.findOne(policyOrId);
    } else {
      policy = policyOrId;
    }

    // Stream users in pages to avoid OOM
    const matchedUsers: SimulationResult['matchedUsers'] = [];
    let skip = 0;
    let total = 0;
    do {
      const [users, pageTotal] = await this.identityQuery.findAllPaginated(
        skip,
        skip + POLICY_PAGE_SIZE,
      );
      if (skip === 0) total = pageTotal;
      for (const user of users) {
        const typedUser = user as unknown as StandardUserDto;
        if (!this.shouldEvaluatePolicyForUser(typedUser, policy as Policy)) continue;
        if (this.matchesPolicy(typedUser, policy as Policy)) {
          matchedUsers.push({
            id: String(user._id ?? user.email ?? ''),
            firstName: String(user.firstName ?? ''),
            lastName: String(user.lastName ?? ''),
            email: String(user.email ?? ''),
            department: String(user.departmentName ?? user.departmentCode ?? ''),
            jobTitle: String(user.jobTitle ?? ''),
            employmentType: String(user.employmentType ?? ''),
            location: String(user.location ?? user.city ?? ''),
            status: String(user.status ?? ''),
          });
        }
      }
      skip += POLICY_PAGE_SIZE;
    } while (skip < total);

    const matchedCount = matchedUsers.length;
    const totalUsers = total;

    // Count actions by target system
    const actionsBySystem: Record<string, number> = {};
    for (const action of policy.actions || []) {
      actionsBySystem[action.target] = (actionsBySystem[action.target] || 0) + 1;
    }

    return {
      totalUsers,
      matchedCount,
      matchPercentage: totalUsers > 0 ? Math.round((matchedCount / totalUsers) * 100) : 0,
      matchedUsers: matchedUsers.slice(0, 20), // Cap at 20 for the response
      actionsBySystem,
      totalOperations: (policy.actions?.length || 0) * matchedCount,
    };
  }

  // ── Machine Identity Safety ──────────────────────────────────────

  /**
   * Machine identities (SERVICE_ACCOUNT, ADMIN_ACCOUNT) are excluded unless policy explicitly targets them.
   */
  private shouldEvaluatePolicyForUser(user: StandardUserDto, policy: Policy): boolean {
    const employmentType = user?.employmentType;
    const isMachineIdentity =
      employmentType === EmploymentType.SERVICE_ACCOUNT ||
      employmentType === EmploymentType.ADMIN_ACCOUNT;
    if (!isMachineIdentity) return true;
    const targetTypes = policy.targetEmploymentTypes;
    return (
      Array.isArray(targetTypes) && targetTypes.length > 0 && targetTypes.includes(employmentType)
    );
  }

  // ── Condition Evaluation ──────────────────────────────────────────

  /**
   * Check if a user matches ALL condition groups of a policy.
   * Each group is evaluated independently, then all must pass.
   */
  private matchesPolicy(user: StandardUserDto, policy: Policy): boolean {
    if (!policy.conditionGroups?.length) {
      this.logger.warn(`[MATCH] Policy "${policy.name}" has no condition groups!`);
      return false;
    }

    this.logger.debug(
      `[MATCH] Evaluating ${policy.conditionGroups.length} condition groups for policy "${policy.name}"`,
    );

    const groupResults = policy.conditionGroups.map((group, idx) => {
      this.logger.debug(
        `[MATCH] Group ${idx + 1}: join=${group.join}, conditions=${group.conditions.length}`,
      );

      const results = group.conditions.map((condition, condIdx) => {
        const result = this.evaluateCondition(user, condition);
        this.logger.debug(
          `[MATCH]   Condition ${condIdx + 1}: ${condition.field} ${condition.operator} "${condition.value}" = ${result}`,
        );
        // PE-3: Do not log user[field] — may contain PII (email, name, etc.)
        return result;
      });

      // A group without conditions matches nobody (an AND of nothing would be true for everyone)
      const groupPassed =
        results.length > 0 &&
        (group.join === 'AND' ? results.every(Boolean) : results.some(Boolean));

      this.logger.debug(`[MATCH] Group ${idx + 1} result (${group.join}): ${groupPassed}`);
      return groupPassed;
    });

    const finalResult = groupResults.every(Boolean);
    this.logger.debug(
      `[MATCH] Final policy match result: ${finalResult} (all ${groupResults.length} groups must pass)`,
    );

    return finalResult;
  }

  /**
   * Resolve user field value, supporting:
   * - Frontend aliases (e.g. department → departmentName/departmentCode).
   * - contracts.<prop>: returns array of prop from each contract (enables user.contracts.some(c => c.department === 'X')-style rules).
   * - customAttributes.<key>: returns value from customAttributes.
   * Uses typed accessors only — no Record<string, unknown> casts.
   */
  private resolveUserField(
    user: StandardUserDto,
    field: string,
  ): string | number | boolean | string[] | undefined {
    // Guard against prototype pollution — block dangerous property names
    const blocklist = new Set(['__proto__', 'constructor', 'prototype']);
    if (blocklist.has(field)) return undefined;

    // PE-4 (IGA-01): Block sensitive fields — defense-in-depth against condition exfiltration
    const sensitiveBlocklist = new Set([
      'passwordHash',
      'mfaSecret',
      'refreshTokenHash',
      'inviteToken',
      'password',
      'clientSecret',
      'apiKey',
    ]);
    const fieldLower = field.toLowerCase();
    if (
      sensitiveBlocklist.has(field) ||
      sensitiveBlocklist.has(fieldLower) ||
      /secret|password|token/i.test(field)
    ) {
      return undefined;
    }

    // customAttributes.<key>
    if (field.startsWith('customAttributes.') && field.length > 'customAttributes.'.length) {
      const key = field.slice('customAttributes.'.length).trim();
      if (blocklist.has(key)) return undefined;
      if (
        sensitiveBlocklist.has(key) ||
        sensitiveBlocklist.has(key.toLowerCase()) ||
        /secret|password|token/i.test(key)
      ) {
        return undefined;
      }
      const val = user.customAttributes?.[key];
      return val !== undefined && val !== null && val !== ''
        ? (val as string | number | boolean)
        : undefined;
    }

    // Multi-contract: "contracts.department", "contracts.title", etc. → array of values
    if (field.startsWith('contracts.') && field.length > 'contracts.'.length) {
      const prop = field.slice('contracts.'.length).trim();
      if (blocklist.has(prop)) return undefined;
      if (
        sensitiveBlocklist.has(prop) ||
        sensitiveBlocklist.has(prop.toLowerCase()) ||
        /secret|password|token/i.test(prop)
      ) {
        return undefined;
      }
      const contracts = Array.isArray(user?.contracts) ? user.contracts : [];
      const accessor = CONTRACT_FIELD_ACCESSORS[prop];
      if (accessor) {
        return contracts.map(accessor).filter((v): v is string => v != null && v !== '');
      }
      return undefined;
    }

    // User fields: typed accessors with aliases (module-level for performance)
    const accessor = USER_FIELD_ACCESSORS[field];
    if (accessor) {
      const v = accessor(user);
      return v !== undefined && v !== null && v !== '' ? v : undefined;
    }
    return undefined;
  }

  /**
   * Evaluate a single condition against a user.
   * Reads user fields dynamically and applies the operator.
   * When the resolved value is an array (e.g. from contracts.department), uses "any element matches" semantics
   * so that e.g. user.contracts.some(c => c.department === 'Medical') is expressed as field=contracts.department, operator=equals, value=Medical.
   */
  private evaluateCondition(
    user: StandardUserDto,
    condition: { field: string; operator: string; value: string | string[] },
  ): boolean {
    const rawValue = this.resolveUserField(user, condition.field);

    // Handle is_empty / is_not_empty first (they don't need a value)
    if (condition.operator === 'is_empty') {
      if (Array.isArray(rawValue)) return rawValue.length === 0;
      return rawValue === undefined || rawValue === null || rawValue === '';
    }
    if (condition.operator === 'is_not_empty') {
      if (Array.isArray(rawValue)) return rawValue.length > 0;
      return rawValue !== undefined && rawValue !== null && rawValue !== '';
    }

    // Array context (e.g. contracts.department): "any element matches"
    if (Array.isArray(rawValue)) {
      const condStr = String(condition.value ?? '').toLowerCase();
      const lowerValues = rawValue.map((v) => String(v).toLowerCase());
      switch (condition.operator) {
        case 'equals':
          return lowerValues.some((v) => v === condStr);
        case 'not_equals':
          return lowerValues.every((v) => v !== condStr);
        case 'contains':
          return lowerValues.some((v) => v.includes(condStr));
        case 'starts_with':
          return lowerValues.some((v) => v.startsWith(condStr));
        case 'ends_with':
          return lowerValues.some((v) => v.endsWith(condStr));
        case 'in':
          if (Array.isArray(condition.value)) {
            const condArr = condition.value.map((v: string) => String(v).toLowerCase());
            return lowerValues.some((v) => condArr.includes(v));
          }
          return lowerValues.some((v) => v === condStr);
        case 'not_in':
          if (Array.isArray(condition.value)) {
            const condArr = condition.value.map((v: string) => String(v).toLowerCase());
            return lowerValues.every((v) => !condArr.includes(v));
          }
          return lowerValues.every((v) => v !== condStr);
        case 'regex':
          return rawValue.some((v) => safeRegexTest(String(condition.value), String(v)));
        default:
          return false;
      }
    }

    // If the user field doesn't exist, the condition fails
    if (rawValue === undefined || rawValue === null) return false;

    const userStr = String(rawValue).toLowerCase();
    const condValue = condition.value;

    switch (condition.operator) {
      case 'equals':
        return userStr === String(condValue).toLowerCase();

      case 'not_equals':
        return userStr !== String(condValue).toLowerCase();

      case 'contains':
        return userStr.includes(String(condValue).toLowerCase());

      case 'starts_with':
        return userStr.startsWith(String(condValue).toLowerCase());

      case 'ends_with':
        return userStr.endsWith(String(condValue).toLowerCase());

      case 'in':
        if (Array.isArray(condValue)) {
          return condValue.map((v) => String(v).toLowerCase()).includes(userStr);
        }
        return userStr === String(condValue).toLowerCase();

      case 'not_in':
        if (Array.isArray(condValue)) {
          return !condValue.map((v) => String(v).toLowerCase()).includes(userStr);
        }
        return userStr !== String(condValue).toLowerCase();

      case 'regex':
        return safeRegexTest(String(condValue), String(rawValue));

      case 'greater_than':
        return Number(rawValue) > Number(condValue);

      case 'less_than':
        return Number(rawValue) < Number(condValue);

      default:
        this.logger.warn(`Unknown operator: ${condition.operator}`);
        return false;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private mapActionType(frontendType: string): PolicyProvisioningIntent['operations'][0]['type'] {
    const map: Record<string, PolicyProvisioningIntent['operations'][0]['type']> = {
      assign_group: 'group',
      assign_license: 'license',
      assign_role: 'role',
      set_attribute: 'attribute',
      enable_mfa: 'mfa',
      apply_conditional_access: 'conditional_access',
      set_manager: 'attribute',
      send_notification: 'notification',
      trigger_workflow: 'workflow',
    };
    return map[frontendType] || 'attribute';
  }
}
