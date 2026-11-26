import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as mongoose from 'mongoose';
import type { ClientSession } from 'mongoose';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { IdentityDocument, LinkedAccount, IdentityControls } from './schemas/identity.schema';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { CorrelationRuleEngine } from './correlation/correlation-rule.engine';
import type { CorrelationConfig } from './correlation/correlation-rule.interface';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { toSourceName } from '@shared/utils/source-name';
import { normalizeEmail } from '@shared/utils/email';
import { emailCaseConflictFilter } from './identity-email-case-conflict';
import { IdentityOnionService } from './identity-onion.service';
import { IdentityDeletedMatchService } from './identity-deleted-match.service';
import {
  flagCorrelationConflict,
  RowHeldForConflictReview,
  type IncomingRecord,
} from './conflict-held-rows';
import { assertRoomForNewIdentity, reportIdentityLimitOvershoot } from './identity-limit';
import { droppedFields, type DroppedFields } from './dropped-fields';
import { DEFAULT_TENANT, MAX_SOURCES, SOURCES_WARNING_THRESHOLD } from './identity.constants';
import { maskEmails } from '../../activities/deprovision-failure';
import {
  deduplicateAndValidateSources,
  ensureTenantId,
  dtoToProfile,
  sourceEntryIndex,
} from './identity-helpers';
import { nationalIdRule, takeNationalId } from './national-id';
import type { CorrelationRule } from '@shared/types/correlation-config';
import {
  conflictFlagsOf,
  hubStateOf,
  type HubBeforeConflictFlag,
  type HubBeforeWrite,
} from './identity-hub-state';

/** Options of ensureIdentityFromUser. */
export interface EnsureIdentityOptions {
  /**
   * The record's national ID hash, computed by EuroID before the record reached this call: bulk
   * provisioning hashes it when the batch starts and removes the value, so its workflow input holds
   * none (BulkProvisioningService). Used only for a tenant with the rule, and only when the record
   * carries no national ID of its own.
   */
  nationalIdHash?: string;
}

/**
 * Correlation engine: ensureIdentityFromUser, source push, config loading. Controls:
 * IdentityControlsService.
 */
