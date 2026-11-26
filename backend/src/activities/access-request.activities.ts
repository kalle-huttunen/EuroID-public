import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AccessRequest,
  AccessRequestDocument,
  stepRole,
} from '../modules/access-requests/schemas/access-request.schema';
import { EntitlementCatalogService } from '../modules/entitlement-catalog/entitlement-catalog.service';
import { EntraEntitlementChanges } from './entra-entitlement-changes';
import { ProvisioningIntent } from '@shared/interfaces/provisioning.interface';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import { getSystemType } from '@shared/utils/normalize-system-name';
import { EmailNotificationService } from '../modules/notifications/email-notification.service';
import { describeError } from '../modules/notifications/email-log';
import { AccessRequestSodService } from '../modules/access-requests/access-request-sod.service';
import {
  AccessRequestClosureService,
  CLOSE_REASONS,
} from '../modules/access-requests/access-request-closure.service';
import { toOperationType } from '@shared/utils/entitlement-operation-type';

type RequestOperationType = ProvisioningIntent['operations'][number]['type'];
type RequestEntitlement = AccessRequestDocument['entitlements'][number];

/** Why fulfilment failed or a removal waits (`statusReason`, shown on the request page). */
const FULFILMENT_REASONS = {
  noAccount:
    'No Entra ID account is recorded for this person, and no single account has their UPN, ' +
    'email or employee id. An access request adds access to an existing account; the account ' +
    'is created by onboarding, or an admin links it to the person.',
  accountGone:
    'Entra ID no longer has the account recorded for this person. Check the account in Entra ID.',
  refused: (reason: string) => `Entra ID refused the access: ${reason}`,
  unsupported: (systems: string) =>
    `Access requests can grant Entra ID entitlements only; this request names ${systems}.`,
  revokeRefused: (reason: string) =>
    `Entra ID refused to remove the access: ${reason} The request stays ACTIVE and the removal ` +
    'is tried again; remove the access in Entra ID, or fix the cause, and it ends EXPIRED.',
  revokeRetrying: (reason: string) =>
    `Removing the access from Entra ID failed and is being tried again: ${reason} The request ` +
    'stays ACTIVE until a removal succeeds.',
};

/** Longest error text stored in a statusReason. */
const MAX_REASON_DETAIL = 300;

/** The operations of the request's Entra ID entitlements with `action` (no native id: none). */
function entraOperations(
  entitlements: RequestEntitlement[],
  action: 'add' | 'remove',
): ProvisioningIntent['operations'] {
  return entitlements
    .filter((ent) => ent.nativeId && getSystemType(ent.system) === 'entra')
    .map((ent) => ({
      type: toOperationType(ent.entitlementType) as RequestOperationType,
      action,
      targetId: ent.nativeId as string,
    }));
}

/**
 * Temporal activities for Access Request approval workflow.
 */
@Injectable()
export class AccessRequestActivities {
  private readonly logger = new Logger(AccessRequestActivities.name);

  constructor(
    @InjectModel(AccessRequest.name)
    private readonly accessRequestModel: Model<AccessRequestDocument>,
    private readonly entitlementCatalog: EntitlementCatalogService,
    private readonly entraChanges: EntraEntitlementChanges,
    private readonly emailNotifications: EmailNotificationService,
    private readonly accessRequestSod: AccessRequestSodService,
    private readonly closure: AccessRequestClosureService,
  ) {}

