import { Injectable, NotFoundException } from '@nestjs/common';
import { IdentityException } from '@shared/exceptions/domain-exceptions';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { ClientSession, UpdateQuery } from 'mongoose';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { IdentityDocument } from './schemas/identity.schema';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import {
  IdentityCorrelationService,
  type EnsureIdentityOptions,
} from './identity-correlation.service';
import { IdentityQueryService } from './identity-query.service';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { NOT_DELETED, DEFAULT_TENANT } from './identity.constants';
import {
  saveWithRetry,
  computePrimaryFromContracts,
  projectIdentityToUser,
  changedProfileFields,
  profileUnderKillSwitch,
} from './identity-helpers';
import { maskEmailValues, maskPiiDeep } from './identity-pii';
import { changedAccessAttributes } from '@shared/utils/access-baseline';
import { normalizeEmail } from '@shared/utils/email';
import { overridesAfterEdit, type ContractAttribute } from './manual-contract-overrides';
import { ReconciliationService } from './reconciliation.service';
import { CONTROLLED_ATTRIBUTES, controlValue } from './attribute-controls';
import { HrMasteredFieldsException, type RefusedField } from './hr-mastered-fields.exception';
import { uniqueValueConflict } from './identity-write-errors';
import {
  mayCarryNationalId,
  nationalIdKeys,
  removeNationalIds,
  removeNationalIdsFromConflict,
  removeNationalIdsFromHubState,
} from './national-id';
import {
  CONFLICT_FLAG_FIELDS,
  type ConflictFlagsState,
  type HubBeforeConflictFlag,
  type HubBeforeWrite,
  type IdentityHubState,
  restoreHubWrite,
} from './identity-hub-state';

/** An update's result: the user, and the changes identity.updated reported. */
export interface UpdateResult {
  user: Record<string, unknown> | null;
  changedFields: string[];
  previousAttributes: Record<string, unknown>;
}

/** Options of an update (IdentityMutationService.update). */
export interface UpdateOptions {
  syncToEntra?: boolean;
  refuseHrMastered?: boolean;
  /** The caller asks the mover itself (PATCH /identity/:id): see IdentityUpdatedPayload. */
  moverRequested?: boolean;
}

/**
 * Identity write operations: create, update, delete.
 */
