import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { ClientSession } from 'mongoose';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { IdentityDocument } from './schemas/identity.schema';
import { CorrelationRuleEngine } from './correlation/correlation-rule.engine';
import type { CorrelationConfig } from './correlation/correlation-rule.interface';
import {
  classifyDeletedIdentityRow,
  DeletedIdentityRowIgnored,
  isAnotherEmployee,
} from './deleted-identity-rows';
import { maskEmail } from './identity-pii';
import { LeaverPolicy, type LeaverPolicyDocument } from '../leavers/schemas/leaver-policy.schema';
import {
  defaultLeaverPolicy,
  isValidTimeZone,
  type LeaverPolicySettings,
} from '../leavers/leaver-policy.defaults';

/**
 * Inbound records of soft-deleted identities (deleted-identity-rows.ts). Correlation looks for a
 * live identity first; a record that matches none may belong to a deleted one, by its source key
 * or a confident correlation rule match. Such a record never mints a second identity: only a
 * rehire revives the deleted one, every other record changes nothing (DeletedIdentityRowIgnored).
 * A match by email alone (the email rule, or a source key that is the email) is no match for a
 * record of another employee (isAnotherEmployee): a new hire may take a former employee's address.
 */
@Injectable()
export class IdentityDeletedMatchService {
  private readonly logger = this.loggerFactory.create(IdentityDeletedMatchService.name);

  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    @InjectModel(LeaverPolicy.name) private readonly policyModel: Model<LeaverPolicyDocument>,
    private readonly correlationEngine: CorrelationRuleEngine,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly loggerFactory: LoggerFactoryService,
  ) {}

  /**
   * The most recently deleted identity that holds this source record, unless the key is the
   * record's email (an HR row without an employee id) and the record is another employee's.
   */
  async findBySourceKey(
    record: StandardUserDto,
    sourceName: string,
    externalId: string,
    tenantId: string,
    session?: ClientSession,
  ): Promise<IdentityDocument | null> {
    let q = this.identityModel
      .findOne({
        tenantId,
        deletedAt: { $ne: null },
        sources: { $elemMatch: { sourceName, externalId } },
      })
      .sort({ deletedAt: -1 });
    if (session) q = q.session(session);
    const identity = await q.exec();
    const byEmail = externalId === record.email;
    return identity && byEmail && isAnotherEmployee(identity, record) ? null : identity;
  }

  /** The deleted identity the correlation rules match with confidence (no review needed). */
  async findByCorrelation(
    dto: StandardUserDto,
    tenantId: string,
    config: CorrelationConfig,
    session?: ClientSession,
  ): Promise<IdentityDocument | null> {
    const result = await this.correlationEngine.findCorrelatedIdentity(
      dto,
      tenantId,
      config,
      session,
      { deleted: true },
    );
    const threshold = config.confidenceThreshold ?? 0.7;
    if (!result.identity || result.confidence < threshold || result.reviewRequired) return null;
    return result.matchedBy === 'email' && isAnotherEmployee(result.identity, dto)
      ? null
      : result.identity;
  }

  /**
   * Returns when `dto` is a rehire of the deleted `identity`; otherwise throws
   * DeletedIdentityRowIgnored, after logging an active record that is not a rehire (email masked).
   */
  async admit(identity: IdentityDocument, dto: StandardUserDto, sourceName: string): Promise<void> {
    const deletedAt = identity.deletedAt as Date;
    const policy = await this.leaverPolicy(identity.tenantId);
    const row = classifyDeletedIdentityRow(dto, deletedAt, policy, new Date());
    if (row === 'rehire') return;
    const id = String(identity._id);
    if (row === 'not-rehire') {
      this.logger.warn(
        `[Hub] Active ${sourceName} record of deleted identity ${id} (${maskEmail(dto.email)}) ` +
          `ignored: its start date is not after the deletion, so it is not a rehire`,
      );
    } else {
      this.logger.debug(`[Hub] Ended ${sourceName} record of deleted identity ${id}: no change`);
    }
    throw new DeletedIdentityRowIgnored(id, row);
  }

  /**
   * Revive a rehired identity in memory (the caller saves it): no longer deleted, and without the
   * kill switch and access baseline its offboarding left, so the HR status applies again and the
   * joiner path records a new baseline at its first provisioning. It is marked as rehired by
   * `sourceName` now (metadata.rehiredAt, rehiredFrom), so HR joiner detection onboards it as a
   * joiner. Its earlier employment's targets hold nothing for the new hire: each provisioning
   * entry is closed (DEPROVISIONED, also a target that keeps no account, which offboarding left
   * SYNCED) and its writeback undone, so neither joiner detection nor onboarding takes it as
   * onboarded, and onboarding writes the new accounts back. It takes the record's email before it
   * is live again: its old address may belong to a new hire now (reconciliation then decides).
   * The caller never revives it with an email a live identity has (the email is unique among live
   * identities): IdentityCorrelationService holds such a record on that identity's conflict.
   */
  revive(identity: IdentityDocument, sourceName: string, email?: string): void {
    if (email) identity.set('profile.email', email);
    identity.deletedAt = undefined;
    identity.deletedBy = undefined;
    identity.accessBaseline = undefined;
    if (identity.controls?.isLoginDisabled) identity.set('controls.isLoginDisabled', false);
    // set() on the subpaths: metadata is Mixed, so a plain assignment would not be saved
    identity.set('metadata.rehiredAt', new Date());
    identity.set('metadata.rehiredFrom', sourceName);
    for (const entry of identity.provisioning ?? []) {
      if (entry.status !== 'DEPROVISIONED') {
        entry.status = 'DEPROVISIONED';
        entry.provisionedAt = null;
      }
      entry.writebackComplete = false;
    }
  }

  /** Audit a saved revival: a status change from deleted to the status reconciliation gave it. */
  recordRehire(identity: IdentityDocument, sourceName: string, tenantId: string): void {
    const id = String(identity._id);
    const newStatus = String(identity.profile?.status ?? UserStatus.ACTIVE);
    this.logger.log(`[Hub] Rehire: deleted identity ${id} revived from ${sourceName}`);
    this.eventEmitter.emit(
      DomainEventType.IDENTITY_STATUS_CHANGED,
      id,
      {
        identityId: id,
        previousStatus: UserStatus.DELETED,
        newStatus,
        reason: `rehire (${sourceName}: start date after the deletion)`,
      },
      { tenantId, actor: sourceName },
    );
  }

  /** The tenant's leaver policy as leaver detection reads it (defaults without a stored one). */
  private async leaverPolicy(tenantId: string): Promise<LeaverPolicySettings> {
    const defaults = defaultLeaverPolicy();
    const stored = await this.policyModel.findOne({ tenantId }).lean().exec();
    if (!stored) return defaults;
    return {
      ...defaults,
      signals: { ...stored.signals },
      terminatedStatuses: [...stored.terminatedStatuses],
      timezone: isValidTimeZone(stored.timezone) ? stored.timezone : 'UTC',
    };
  }
}