@Injectable()
export class IdentityCorrelationService {
  private readonly logger = this.loggerFactory.create(IdentityCorrelationService.name);

  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly reconciliationService: ReconciliationService,
    private readonly reconConfigService: ReconciliationConfigService,
    private readonly correlationConfigService: CorrelationConfigService,
    private readonly correlationEngine: CorrelationRuleEngine,
    private readonly correlationHashService: CorrelationHashService,
    private readonly loggerFactory: LoggerFactoryService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly identityOnion: IdentityOnionService,
    private readonly deletedMatch: IdentityDeletedMatchService,
  ) {}

  /**
   * Load correlation config from active blueprint's euroid-core connector config.
   * Default: email-only rule for backward compatibility. `strict` (a caller that stores a
   * reconciled profile): settings that cannot be read throw CorrelationConfigUnavailableError
   * instead of falling back to defaults without the field mastery overrides.
   */
  async getCorrelationConfig(
    tenantId: string,
    options: { strict?: boolean } = {},
  ): Promise<CorrelationConfig> {
    return this.correlationConfigService.getCorrelationConfig(tenantId, options);
  }

  /**
   * Resolve sourceRole. Whether the source is HR: the tenant's reconciliation config decides when
   * it names HR sources (hrSourceTags); otherwise the source's connector does (an HR connector,
   * CorrelationConfigService.isHrSourceName). An HR source is primary-hr unless another connector
   * is the configured primary (connector config hrRole / contractTag); any other source is a target.
   */
  private async getSourceRoleForSource(
    sourceName: string,
  ): Promise<'primary-hr' | 'secondary-hr' | 'target'> {
    const tenantId = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const hrSourceTags = await this.reconConfigService.getHrSourceTags(tenantId);
    const lower = sourceName.toLowerCase();
    const isHr =
      hrSourceTags.length > 0
        ? hrSourceTags.some((h) => lower.includes(h))
        : await this.correlationConfigService.isHrSourceName(sourceName);
    if (!isHr) return 'target';
    const primaryHr = await this.correlationConfigService.getPrimaryHrSourceName(hrSourceTags);
    if (primaryHr && lower.includes(primaryHr.toLowerCase())) return 'primary-hr';
    if (primaryHr) return 'secondary-hr';
    return 'primary-hr';
  }

  /**
   * Whether records from `sourceSystem` (as a client names it) count as an HR source's for the
   * current tenant (getSourceRoleForSource): POST /identity refuses to write as one.
   */
  async isHrSource(sourceSystem: string): Promise<boolean> {
    return (await this.getSourceRoleForSource(toSourceName(sourceSystem))) !== 'target';
  }

  /**
   * Ensure an Onion Identity exists for this user (create or update source + reconcile).
   * First the record's national ID is hashed and removed from it (takeNationalId).
   * Lookup chain: 1) source-key, 2) correlation rules, 3) mint new. A record no live identity
   * matches may belong to a soft-deleted one (its source key, else a confident correlation match):
   * it then never mints; only a rehire revives that identity, any other record throws
   * DeletedIdentityRowIgnored and writes nothing (IdentityDeletedMatchService). A rehire whose
   * email a live identity (a new hire) now has is not revived: it is held on that identity's
   * conflict and RowHeldForConflictReview thrown, as below.
   * A low-confidence match flags the matched identity and mints one for the record, unless a live
   * identity already has the record's email: the record is then held on the conflict and
   * RowHeldForConflictReview thrown (conflict-held-rows.ts). A record no rule matches whose email
   * a live identity has is held on that identity's conflict the same way, instead of minting.
   * `beforeWrite` gets the state of the identity this call writes (null: it mints one) before
   * the first write. `beforeConflictFlag` gets the conflict flags of the other identity a
   * low-confidence match flags, before they are set (a new identity is minted after that).
   * `options.nationalIdHash`: see EnsureIdentityOptions.
   */
  async ensureIdentityFromUser(
    dto: StandardUserDto,
    session?: ClientSession,
    beforeWrite?: HubBeforeWrite,
    beforeConflictFlag?: HubBeforeConflictFlag,
    options: EnsureIdentityOptions = {},
  ): Promise<IdentityDocument | null> {
    // Every path into the Hub stores the email in one form (shared/utils/email.ts): activities
    // (bulk provisioning, onboarding, SCIM) reach here without the DTO's Zod normalization
    if (typeof dto.email === 'string') dto.email = normalizeEmail(dto.email);
    const email = dto.email;
    const sourceName = toSourceName(dto.sourceSystem);
    const externalId = dto.sourceUserId || dto.email;
    // The tenant context (HTTP request or activity) decides the tenant. dto.tenantId is used
    // only without a context; one that disagrees with the context is ignored and overwritten,
    // so profile and rawData cannot carry another tenant's id either.
    const contextTenantId = requestContext.getStore()?.tenantId;
    if (contextTenantId && dto.tenantId && dto.tenantId !== contextTenantId) {
      this.logger.warn(
        `Ignoring payload tenantId ${JSON.stringify(dto.tenantId)}: the request tenant decides`,
      );
    }
    const tid = contextTenantId || dto.tenantId || DEFAULT_TENANT;
    dto.tenantId = tid;
    // Strict: the settings name the national ID field to remove; without them nothing is stored
    const correlationConfig = await this.correlationConfigService.getCorrelationConfig(tid, {
      strict: true,
    });
    const rule = nationalIdRule(correlationConfig);
    const nationalIdHash =
      this.takeHashedNationalId(dto as unknown as Record<string, unknown>, rule, tid) ??
      (rule ? (options.nationalIdHash ?? null) : null);
    const rawData = { ...dto } as unknown as Record<string, unknown>;
    if (nationalIdHash) dto.correlationId = nationalIdHash;

    const hrPriorityConfig =
      (await this.correlationConfigService.getHrPriorityFromBlueprint(sourceName)) ??
      (await this.correlationConfigService.getHrPriorityConfig(sourceName));
    const contractType =
      hrPriorityConfig?.contractTag === 'SECONDARY'
        ? 'secondary'
        : hrPriorityConfig?.contractTag === 'PRIMARY'
          ? 'primary'
          : dto.contractType;
    const sourceRole = await this.getSourceRoleForSource(sourceName);
    const incoming = { dto, sourceName, externalId, rawData, contractType, sourceRole };
    const conflictDeps = { eventEmitter: this.eventEmitter, tenantId: tid, session };

    let identity = await this.identityOnion.findIdentityBySourceKey(sourceName, externalId, tid, {
      session,
    });
    if (identity) await beforeWrite?.(hubStateOf(identity));
    let deleted = identity
      ? null
      : await this.deletedMatch.findBySourceKey(dto, sourceName, externalId, tid, session);
    let correlationResult: Awaited<
      ReturnType<CorrelationRuleEngine['findCorrelatedIdentity']>
    > | null = null;
    /** A low-confidence match flagged a new conflict, whose minted identity the mint names. */
    let conflictFlagged = false;

    if (!identity && !deleted) {
      correlationResult = await this.correlationEngine.findCorrelatedIdentity(
        dto,
        tid,
        correlationConfig,
        session,
      );
      const result = correlationResult;
      const threshold = correlationConfig.confidenceThreshold ?? 0.7;

      if (result.identity && result.confidence >= threshold && !result.reviewRequired) {
        identity = result.identity;
        await beforeWrite?.(hubStateOf(identity));
        identity.metadata = identity.metadata || {};
        identity.metadata.correlationStatus = 'correlated';
        await identity.save(session ? { session } : {});
        this.logger.log(`Correlation match: ${result.matchedBy} → Identity ${identity._id}`);
        this.eventEmitter.emit(
          DomainEventType.IDENTITY_CORRELATED,
          identity._id?.toString() ?? '',
          {
            correlationRule: result.matchedBy,
            matchedBy: result.matchedBy,
            confidence: result.confidence,
            existingIdentityId: identity._id?.toString(),
            incomingSourceSystem: sourceName,
          },
          {},
        );
      } else if (result.identity && (result.confidence < threshold || result.reviewRequired)) {
        this.logger.warn(
          `Low-confidence correlation: ${result.matchedBy}, confidence=${result.confidence}, reviewRequired=${result.reviewRequired}`,
        );
        await beforeConflictFlag?.(conflictFlagsOf(result.identity));
        // The email is unique among the tenant's live identities: a record whose email a live
        // identity has gets no identity of its own and waits on the conflict for a Merge
        const held = (await this.liveIdentityWithEmail(email, tid, session)) !== null;
        const outcome = await flagCorrelationConflict(
          result.identity,
          incoming,
          result,
          held,
          conflictDeps,
        );
        if (held) throw new RowHeldForConflictReview(String(result.identity._id));
        conflictFlagged = outcome === 'flagged';
      } else if (!result.identity && !result.ambiguousCandidates?.length) {
        deleted = await this.deletedMatch.findByCorrelation(dto, tid, correlationConfig, session);
      }
    }

    if (!identity && !deleted && !correlationResult?.identity) {
      // No rule matched (or several did), yet a live identity has the record's email: minting
      // would fail on the unique email at every sync. The record is held on that identity's
      // conflict, as a low-confidence match whose email is taken is.
      await this.holdIfEmailTaken(incoming, conflictDeps, beforeConflictFlag);
    }

    if (deleted) {
      await this.deletedMatch.admit(deleted, dto, sourceName); // throws unless a rehire
      // The rehire takes the record's email, which a new hire may have now: reviving would fail
      // on the unique email at every sync, so the record is held on the new hire's conflict
      await this.holdIfEmailTaken(incoming, conflictDeps, beforeConflictFlag);
      await beforeWrite?.(hubStateOf(deleted));
      this.deletedMatch.revive(deleted, sourceName, dto.email);
      identity = deleted;
    }

    /** What this source no longer carries since its previous record (cleared if it owns it). */
    let dropped: DroppedFields | undefined;
    if (!identity) {
      // A new identity: only within the tenant's limit (identity-limit.ts), before any write
      await assertRoomForNewIdentity(this.identityModel, tid, session);
      await beforeWrite?.(null);
      identity = await this.mintNewIdentity(
        dto,
        sourceName,
        externalId,
        tid,
        rawData,
        contractType,
        sourceRole,
        hrPriorityConfig,
        correlationResult,
        conflictFlagged,
        session,
      );
      // Creates running at once can pass the limit: one alert per overshoot (identity-limit.ts)
      await reportIdentityLimitOvershoot(this.identityModel, this.eventEmitter, tid, session).catch(
        (err: unknown) => this.logger.warn(`Identity limit check of ${tid} failed: ${String(err)}`),
      );
    } else {
      ensureTenantId(identity, tid);
      identity.metadata = identity.metadata || {};
      identity.metadata.correlationStatus = 'correlated';
      const sources: LinkedAccount[] = identity.sources || [];
      const tidInner = identity.tenantId || DEFAULT_TENANT;
      const entry: LinkedAccount = {
        sourceName,
        externalId,
        lastSync: new Date(),
        rawData,
        contractType,
        sourceRole,
        tenantId: tidInner,
      } as LinkedAccount;
      const idx = sourceEntryIndex(sources, sourceName, externalId);
      if (idx >= 0) {
        dropped = { sourceName, fields: droppedFields(sources[idx].rawData, rawData) };
        sources[idx] = entry;
      } else {
        sources.push(entry);
      }
      identity.sources = deduplicateAndValidateSources(sources);
      const dtoAny = dto as unknown as Record<string, unknown>;
      const profileAny = identity.profile as unknown as Record<string, unknown>;
      if (dtoAny.correlationId && !profileAny?.correlationId) {
        profileAny.correlationId = dtoAny.correlationId;
      }
      await identity.save(session ? { session } : {});
    }

    if (hrPriorityConfig?.masteryFields?.length) {
      identity.metadata = identity.metadata || {};
      identity.metadata.mastery = identity.metadata.mastery || {};
      for (const field of hrPriorityConfig.masteryFields) {
        identity.metadata.mastery[field] = sourceName;
      }
      await identity.save(session ? { session } : {});
    }

    const reconciled = await this.reconciliationService.reconcile(
      identity,
      {
        fieldMasteryOverrides: correlationConfig.fieldMasteryOverrides,
        ...(dropped?.fields.length ? { dropped } : {}),
      },
      session,
    );
    if (deleted) this.deletedMatch.recordRehire(reconciled, sourceName, tid);
    return reconciled;
  }

  /**
   * The national ID of a record (national-id.ts takeNationalId): its hash when the tenant has a
   * hashedNationalId rule, the value is there and CORRELATION_HMAC_SECRET is set, else null. The
   * value (the rule's field and `hetu`) is removed from `record` in any case, before rawData, the
   * profile or a held conflict row can take it; without the secret it is dropped unhashed. With
   * the rule, a correlationId the record brings is removed too: the rule matches only on the hash
   * computed here. The caller sets the hash on the record after taking rawData from it. An update
   * of a stored identity uses it too (IdentityMutationService).
   */
  takeHashedNationalId(
    record: Record<string, unknown>,
    rule: CorrelationRule | undefined,
    tenantId: string,
  ): string | null {
    return takeNationalId(record, rule, (value) =>
      this.correlationHashService.hash(value, tenantId),
    );
  }

  /**
   * The tenant's hashedNationalId rule. Read strictly: settings that cannot be read throw
   * CorrelationConfigUnavailableError, since they name the national ID field to remove.
   */
  async nationalIdRuleOf(tenantId: string): Promise<CorrelationRule | undefined> {
    const config = await this.correlationConfigService.getCorrelationConfig(tenantId, {
      strict: true,
    });
    return nationalIdRule(config);
  }

  /**
   * When a live identity has the record's email, hold the record on that identity's conflict
   * (`matchedBy: 'email'`, confidence 0, the record in `incomingSource`) and throw
   * RowHeldForConflictReview. The email is unique among live identities, so the record could be
   * neither minted nor given to a revived identity. Returns when no live identity has it.
   */
  private async holdIfEmailTaken(
    incoming: IncomingRecord,
    deps: { eventEmitter: DomainEventEmitterService; tenantId: string; session?: ClientSession },
    beforeConflictFlag?: HubBeforeConflictFlag,
  ): Promise<void> {
    const holder = await this.liveIdentityWithEmail(
      incoming.dto.email,
      deps.tenantId,
      deps.session,
    );
    if (!holder) return;
    await beforeConflictFlag?.(conflictFlagsOf(holder));
    const match = { matchedBy: 'email', confidence: 0 };
    await flagCorrelationConflict(holder, incoming, match, true, deps);
    throw new RowHeldForConflictReview(String(holder._id));
  }

  /**
   * The live (not soft-deleted) identity of the tenant that has this email, else one with an open
   * email conflict naming it in another case: a pair stored before the email was lower-cased,
   * which the email migration raised for a merge (identity-email-case-conflict.ts).
   */
  private async liveIdentityWithEmail(
    email: string | undefined,
    tid: string,
    session?: ClientSession,
  ): Promise<IdentityDocument | null> {
    if (!email) return null;
    const find = (filter: Record<string, unknown>) => {
      const query = this.identityModel.findOne(filter);
      return (session ? query.session(session) : query).exec();
    };
    return (
      (await find({ tenantId: tid, 'profile.email': normalizeEmail(email), deletedAt: null })) ??
      (await find(emailCaseConflictFilter(tid, email)))
    );
  }

  /** Mint a brand new Identity document. */
  private async mintNewIdentity(
    dto: StandardUserDto,
    sourceName: string,
    externalId: string,
    tid: string,
    rawData: Record<string, unknown>,
    contractType: string | undefined,
    sourceRole: string,
    hrPriorityConfig: {
      ingestPriority?: number;
      masteryFields?: string[];
      contractTag?: string;
    } | null,
    correlationResult: Awaited<ReturnType<CorrelationRuleEngine['findCorrelatedIdentity']>> | null,
    conflictFlagged: boolean,
    session?: ClientSession,
  ): Promise<IdentityDocument> {
    const profile = dtoToProfile(dto);
    const dtoAny = dto as unknown as Record<string, unknown>;
    if (dtoAny.correlationId) {
      (profile as Record<string, unknown>).correlationId = dtoAny.correlationId;
    }
    const metadata: {
      version: number;
      mastery?: Record<string, string>;
      correlationStatus?: 'uncorrelated' | 'ambiguous';
      ambiguousCandidates?: string[];
    } = { version: 0 };
    if (hrPriorityConfig?.masteryFields?.length) {
      metadata.mastery = {};
      for (const field of hrPriorityConfig.masteryFields) {
        metadata.mastery[field] = sourceName;
      }
    }
    if (correlationResult?.ambiguousCandidates?.length) {
      metadata.correlationStatus = 'ambiguous';
      metadata.ambiguousCandidates = correlationResult.ambiguousCandidates;
    } else {
      metadata.correlationStatus = 'uncorrelated';
    }
    const identity = new this.identityModel({
      tenantId: tid,
      profile,
      sources: [
        {
          sourceName,
          externalId,
          lastSync: new Date(),
          rawData,
          contractType,
          sourceRole,
          tenantId: tid,
        } as LinkedAccount,
      ],
      controls: { isLoginDisabled: false } as IdentityControls,
      provisioning: [],
      metadata,
    }) as IdentityDocument;
    await identity.save(session ? { session } : {});
    this.logger.log(`Minted new Identity ${identity._id}`);
    // Only the conflict this record just opened: an open one about another record keeps its own
    if (conflictFlagged && correlationResult?.identity?.metadata?.conflictDetails) {
      correlationResult.identity.metadata.conflictDetails.incomingIdentityId =
        identity._id?.toString();
      correlationResult.identity.markModified('metadata'); // Mixed path, see the flagging
      await correlationResult.identity.save(session ? { session } : {});
    }
    return identity;
  }

  /**
   * Push source data from a connector and run reconciliation.
   *
   * `options.writeback`: the source is the target account a provisioning run just created
   * (onboarding's write-back). Its identity.sources_changed then carries depth 1, so no handler
   * starts provisioning for it: SourcesChangedHandler would start another onboarding run for
   * the person, which during an all-users run delivered every target a second time.
   */
  async pushSourceAndReconcile(
    identityIdOrEmailOrSourceKey: string,
    sourceName: string,
    externalId: string,
    rawData: Record<string, unknown>,
    options?: {
      contractType?: 'primary' | 'secondary';
      sourceRole?: 'primary-hr' | 'secondary-hr' | 'target';
      writeback?: boolean;
    },
  ): Promise<IdentityDocument | null> {
    const tenantId = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    let identity: IdentityDocument | null = null;

    if (mongoose.isValidObjectId(identityIdOrEmailOrSourceKey)) {
      identity = await this.identityOnion.findIdentityById(identityIdOrEmailOrSourceKey);
    }
    if (!identity) {
      identity = await this.identityOnion.findIdentityBySourceKey(sourceName, externalId, tenantId);
    }
    if (!identity && identityIdOrEmailOrSourceKey.includes('@')) {
      identity = await this.identityOnion.findIdentityByEmail(identityIdOrEmailOrSourceKey);
    }

    if (!identity) {
      this.logger.warn(
        `No Identity found for ${maskEmails(identityIdOrEmailOrSourceKey)}, cannot push source`,
      );
      return null;
    }

    const contractType =
      options?.contractType ?? (rawData?.contractType as 'primary' | 'secondary' | undefined);
    const sourceRole = options?.sourceRole ?? (await this.getSourceRoleForSource(sourceName));
    // Before any write, and strictly: defaults would reconcile without the mastery overrides
    const correlationConfig = await this.getCorrelationConfig(identity.tenantId, { strict: true });

    ensureTenantId(identity, tenantId);
    const sources: LinkedAccount[] = identity.sources || [];
    const existingIndex = sourceEntryIndex(sources, sourceName, externalId);
    const existing = existingIndex >= 0 ? sources[existingIndex] : undefined;
    const newEntry: LinkedAccount = {
      sourceName,
      externalId,
      lastSync: new Date(),
      rawData: rawData || {},
      contractType,
      sourceRole,
      tenantId: identity.tenantId,
    } as LinkedAccount;
    const updatedSources = existing
      ? sources.map((s, i) => (i === existingIndex ? newEntry : s))
      : [...sources, newEntry];
    const sourceCountBefore = sources.length;
    const isNewSource = !existing;
    identity.sources = deduplicateAndValidateSources(updatedSources);
    await identity.save();

    const reconciled = await this.reconciliationService.reconcile(identity, {
      fieldMasteryOverrides: correlationConfig.fieldMasteryOverrides,
    });

    if (isNewSource && sourceCountBefore < identity.sources.length) {
      const resolvedTenantId =
        identity.tenantId || requestContext.getStore()?.tenantId || DEFAULT_TENANT;
      this.eventEmitter.emit(
        DomainEventType.IDENTITY_SOURCES_CHANGED,
        identity._id?.toString() ?? '',
        {
          identityId: identity._id?.toString(),
          newSourceName: sourceName,
          totalSourceCount: identity.sources.length,
          contractType: contractType ?? 'primary',
        },
        { tenantId: resolvedTenantId, depth: options?.writeback ? 1 : 0 },
      );

      if (identity.sources.length >= SOURCES_WARNING_THRESHOLD) {
        this.eventEmitter.emit(
          DomainEventType.IDENTITY_SOURCES_APPROACHING_LIMIT,
          identity._id?.toString() ?? '',
          {
            identityId: identity._id?.toString(),
            currentCount: identity.sources.length,
            maxAllowed: MAX_SOURCES,
          },
          { tenantId: resolvedTenantId },
        );
      }
    }

    return reconciled;
  }
}