@Injectable()
export class IdentityMutationService {
  private readonly logger = this.loggerFactory.create(IdentityMutationService.name);

  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly identityCorrelation: IdentityCorrelationService,
    private readonly identityQuery: IdentityQueryService,
    private readonly loggerFactory: LoggerFactoryService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly reconciliationService: ReconciliationService,
  ) {}

  /**
   * The "Golden Record" Sync — used by Temporal Worker.
   * Ensures an Onion Identity exists so provisioning state can be tracked.
   * `beforeWrite`, `beforeConflictFlag`, `options`: see
   * IdentityCorrelationService.ensureIdentityFromUser.
   */
  async saveOrUpdate(
    dto: StandardUserDto,
    session?: ClientSession,
    beforeWrite?: HubBeforeWrite,
    beforeConflictFlag?: HubBeforeConflictFlag,
    options?: EnsureIdentityOptions,
  ): Promise<Record<string, unknown>> {
    computePrimaryFromContracts(dto);

    if (!dto.sourceSystem || !(dto.sourceUserId || dto.email)) {
      this.logger.warn(
        'saveOrUpdate: missing sourceSystem/sourceUserId, correlation may be limited',
      );
    }

    const identity = await this.identityCorrelation.ensureIdentityFromUser(
      dto,
      session,
      beforeWrite,
      beforeConflictFlag,
      options,
    );
    if (!identity) {
      throw new IdentityException('Failed to create or update Identity');
    }
    this.logger.log(`Hub Upsert completed for identity ${identity._id}`);
    const base = projectIdentityToUser(identity);
    const obj = identity.toObject();
    return {
      ...base,
      sourceSystem: obj.profile?.sourceSystem ?? obj.sources?.[0]?.sourceName ?? dto.sourceSystem,
      sourceUserId: obj.profile?.sourceUserId ?? obj.sources?.[0]?.externalId ?? dto.sourceUserId,
      createdAt: (obj as unknown as Record<string, unknown>).createdAt,
      updatedAt: (obj as unknown as Record<string, unknown>).updatedAt,
    };
  }

  /**
   * saveOrUpdate for the Hub writes that may mint an identity outside an HR sync and POST
   * /identity (onboarding's and bulk provisioning's saveToHub, test seeding): identity.created for
   * an identity the write minted, as an HR sync emits it, with ids and the source only (no email,
   * name or HR id). No session: the event is emitted at once.
   */
  async saveOrUpdateReportingCreated(
    dto: StandardUserDto,
    beforeWrite?: HubBeforeWrite,
    beforeConflictFlag?: HubBeforeConflictFlag,
    options?: EnsureIdentityOptions,
  ): Promise<Record<string, unknown>> {
    let minted = false;
    const saved = await this.saveOrUpdate(
      dto,
      undefined,
      async (before) => {
        minted = before === null; // correlation hands null to a write that mints
        await beforeWrite?.(before);
      },
      beforeConflictFlag,
      options,
    );
    if (minted) {
      const identityId = String(saved._id);
      this.eventEmitter.emit(
        DomainEventType.IDENTITY_CREATED,
        identityId,
        {
          identityId,
          sourceSystem: dto.sourceSystem || String(saved.sourceSystem),
          status: String(saved.status ?? dto.status),
        },
        typeof saved.tenantId === 'string' ? { tenantId: saved.tenantId } : undefined,
      );
    }
    return saved;
  }

  /**
   * Create User (Manual) — supports transactional outbox when MongoDB is a replica set.
   * @param options.triggerWorkflow When true, onboarding handler will trigger workflow (from POST /identity?triggerWorkflow=true)
   */
  async create(
    dto: StandardUserDto,
    actor?: string,
    options?: { triggerWorkflow?: boolean },
  ): Promise<Record<string, unknown>> {
    this.logger.log(`Manual Creation from ${dto.sourceSystem ?? 'unknown'}`);

    const enrichedDto = {
      ...dto,
      createdBy: dto.createdBy || actor || 'manual-ui',
      lastSyncedAt: new Date(),
    };

    // No email: the event reaches the audit log and the websocket. The onboarding handler reads
    // the address from the identity by its id.
    const payload = {
      identityId: '' as string,
      sourceSystem: dto.sourceSystem || 'manual-ui',
      ...(dto.sourceUserId ? { sourceUserId: dto.sourceUserId } : {}),
      status: dto.status || 'ACTIVE',
      triggerWorkflow: options?.triggerWorkflow,
    };
    const eventOptions = { actor: actor || dto.createdBy || 'manual-ui' };

    try {
      const session = await this.identityModel.db.startSession();
      let result: Record<string, unknown> | undefined;
      try {
        await session.withTransaction(async () => {
          result = await this.saveOrUpdate(enrichedDto, session);
          const identityId = String(result._id);
          payload.identityId = identityId;
          await this.eventEmitter.emitWithTransaction(
            DomainEventType.IDENTITY_CREATED,
            identityId,
            payload,
            session,
            eventOptions,
          );
        });
      } finally {
        // Also when the transaction failed or is not supported: an open session is held on the
        // server until it times out
        await session.endSession();
      }
      if (!result) {
        throw new NotFoundException('Identity not found');
      }
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('Transaction numbers') ||
        msg.includes('replica set') ||
        msg.includes('not supported')
      ) {
        this.logger.debug('MongoDB standalone detected, using non-transactional emit');
        const result = await this.saveOrUpdate(enrichedDto);
        const identityId = String(result._id);
        payload.identityId = identityId;
        this.eventEmitter.emit(DomainEventType.IDENTITY_CREATED, identityId, payload, eventOptions);
        return result;
      }
      throw err;
    }
  }

  /**
   * Update User (Partial Update) — PATCH /identity/:id, and SCIM inbound.
   * @param options.syncToEntra From PATCH /identity/:id?syncToEntra=true, carried on
   *   identity.updated. The controller starts that onboarding run itself, so the onboarding
   *   handler starts none for this update.
   * @param options.refuseHrMastered From PATCH /identity/:id and SCIM inbound: a change of a field
   *   an HR source masters is refused (HrMasteredFieldsException, refuseHrMasteredEdits).
   */
  async update(
    id: string,
    updateDto: Partial<StandardUserDto>,
    actor?: string,
    options?: UpdateOptions,
  ): Promise<Record<string, unknown> | null> {
    return (await this.updateWithChanges(id, updateDto, actor, options)).user;
  }

  /**
   * update, with what it changed as identity.updated reports it: the fields and their previous
   * values (access attributes only, emails masked, no national ID). PATCH ?syncToEntra=true hands
   * them to the run it starts (identity.move_requested). Nothing changed: both empty.
   */
  async updateWithChanges(
    id: string,
    updateDto: Partial<StandardUserDto>,
    actor?: string,
    options?: UpdateOptions,
  ): Promise<UpdateResult> {
    this.logger.log(`Updating user: ${id}`);
    return this.updateIdentityProfile(id, updateDto, actor, options);
  }

  /**
   * Mark user as deleted (soft delete) — used by offboarding workflow, and by an admin closing
   * the last failed target of an offboarding by hand (`by`: that admin and why). Idempotent: an
   * identity already deleted keeps its deletion and is not reported again.
   */
  async markAsDeleted(
    id: string,
    by: { actor: string; reason: string } = {
      actor: 'offboarding-workflow',
      reason: 'offboarding-workflow',
    },
  ): Promise<Record<string, unknown> | null> {
    this.logger.log(`Marking user as deleted: ${id}`);

    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const identity = await this.identityModel.findOne({ _id: id, tenantId: tid }).exec();
    if (!identity?.profile?.email) {
      this.logger.warn(`markAsDeleted: Identity ${id} not found or has no email`);
      return null;
    }

    const email = identity.profile.email;
    // Already deleted (a retried activity, a second close): the first deletion stands, with its
    // time (rehire detection compares the HR start date with it) and its one identity.deleted
    if (identity.deletedAt) return { _id: id, email, deletedAt: identity.deletedAt };
    // First, so a failure here leaves the identity live for the caller's retry
    if (identity.parentIdentityId) {
      await this.endLinkedAdminEntry(identity.parentIdentityId, id, tid);
    }
    const deletedAt = new Date();
    const live = await this.identityModel
      .findOneAndUpdate(
        { _id: id, tenantId: tid, ...NOT_DELETED },
        { $set: { deletedAt, deletedBy: by.actor } },
      )
      .exec();
    if (!live) {
      // Deleted meanwhile by another call, which reported it
      const current = await this.identityModel.findOne({ _id: id, tenantId: tid }).exec();
      return { _id: id, email, deletedAt: current?.deletedAt ?? deletedAt };
    }

    this.eventEmitter.emit(
      DomainEventType.IDENTITY_DELETED,
      id,
      { identityId: id, reason: by.reason },
      { actor: by.actor },
    );

    return { _id: id, email, deletedAt };
  }

  /**
   * A deleted admin identity (PAM) holds no privileged account, so its entry on the parent stops
   * counting as an active one (Privileged access page, risk scoring): INACTIVE, ended now.
   * activateAdminAccount refuses a deleted admin identity, so the entry stays INACTIVE. An entry
   * already INACTIVE keeps the time its session ended.
   */
  private async endLinkedAdminEntry(
    parentId: string,
    adminId: string,
    tenantId: string,
  ): Promise<void> {
    await this.identityModel
      .updateOne(
        {
          _id: parentId,
          tenantId,
          linkedAdminAccounts: { $elemMatch: { identityId: adminId, status: { $ne: 'INACTIVE' } } },
        },
        {
          $set: {
            'linkedAdminAccounts.$.status': 'INACTIVE',
            'linkedAdminAccounts.$.deactivatedAt': new Date(),
          },
        },
      )
      .exec();
  }

  /**
   * Put back what a Golden Record sync wrote (bulk rollback): the profile, sources, metadata,
   * soft-delete marker and Entra ID entries captured before it (hubRestoreUpdate). Controls and
   * the other provisioning entries are left as they are.
   * A national ID the captured state holds (a snapshot taken before the cleanup) is not written
   * back (removeNationalIdsFromHubState; the settings are read strictly).
   * Returns false when the identity is not in the current tenant.
   */
  async restoreHubState(id: string, captured: IdentityHubState): Promise<boolean> {
    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const state = structuredClone(captured);
    removeNationalIdsFromHubState(state, await this.nationalIdKeysOf(tid));
    const matched = await restoreHubWrite(this.identityModel, id, tid, state);
    this.logger.log(`Restored Golden Record ${id} (matched: ${matched ? 1 : 0})`);
    return matched;
  }

  /**
   * Put back the conflict flags a low-confidence match set on `captured.id` when it minted
   * `incomingIdentityId`. Only while the identity still carries that conflict (its
   * conflictDetails.incomingIdentityId): a conflict resolved or replaced since stays as it is.
   * A national ID a held row of `captured` holds is not written back.
   * Returns false when nothing was restored (no such conflict in the current tenant).
   */
  async restoreConflictFlags(
    captured: ConflictFlagsState,
    incomingIdentityId: string,
  ): Promise<boolean> {
    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const prior = structuredClone(captured);
    removeNationalIdsFromConflict(prior.conflictDetails, await this.nationalIdKeysOf(tid));
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    for (const field of CONFLICT_FLAG_FIELDS) {
      if (prior[field] === undefined) unset[`metadata.${field}`] = 1;
      else set[`metadata.${field}`] = prior[field];
    }
    // Bump the version so a concurrent save() of an older copy fails instead of undoing this.
    const update: UpdateQuery<IdentityDocument> = { $inc: { __v: 1 } };
    if (Object.keys(set).length > 0) update.$set = set;
    if (Object.keys(unset).length > 0) update.$unset = unset;
    const result = await this.identityModel
      .updateOne(
        {
          _id: prior.id,
          tenantId: tid,
          'metadata.conflictDetails.incomingIdentityId': incomingIdentityId,
        },
        update,
      )
      .exec();
    this.logger.log(`Restored conflict flags of ${prior.id} (matched: ${result.matchedCount})`);
    return result.matchedCount > 0;
  }

  /**
   * Hard-delete an identity that a rolled-back Golden Record sync created. Returns false when it
   * is not in the current tenant.
   */
  async removeIdentity(id: string, reason: string): Promise<boolean> {
    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const result = await this.identityModel.deleteOne({ _id: id, tenantId: tid }).exec();
    if (result.deletedCount === 0) return false;
    this.eventEmitter.emit(
      DomainEventType.IDENTITY_DELETED,
      id,
      { identityId: id, reason },
      { actor: reason },
    );
    return true;
  }

  /**
   * Update Identity.profile directly.
   * Uses optimistic concurrency retry to avoid silent data loss.
   * A body that changes no value writes nothing and emits nothing (no "Updated" timeline entry).
   * With options.refuseHrMastered a change of a field an HR source masters is refused (409).
   * The national ID never reaches the profile or identity.updated (takeNationalId): with the
   * tenant's rule and the secret its hash becomes the correlationId. A hash or an email another
   * identity already has is refused (409, uniqueValueConflict).
   */
  private async updateIdentityProfile(
    id: string,
    updateDto: Partial<StandardUserDto>,
    actor?: string,
    options?: UpdateOptions,
  ): Promise<UpdateResult> {
    const {
      _id: _idOmitted,
      sourceSystem: _sourceSystem,
      sourceUserId: _sourceUserId,
      tenantId: _tenantId,
      createdAt: _createdAt,
      createdBy: _createdBy,
      ...safeUpdates
    } = updateDto;

    // As every Hub write: the email trimmed and lower-cased (SCIM reaches here without the DTO)
    if (typeof safeUpdates.email === 'string')
      safeUpdates.email = normalizeEmail(safeUpdates.email);
    // The profile stores no contracts: what they change is the job title and department of the
    // primary one. Those fields stand in for them, so the HR-mastery check, the change check and
    // identity.updated (the mover) see the fields the edit really changes.
    if (safeUpdates.contracts !== undefined) {
      computePrimaryFromContracts(safeUpdates);
      delete safeUpdates.contracts;
    }
    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const current = await this.identityModel.findOne({ _id: id, tenantId: tid }).exec();
    if (!current?.profile?.email) throw new NotFoundException(`Identity with ID ${id} not found`);
    const nationalIdKeysRemoved = await this.takeNationalId(
      safeUpdates as Record<string, unknown>,
      tid,
    );
    const changed = changedProfileFields(
      profileUnderKillSwitch(current),
      safeUpdates as Record<string, unknown>,
    );
    if (changed.length === 0) {
      return {
        user: await this.identityQuery.findById(id),
        changedFields: [],
        previousAttributes: {},
      };
    }
    if (options?.refuseHrMastered) await this.refuseHrMasteredEdits(current, changed);
    // The mover's "before" profile (MoverEventHandler)
    let previousAttributes: Record<string, unknown> | undefined;
    const identity = await saveWithRetry(
      () => this.identityModel.findOne({ _id: id, tenantId: tid }).exec(),
      (doc) => {
        if (!doc?.profile?.email) throw new NotFoundException(`Identity with ID ${id} not found`);
        const existingProfile = doc.profile as unknown as Record<string, unknown>;
        const enrichedProfile: Record<string, unknown> = { ...existingProfile, ...safeUpdates };
        if (doc.controls?.isLoginDisabled === true && safeUpdates.status !== undefined) {
          // The kill switch holds the status SUSPENDED: the PATCHed status is the one it keeps
          // and gives back when it is turned off (ReconciliationService.reconcile)
          enrichedProfile.status = existingProfile.status;
          doc.set('metadata.statusUnderKillSwitch', safeUpdates.status);
        }
        // Only the access attributes whose value changed: the identity page sends every field,
        // and a trigger attribute sent unchanged must not start the mover. The event lands in
        // the audit log, the analytics index and the tenant websocket, so names, contact data
        // and identifiers stay out (the timeline still shows the field changed), and an email
        // value (managerEmail) is masked once compared: the mover reads it from the access
        // baseline. maskPiiDeep gives a plain copy (stored subdocuments compare by content).
        // A national ID the profile still holds (stored before the cleanup) stays out as well
        const before = maskPiiDeep(existingProfile);
        removeNationalIds(before, nationalIdKeysRemoved);
        previousAttributes = maskEmailValues(
          changedAccessAttributes(before, enrichedProfile, Object.keys(safeUpdates)),
        );
        // An edited department or title overrides the HR value it replaced in the policies'
        // HR contracts, until HR sends another value (manual-contract-overrides.ts)
        const overrides = overridesAfterEdit(
          doc.metadata?.manualOverrides,
          doc.sources ?? [],
          {
            departmentName: existingProfile.departmentName,
            jobTitle: existingProfile.jobTitle,
          },
          enrichedProfile,
        );
        doc.set('profile', enrichedProfile);
        if (overrides || doc.metadata?.manualOverrides) {
          // set() on the subpath: metadata is Mixed, so a plain assignment would not be saved
          doc.set('metadata.manualOverrides', overrides);
        }
      },
      `updateIdentityProfile(${id})`,
      this.logger,
    ).catch((err: unknown) => {
      throw uniqueValueConflict(err) ?? err;
    });

    if (!identity?.profile?.email) throw new NotFoundException(`Identity with ID ${id} not found`);

    // No email: a handler that needs the address reads it from the identity
    const changedFields = Object.keys(safeUpdates);
    this.eventEmitter.emit(
      DomainEventType.IDENTITY_UPDATED,
      id,
      {
        identityId: id,
        changedFields,
        source: actor || 'ui-editor',
        syncToEntra: options?.syncToEntra,
        ...(options?.moverRequested ? { moverRequested: true } : {}),
        previousAttributes,
      },
      { actor: actor || 'ui-editor' },
    );

    return {
      user: await this.identityQuery.findById(id),
      changedFields,
      previousAttributes: previousAttributes ?? {},
    };
  }

  /** The keys a national ID sits under for the tenant: its rule's field and `hetu`. */
  private async nationalIdKeysOf(tenantId: string): Promise<string[]> {
    return nationalIdKeys(await this.identityCorrelation.nationalIdRuleOf(tenantId));
  }

  /**
   * The national ID of an update (the tenant's Hashed National ID field and `hetu`), taken out as
   * correlation takes it out of an incoming record (IdentityCorrelationService
   * .takeHashedNationalId): removed from `update`, its hash set as `update.correlationId` when the
   * tenant has the rule and the secret is set, and under the rule a correlationId the update brings
   * is dropped. Only an update that can hold one reads the settings. Returns the keys removed.
   */
  private async takeNationalId(
    update: Record<string, unknown>,
    tenantId: string,
  ): Promise<string[]> {
    if (!mayCarryNationalId(update)) return [];
    const rule = await this.identityCorrelation.nationalIdRuleOf(tenantId);
    const hash = this.identityCorrelation.takeHashedNationalId(update, rule, tenantId);
    if (hash) update.correlationId = hash;
    return nationalIdKeys(rule);
  }

  /**
   * Refuses (409) an edit that changes a field an HR source masters (ReconciliationService
   * .hrOwnersOf): the next sync would set it back, and access would flap. The message names each
   * field's owner and the way out: change it in HR, or, for the department and the job title, set
   * an override (PATCH /identity/v2/:id/controls). A field with an active override is refused as
   * well: reconcile writes the override back. Fields EuroID keeps stay editable.
   */
  private async refuseHrMasteredEdits(identity: IdentityDocument, fields: string[]): Promise<void> {
    const owners = await this.reconciliationService.hrOwnersOf(identity, fields);
    const refused: RefusedField[] = [];
    const reasons = fields.flatMap((field) => {
      const controlled = (CONTROLLED_ATTRIBUTES as string[]).includes(field);
      if (owners[field]) {
        refused.push({ field, owner: owners[field] });
        const override = controlled ? ', or set an override' : '';
        return [`${field} is mastered by ${owners[field]}: change it in HR${override}.`];
      }
      if (controlled && controlValue(identity.controls, field as ContractAttribute) !== undefined) {
        refused.push({ field });
        return [`${field} has an override: change or remove the override instead.`];
      }
      return [];
    });
    if (refused.length > 0) throw new HrMasteredFieldsException(refused, reasons.join(' '));
  }
}
