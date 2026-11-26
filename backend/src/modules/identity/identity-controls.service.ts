import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { IdentityDocument } from './schemas/identity.schema';
import { ReconciliationService } from './reconciliation.service';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { AuditService } from '../audit/audit.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { changedAccessAttributes } from '@shared/utils/access-baseline';
import { DEFAULT_TENANT, NOT_DELETED } from './identity.constants';
import { ensureTenantId, saveWithRetry } from './identity-helpers';
import type { UpdateIdentityControls } from './dtos/update-identity-controls.dto';
import { EMAIL_TAKEN, uniqueValueConflict } from './identity-write-errors';
import {
  attributeControlAuditEntry,
  emailOverrideAuditEntry,
  loginSwitchAuditEntry,
} from './identity-controls-audit';
import {
  CONTROL_EXPIRY_PATHS,
  CONTROLLED_ATTRIBUTES,
  activeAttributeControls,
  attributeControlChanges,
  controlPaths,
  expiredControlChanges,
  type AttributeControlChange,
} from './attribute-controls';

/** Actor of the controls the expiry sweep ends (audit log, timeline, mover run). */
export const CONTROL_EXPIRY_ACTOR = 'system:control-expiry';

/**
 * Identity controls (Layer 3 of the onion, PATCH /identity/v2/:id/controls): the kill switch
 * (isLoginDisabled), the email override and the attribute controls (manualDepartment,
 * manualJobTitle; attribute-controls.ts), the one override of an HR-mastered department or job
 * title. Every change reconciles the profile. An attribute control needs a reason, may expire,
 * and each set, removal and expiry is audited. A change of the profile's department or job title
 * emits identity.updated with the value it replaced, which starts the mover run (or onboarding)
 * an edit starts: the mover moves from the access baseline, as for an HR change. The hourly
 * expiry sweep (EntitlementExpiryActivities) ends the controls whose expiry has passed.
 */
