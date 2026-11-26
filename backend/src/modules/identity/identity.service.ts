import { Injectable } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';
import type { IdentityDocument, ProvisioningState } from './schemas/identity.schema';
import type { ScoredCandidate } from './correlation/candidate-suggestion.service';
import { IdentityQueryService } from './identity-query.service';
import type { CorrelationConfig } from '@shared/types/correlation-config';
import type { StoredNationalIdCleanup } from './national-id-cleanup';
import {
  IdentityMutationService,
  type UpdateOptions,
  type UpdateResult,
} from './identity-mutation.service';
import {
  IdentityCorrelationService,
  type EnsureIdentityOptions,
} from './identity-correlation.service';
import { IdentityUncorrelatedService } from './identity-uncorrelated.service';
import {
  IdentityProvisioningService,
  type RecordTargetAccountOutcome,
} from './identity-provisioning.service';
import { IdentityOnionService } from './identity-onion.service';
import { IdentityControlsService } from './identity-controls.service';
import {
  ContractCriticalMasteryService,
  type CanvasMastery,
} from './contract-critical-mastery.service';
import type { UpdateIdentityControls } from './dtos/update-identity-controls.dto';
import type { ReconciliationScope } from '@shared/utils/reconciliation-scope';
import type {
  ConflictFlagsState,
  HubBeforeConflictFlag,
  HubBeforeWrite,
  IdentityHubState,
} from './identity-hub-state';

/**
 * The Heart: Golden Record hub — thin facade delegating to focused sub-services.
 * All external consumers import this class; the sub-services are module-internal.
 */
@Injectable()
export class IdentityService {
  constructor(
    private readonly query: IdentityQueryService,
    private readonly mutation: IdentityMutationService,
    private readonly correlation: IdentityCorrelationService,
    private readonly uncorrelated: IdentityUncorrelatedService,
    private readonly provisioning: IdentityProvisioningService,
    private readonly onion: IdentityOnionService,
    private readonly controls: IdentityControlsService,
    private readonly contractCriticalMastery: ContractCriticalMasteryService,
  ) {}

  // ── Query ────────────────────────────────────────────────────────