  async getAccessRequest(
    requestId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<AccessRequestDocument | null> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const doc = await this.accessRequestModel.findOne({ requestId }).lean().exec();
        return doc as AccessRequestDocument | null;
      },
      { correlationId },
    );
  }

  async updateRequestStatus(
    requestId: string,
    status: string,
    updates?: { provisionedAt?: Date; expiresAt?: Date },
    tenantId?: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const set: Record<string, unknown> = { status };
        if (updates?.provisionedAt) set.provisionedAt = updates.provisionedAt;
        if (updates?.expiresAt) set.expiresAt = updates.expiresAt;
        await this.accessRequestModel.updateOne({ requestId }, { $set: set }).exec();
        this.logger.log(`[AccessRequest] ${requestId} status -> ${status}`);
      },
      { correlationId },
    );
  }

  /**
   * The SoD check when the last approval comes in, before fulfilment (patch
   * access-request:sod-recheck-before-provision): marks the request PROVISIONING, checks it against
   * the access the person holds at that moment and, on a BLOCK match, marks it REJECTED with the
   * matches as its sodCheckResult (AccessRequestSodService.claimForProvisioning). Returns whether
   * fulfilment may go ahead.
   */
  async recheckSodBeforeProvisioning(
    requestId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<{ passed: boolean }> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      () => this.accessRequestSod.claimForProvisioning(tenantId ?? '', requestId),
      { correlationId },
    );
  }

  /**
   * A time-bound request whose end date passed before its last approval came in (patch
   * access-request-approval:end-date-passed-before-approval): nothing is fulfilled, and the
   * request ends EXPIRED with the reason, stored on it for the requester's request page and in
   * the audit log as access_request.closed (AccessRequestClosureService). A request that is no
   * longer pending (cancelled meanwhile) is left as it is.
   */
  async expireBeforeFulfilment(
    requestId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    await withTenantContext(
      tenantId ?? '',
      () =>
        this.closure.close(requestId, 'EXPIRED', CLOSE_REASONS.endDatePassed, 'PENDING_APPROVAL'),
      { correlationId },
    );
  }

  /**
   * Emails the approver of step `stepIndex` that the request waits for them (EmailNotificationService;
   * nothing when email is off); for a ROLE step every active admin user of the tenant with the role. Never throws: the workflow proxies this activity with the default
   * retry policy, so a throw would hold the approval step until mail works again. A failed send is
   * retried from the dead-letter queue, outside the workflow.
   */
  async notifyApprover(
    requestId: string,
    stepIndex: number,
    tenantId?: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      if (!this.emailNotifications.isEnabled()) return;
      validateActivityContext({ tenantId: tenantId ?? '', correlationId });
      const tid = tenantId ?? '';
      await withTenantContext(
        tid,
        async () => {
          const doc = await this.accessRequestModel.findOne({ requestId }).lean().exec();
          const step = doc?.approvalSteps?.[stepIndex];
          if (!doc || !step || doc.status !== 'PENDING_APPROVAL' || step.status !== 'PENDING')
            return;
          const approverRole = stepRole(step);
          const result = await this.emailNotifications.notifyApprover(tid, {
            requestId,
            stepIndex,
            stepCount: doc.approvalSteps.length,
            approverEmail: step.approverEmail,
            approverId: step.approverId,
            ...(approverRole ? { approverRole } : {}),
            requesterId: doc.requesterId,
            requesterEmail: doc.requesterEmail,
            entitlements: (doc.entitlements ?? []).map((e) => ({
              system: e.system,
              name: e.entitlementName,
            })),
          });
          this.logger.log(
            `[AccessRequest] ${requestId} step ${stepIndex} approver email: ${result}`,
          );
        },
        { correlationId },
      );
    } catch (err: unknown) {
      this.logger.warn(
        `[AccessRequest] ${requestId} step ${stepIndex}: approver email not sent: ${describeError(err)}`,
      );
    }
  }

  /**
   * Grants the request's entitlements: adds them on the Entra ID account recorded for the person
   * (EntraEntitlementChanges), and changes nothing else there: no attribute is written and no
   * account is created. Returns false, with the reason stored on the request (`statusReason`),
   * when the request names a system other than Entra ID (before anything is granted), when no
   * Entra ID account is recorded and no single account is found by the person's identifiers, or
   * Entra ID no longer has the recorded one (creating accounts is onboarding's job), or when Graph refuses a change in a way retrying cannot fix (also emitted as
   * provisioning.failed). A failure retrying can fix (a 5xx, no answer, a 429) is thrown, so
   * Temporal retries the activity; the changes are idempotent.
   */
  async provisionAccessRequest(
    requestId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<boolean> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const doc = await this.accessRequestModel.findOne({ requestId }).exec();
        if (!doc) {
          this.logger.error(`[AccessRequest] ${requestId} not found for provisioning`);
          return false;
        }
        const identityId = doc.targetIdentityId ?? doc.requesterId;

        // Access requests fulfil Entra ID entitlements only: a request with another system's
        // fails before any part of it is granted (it was ACTIVE with nothing granted)
        const unsupported = doc.entitlements.filter(
          (ent) => ent.nativeId && getSystemType(ent.system) !== 'entra',
        );
        if (unsupported.length > 0) {
          const systems = [...new Set(unsupported.map((e) => e.system))].join(', ');
          this.logger.error(`[AccessRequest] ${requestId} not fulfilled: it names ${systems}`);
          await this.storeReason(requestId, FULFILMENT_REASONS.unsupported(systems));
          return false;
        }

        const operations = entraOperations(doc.entitlements, 'add');
        if (operations.length === 0) return true;

        const outcome = await this.entraChanges.change(identityId, operations);
        if (outcome.status === 'changed') return true;

        let reason: string;
        if (outcome.status === 'refused') {
          reason = FULFILMENT_REASONS.refused(outcome.reason);
          this.entraChanges.reportRefused(identityId, outcome.reason, requestId);
        } else {
          reason = outcome.recorded ? FULFILMENT_REASONS.accountGone : FULFILMENT_REASONS.noAccount;
        }
        this.logger.error(`[AccessRequest] ${requestId} not fulfilled: ${reason}`);
        await this.storeReason(requestId, reason);
        return false;
      },
      { correlationId },
    );
  }

  /**
   * Removes the request's entitlements at its end (the approval workflow's expiry), on the Entra
   * ID account recorded for the person and nothing else (EntraEntitlementChanges). One the
   * person also holds through a role-based rule or another request in force is left
   * (AccessRequestSodService.grantedElsewhere). Done (`success`) when the removals were made or
   * there was nothing to remove: no account recorded, or Entra ID no longer has it, or a group
   * or license that no longer exists. A system whose removal failed is in `failedSystems`; the
   * workflow tries again until none fails (patch access-request-approval:revoke-until-done) and
   * only then marks the request EXPIRED. A refusal retrying cannot fix keeps the request ACTIVE
   * with the reason on it (`statusReason`, shown on the request page) and is emitted once per
   * reason as provisioning.failed for a person to act on. A failure retrying can fix (a 5xx, a
   * 429, no answer) records that the removal is being retried and why (`statusReason`), so the
   * request is in the removal-failing list too. The next attempt that succeeds clears the
   * reason.
   */
  async revokeAccessRequest(
    requestId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<{ success: boolean; failedSystems: string[] }> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const done = { success: true, failedSystems: [] as string[] };
        const doc = await this.accessRequestModel.findOne({ requestId }).exec();
        if (!doc) return done;
        const identityId = doc.targetIdentityId ?? doc.requesterId;

        const kept = new Set(
          await this.accessRequestSod.grantedElsewhere(
            tenantId ?? '',
            identityId,
            requestId,
            doc.entitlements,
          ),
        );
        if (kept.size > 0) {
          this.logger.log(
            `[AccessRequest] ${requestId}: ${kept.size} entitlement(s) left in place, granted ` +
              'by a rule or another request',
          );
        }

        const removed = doc.entitlements.filter((ent) => !kept.has(ent));
        const operations = entraOperations(removed, 'remove');
        if (operations.length === 0) return done;
        const systems = [
          ...new Set(
            removed.filter((e) => getSystemType(e.system) === 'entra').map((e) => e.system),
          ),
        ];

        let outcome: Awaited<ReturnType<EntraEntitlementChanges['change']>>;
        try {
          outcome = await this.entraChanges.change(identityId, operations);
        } catch (e) {
          this.logger.warn(`[AccessRequest] Revoke of ${requestId} failed, tried again: ${e}`);
          // Recorded so the request shows in the removal-failing list while Graph keeps failing
          const detail = (e instanceof Error ? e.message : String(e)).slice(0, MAX_REASON_DETAIL);
          await this.accessRequestModel
            .updateOne(
              { requestId, status: 'ACTIVE' },
              { $set: { statusReason: FULFILMENT_REASONS.revokeRetrying(detail) } },
            )
            .exec();
          return { success: false, failedSystems: systems };
        }
        if (outcome.status === 'refused') {
          const reason = FULFILMENT_REASONS.revokeRefused(outcome.reason);
          const updated = await this.accessRequestModel
            .updateOne(
              { requestId, status: 'ACTIVE', statusReason: { $ne: reason } },
              { $set: { statusReason: reason } },
            )
            .exec();
          if (updated.modifiedCount > 0)
            this.entraChanges.reportRefused(identityId, outcome.reason, requestId);
          this.logger.warn(`[AccessRequest] Revoke of ${requestId} refused: ${outcome.reason}`);
          return { success: false, failedSystems: systems };
        }

        await this.accessRequestModel
          .updateOne(
            { requestId, status: 'ACTIVE', statusReason: { $exists: true } },
            { $unset: { statusReason: '' } },
          )
          .exec();
        this.logger.log(
          `[AccessRequest] ${requestId} entitlements revoked` +
            (outcome.status === 'no-account' ? ' (no Entra ID account to remove them from)' : ''),
        );
        return done;
      },
      { correlationId },
    );
  }

  /** Stores why the request was not fulfilled (`statusReason`); the workflow then rejects it. */
  private async storeReason(requestId: string, reason: string): Promise<void> {
    await this.accessRequestModel
      .updateOne({ requestId }, { $set: { statusReason: reason } })
      .exec();
  }
}