@Injectable()
export class IdentityControlsService {
  private readonly logger = this.loggerFactory.create(IdentityControlsService.name);

  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly reconciliationService: ReconciliationService,
    private readonly correlationConfigService: CorrelationConfigService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly auditService: AuditService,
    private readonly loggerFactory: LoggerFactoryService,
  ) {}

  /**
   * Apply a controls update (validated by UpdateIdentityControlsSchema) and reconcile. An email
   * override another live identity has is refused (409) before anything is written; the kill
   * switch and the email override are audited when they change.
   */
  async updateControls(
    identityId: string,
    update: UpdateIdentityControls,
    actor?: string,
  ): Promise<IdentityDocument | null> {
    const overrideEmail = update.overrides?.email || undefined;
    if (overrideEmail) await this.refuseTakenEmail(identityId, overrideEmail);
    let switchChanged = false;
    let overrideBefore: string | undefined;
    const identity = await this.change(identityId, actor, (doc, now) => {
      if (update.isLoginDisabled !== undefined) {
        switchChanged = (doc.controls?.isLoginDisabled === true) !== update.isLoginDisabled;
        doc.set('controls.isLoginDisabled', update.isLoginDisabled);
      }
      if (update.overrides !== undefined) {
        overrideBefore = doc.controls?.overrides?.email || undefined;
        doc.set('controls.overrides', overrideEmail ? { email: overrideEmail } : {});
      }
      return attributeControlChanges(doc.controls, update, actor, now);
    });
    if (!identity) return null;
    if (switchChanged) {
      const disabled = update.isLoginDisabled === true;
      await this.auditService.log(loginSwitchAuditEntry(identity, disabled, actor));
    }
    if (update.overrides !== undefined && overrideBefore !== overrideEmail) {
      await this.auditService.log(
        emailOverrideAuditEntry(identity, overrideBefore, overrideEmail, actor),
      );
    }
    return identity;
  }

  /** 409 when another live identity of the tenant has `email` (the unique email index). */
  private async refuseTakenEmail(identityId: string, email: string): Promise<void> {
    const tenantId = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const holder = await this.identityModel
      .exists({ tenantId, 'profile.email': email, _id: { $ne: identityId }, ...NOT_DELETED })
      .exec();
    if (holder) throw new ConflictException(EMAIL_TAKEN);
  }

  /**
   * End the attribute controls whose expiry is at or before `now`, in up to `limit` identities of
   * the tenant (the caller's tenant context): each is removed, the profile reconciled back to the
   * HR value, the end audited, and identity.updated starts the mover. Returns the identities
   * processed. One that fails is logged and left for the next sweep.
   */
  async endExpiredControls(tenantId: string, now: Date, limit: number): Promise<number> {
    const due = await this.identityModel
      .find({
        tenantId,
        ...NOT_DELETED,
        $or: CONTROL_EXPIRY_PATHS.map((path) => ({ [path]: { $lte: now } })),
      })
      .select('_id')
      .limit(limit)
      .lean()
      .exec();
    let ended = 0;
    for (const { _id } of due) {
      const id = String(_id);
      try {
        // Expired as of `now` when saved: a control renewed meanwhile stays
        const identity = await this.change(id, CONTROL_EXPIRY_ACTOR, (doc) =>
          expiredControlChanges(doc.controls, now),
        );
        if (identity) ended += 1;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[Controls] Could not end the expired controls of ${id}: ${message}`);
      }
    }
    return ended;
  }

  /**
   * For the identity page: the profile fields an HR source masters (field -> source; a manual
   * edit of them is refused) and the active attribute controls. Null when there is no identity.
   */
  async getMastery(identityId: string): Promise<{
    identityId: string;
    masteredBy: Record<string, string>;
    attributeControls: ReturnType<typeof activeAttributeControls>;
  } | null> {
    const tenantId = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const identity = await this.identityModel
      .findOne({ _id: identityId, tenantId, ...NOT_DELETED })
      .exec();
    if (!identity) return null;
    return {
      identityId,
      masteredBy: await this.reconciliationService.hrOwnersOf(identity),
      attributeControls: activeAttributeControls(identity.toObject().controls),
    };
  }

  /**
   * Change an identity's controls (`apply` sets the other controls on the document and returns
   * its attribute control changes), reconcile, audit each attribute control change, and emit
   * identity.updated when the profile's department or job title changed.
   */
  private async change(
    identityId: string,
    actor: string | undefined,
    apply: (doc: IdentityDocument, now: Date) => AttributeControlChange[],
  ): Promise<IdentityDocument | null> {
    const fallbackTenantId = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const now = new Date();
    let before: Record<string, unknown> = {};
    let changes: AttributeControlChange[] = [];
    // Strictly, before any write: defaults would reconcile without the field mastery overrides
    const { fieldMasteryOverrides } = await this.correlationConfigService.getCorrelationConfig(
      fallbackTenantId,
      { strict: true },
    );
    // The controls and the profile they reconcile to are one save: a profile refused by a unique
    // index (an email override another identity took meanwhile) leaves the controls unchanged too
    const reconciled = await saveWithRetry<IdentityDocument>(
      () => this.identityModel.findById(identityId).exec() as Promise<IdentityDocument | null>,
      (doc) => {
        ensureTenantId(doc, fallbackTenantId);
        before = { departmentName: doc.profile?.departmentName, jobTitle: doc.profile?.jobTitle };
        changes = apply(doc, now);
        for (const change of changes) {
          for (const [path, value] of Object.entries(controlPaths(change))) {
            doc.set(`controls.${path}`, value);
          }
        }
      },
      `updateControls(${identityId})`,
      this.logger,
      undefined,
      (doc) => this.reconciliationService.reconcile(doc, { fieldMasteryOverrides }),
    ).catch((err: unknown) => {
      throw uniqueValueConflict(err) ?? err;
    });
    if (!reconciled) return null;
    for (const change of changes) {
      await this.auditService.log(attributeControlAuditEntry(reconciled, change, actor));
    }
    this.emitProfileChange(reconciled, before, actor);
    return reconciled;
  }

  /**
   * identity.updated for a department or job title the controls changed in the profile, with the
   * value it replaced (previousAttributes): the mover run (or onboarding) an edit starts.
   */
  private emitProfileChange(
    identity: IdentityDocument,
    before: Record<string, unknown>,
    actor: string | undefined,
  ): void {
    const after = {
      departmentName: identity.profile?.departmentName,
      jobTitle: identity.profile?.jobTitle,
    };
    const previousAttributes = changedAccessAttributes(before, after, CONTROLLED_ATTRIBUTES);
    const changedFields = CONTROLLED_ATTRIBUTES.filter((field) => field in previousAttributes);
    if (changedFields.length === 0) return;
    const identityId = String(identity._id);
    const source = actor || 'identity-controls';
    this.eventEmitter.emit(
      DomainEventType.IDENTITY_UPDATED,
      identityId,
      { identityId, changedFields, source, previousAttributes },
      { actor: source, tenantId: identity.tenantId },
    );
  }
}