  findAll(options?: {
    includeDeleted?: boolean;
    employmentTypes?: string[];
    includeSources?: boolean;
    includeProvisioning?: boolean;
  }): Promise<Record<string, unknown>[]> {
    return this.query.findAll(options);
  }
  findAllPaginated(
    start?: number,
    end?: number,
    options?: {
      includeDeleted?: boolean;
      filter?: Record<string, unknown>;
      trustedFilter?: boolean;
      search?: string;
    },
  ): Promise<[Record<string, unknown>[], number]> {
    return this.query.findAllPaginated(start, end, options);
  }
  findOne(
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Record<string, unknown> | null> {
    return this.query.findOne(id, options);
  }
  findById(
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Record<string, unknown> | null> {
    return this.query.findById(id, options);
  }
  findByEmail(
    email: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Record<string, unknown> | null> {
    return this.query.findByEmail(email, options);
  }
  /** Work emails of the tenant's live identities by employee id (IdentityQueryService). */
  findEmailsByEmployeeIds(employeeIds: string[]): Promise<Map<string, string>> {
    return this.query.findEmailsByEmployeeIds(employeeIds);
  }
  findUsersPageForReconciliation(
    skip: number,
    limit: number,
    scope?: ReconciliationScope,
  ): Promise<{ users: Record<string, unknown>[]; total?: number }> {
    return this.query.findUsersPageForReconciliation(skip, limit, scope);
  }
  findUserForReconciliation(userId: string): Promise<Record<string, unknown> | null> {
    return this.query.findUserForReconciliation(userId);
  }
  findLiveOwnerKeys(keys: string[]): Promise<Set<string>> {
    return this.query.findLiveOwnerKeys(keys);
  }
  findUsersByTag(tag: string): Promise<Record<string, unknown>[]> {
    return this.query.findUsersByTag(tag);
  }
  findUsersByTagAndStatus(tag: string, status: UserStatus): Promise<Record<string, unknown>[]> {
    return this.query.findUsersByTagAndStatus(tag, status);
  }
  deleteUsersByTag(tag: string): Promise<{ deletedCount: number }> {
    return this.query.deleteUsersByTag(tag);
  }

  // ── Mutation ─────────────────────────────────────────────────────

  saveOrUpdate(
    dto: StandardUserDto,
    session?: ClientSession,
    beforeWrite?: HubBeforeWrite,
    beforeConflictFlag?: HubBeforeConflictFlag,
  ): Promise<Record<string, unknown>> {
    return this.mutation.saveOrUpdate(dto, session, beforeWrite, beforeConflictFlag);
  }
  saveOrUpdateReportingCreated(
    dto: StandardUserDto,
    beforeWrite?: HubBeforeWrite,
    beforeConflictFlag?: HubBeforeConflictFlag,
    options?: EnsureIdentityOptions,
  ): Promise<Record<string, unknown>> {
    return this.mutation.saveOrUpdateReportingCreated(
      dto,
      beforeWrite,
      beforeConflictFlag,
      options,
    );
  }
  restoreHubState(id: string, state: IdentityHubState): Promise<boolean> {
    return this.mutation.restoreHubState(id, state);
  }
  restoreConflictFlags(prior: ConflictFlagsState, incomingIdentityId: string): Promise<boolean> {
    return this.mutation.restoreConflictFlags(prior, incomingIdentityId);
  }
  removeIdentity(id: string, reason: string): Promise<boolean> {
    return this.mutation.removeIdentity(id, reason);
  }
  create(
    dto: StandardUserDto,
    actor?: string,
    options?: { triggerWorkflow?: boolean },
  ): Promise<Record<string, unknown>> {
    return this.mutation.create(dto, actor, options);
  }
  update(
    id: string,
    updateDto: Partial<StandardUserDto>,
    actor?: string,
    options?: UpdateOptions,
  ): Promise<Record<string, unknown> | null> {
    return this.mutation.update(id, updateDto, actor, options);
  }
  updateWithChanges(
    id: string,
    updateDto: Partial<StandardUserDto>,
    actor?: string,
    options?: UpdateOptions,
  ): Promise<UpdateResult> {
    return this.mutation.updateWithChanges(id, updateDto, actor, options);
  }
  markAsDeleted(
    id: string,
    by?: { actor: string; reason: string },
  ): Promise<Record<string, unknown> | null> {
    return this.mutation.markAsDeleted(id, by);
  }

  // ── Correlation ──────────────────────────────────────────────────

  ensureIdentityFromUser(
    dto: StandardUserDto,
    session?: ClientSession,
  ): Promise<IdentityDocument | null> {
    return this.correlation.ensureIdentityFromUser(dto, session);
  }
  isHrSource(sourceSystem: string): Promise<boolean> {
    return this.correlation.isHrSource(sourceSystem);
  }
  cleanStoredNationalIds(
    tenantId: string,
    previous: CorrelationConfig | undefined,
    saved: CorrelationConfig | undefined,
  ): Promise<StoredNationalIdCleanup | null> {
    return this.onion.cleanStoredNationalIds(tenantId, previous, saved);
  }
  pushSourceAndReconcile(
    identityIdOrEmailOrSourceKey: string,
    sourceName: string,
    externalId: string,
    rawData: Record<string, unknown>,
    options?: {
      contractType?: 'primary' | 'secondary';
      sourceRole?: 'primary-hr' | 'secondary-hr' | 'target';
      /** A provisioning run's write-back (see IdentityCorrelationService). */
      writeback?: boolean;
    },
  ): Promise<IdentityDocument | null> {
    return this.correlation.pushSourceAndReconcile(
      identityIdOrEmailOrSourceKey,
      sourceName,
      externalId,
      rawData,
      options,
    );
  }
  updateControls(
    identityId: string,
    controls: UpdateIdentityControls,
    actor?: string,
  ): Promise<IdentityDocument | null> {
    return this.controls.updateControls(identityId, controls, actor);
  }
  /** The hourly expiry sweep: end the attribute controls whose expiry has passed. */
  endExpiredControls(tenantId: string, now: Date, limit: number): Promise<number> {
    return this.controls.endExpiredControls(tenantId, now, limit);
  }
  /**
   * POST /blueprints/save: refuses (400) a Field Mastery setting that names a secondary HR source
   * or a target for a contract-critical field.
   */
  assertCanvasMastery(canvas: CanvasMastery): Promise<void> {
    return this.contractCriticalMastery.assertCanvas(canvas);
  }

  // ── Uncorrelated Queue ───────────────────────────────────────────

  getCandidatesForIdentity(identityId: string): Promise<ScoredCandidate[]> {
    return this.uncorrelated.getCandidatesForIdentity(identityId);
  }
  countUncorrelated(tenantId?: string): Promise<number> {
    return this.uncorrelated.countUncorrelated(tenantId);
  }
  getConflicts(tenantId?: string): Promise<Array<Record<string, unknown>>> {
    return this.uncorrelated.getConflicts(tenantId);
  }
  getUncorrelated(tenantId?: string): Promise<Array<Record<string, unknown>>> {
    return this.uncorrelated.getUncorrelated(tenantId);
  }
  linkUncorrelatedToTargetFormatted(
    uncorrelatedId: string,
    targetIdentityId: string,
    actor?: string,
  ) {
    return this.uncorrelated.linkUncorrelatedToTargetFormatted(
      uncorrelatedId,
      targetIdentityId,
      actor,
    );
  }
  createStandaloneFormatted(uncorrelatedId: string, actor?: string) {
    return this.uncorrelated.createStandaloneFormatted(uncorrelatedId, actor);
  }
  resolveConflictFormatted(identityId: string, action: 'merge' | 'split' | 'dismiss') {
    return this.uncorrelated.resolveConflictFormatted(identityId, action);
  }
  findIdentityByEmailFormatted(email: string) {
    return this.uncorrelated.findIdentityByEmailFormatted(email);
  }
  findIdentityByIdFormatted(id: string) {
    return this.uncorrelated.findIdentityByIdFormatted(id);
  }

  // ── Provisioning ─────────────────────────────────────────────────

  findIdentitiesForOnboarding(): Promise<IdentityDocument[]> {
    return this.provisioning.findIdentitiesForOnboarding();
  }
  findIdentitiesForOnboardingPaginated(skip: number, limit: number): Promise<IdentityDocument[]> {
    return this.provisioning.findIdentitiesForOnboardingPaginated(skip, limit);
  }
  getProvisionedTargetsForDeprovision(identityId: string, tenantId: string) {
    return this.provisioning.getProvisionedTargetsForDeprovision(identityId, tenantId);
  }
  getOffboardingTargets(identityId: string, tenantId: string) {
    return this.provisioning.getOffboardingTargets(identityId, tenantId);
  }
  updateProvisioningState(
    identityId: string,
    targetSystem: string,
    status: ProvisioningState['status'],
    errorMsg?: string,
    writebackComplete?: boolean,
    options?: { expiresAt?: Date; activeFrom?: Date; grantedBy?: 'policy' | 'request' | 'manual' },
  ): Promise<IdentityDocument | null> {
    return this.provisioning.updateProvisioningState(
      identityId,
      targetSystem,
      status,
      errorMsg,
      writebackComplete,
      options,
    );
  }

  /** The account id as the identity's target account, nothing else (see the provisioning service). */
  recordTargetAccountId(
    identityId: string,
    targetSystem: string,
    accountId: string,
  ): Promise<RecordTargetAccountOutcome> {
    return this.provisioning.recordTargetAccountId(identityId, targetSystem, accountId);
  }

  // ── Onion Model ──────────────────────────────────────────────────

  buildProfileWithContractsForPolicy(identity: IdentityDocument): Promise<Record<string, unknown>> {
    return this.onion.buildProfileWithContractsForPolicy(identity);
  }
  /** IIdentityQueryPort: the profile onboarding and the mover evaluate, with _id and tenantId. */
  async findPolicyProfileById(id: string): Promise<Record<string, unknown> | null> {
    const identity = await this.onion.findIdentityById(id);
    if (!identity) return null;
    const profile = await this.onion.buildProfileWithContractsForPolicy(identity);
    return { ...profile, _id: String(identity._id), tenantId: identity.tenantId };
  }
  findIdentityByEmail(
    email: string,
    options?: { includeDeleted?: boolean; tenantId?: string },
  ): Promise<IdentityDocument | null> {
    return this.onion.findIdentityByEmail(email, options);
  }
  findIdentityById(
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<IdentityDocument | null> {
    return this.onion.findIdentityById(id, options);
  }
  findIdentityBySourceKey(
    sourceName: string,
    externalId: string,
    tenantId: string,
    options?: { includeDeleted?: boolean; session?: ClientSession },
  ) {
    return this.onion.findIdentityBySourceKey(sourceName, externalId, tenantId, options);
  }

  // ── Access baseline (shared/utils/access-baseline.ts) ────────────

  recordInitialAccessBaseline(identityId: string): Promise<boolean> {
    return this.onion.recordInitialAccessBaseline(identityId);
  }
  advanceAccessBaseline(identityId: string, applied: Record<string, unknown>): Promise<void> {
    return this.onion.advanceAccessBaseline(identityId, applied);
  }
}
