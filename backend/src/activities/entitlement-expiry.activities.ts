/**
 * Entitlement Expiry Activities
 *
 * Finds identities with expired provisioning entries, deprovisions them (through
 * offboarding's per-target deprovision, entitlement-expiry-deprovision.ts) and emits
 * expiry/notification events. Used by entitlementExpiryWorkflow. An entry that cannot be
 * deprovisioned gets its failure recorded and is left alone until it is due again
 * (entitlement-expiry-failure.ts). Each run also ends the expired PAM sessions and the expired
 * attribute controls (identity department and job title overrides).
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type {
  IdentityDocument,
  ProvisioningState,
} from '../modules/identity/schemas/identity.schema';
import { IdentityProvisioningService } from '../modules/identity/identity-provisioning.service';
import { IdentityService } from '../modules/identity/identity.service';
import { PrivilegedAccessService } from '../modules/privileged-access/privileged-access.service';
import { OktaService } from '../modules/connectors/okta-connector/okta.service';
import { DomainEventEmitterService } from '../infrastructure/events/event-emitter.service';
import { DomainEventType } from '../infrastructure/events/event-types';
import { TenantService } from '../infrastructure/multi-tenancy/tenant.service';
import { withTenantContext } from '../infrastructure/multi-tenancy/tenant-context.helper';
import { NOT_DELETED } from '../modules/identity/identity.constants';
import { reportIdentityLimitOvershoot } from '../modules/identity/identity-limit';
import type { EntitlementExpiryFailedPayload } from '../infrastructure/events/event-payloads';
import {
  type DeprovisionFailure,
  type DeprovisionOutcome,
  expiryDueExpr,
  isExpiryDue,
  nextExpiryFailure,
} from './entitlement-expiry-failure';
import { EntitlementExpiryDeprovision } from './entitlement-expiry-deprovision';

type ExpiryWindow = 'soon' | 'tomorrow';

/** Days ahead and event of each expiry warning. */
const WARNINGS: Record<ExpiryWindow, { days: number; event: DomainEventType }> = {
  soon: { days: 7, event: DomainEventType.ENTITLEMENT_EXPIRING_SOON },
  tomorrow: { days: 1, event: DomainEventType.ENTITLEMENT_EXPIRING_TOMORROW },
};

export interface EntitlementExpiryResult {
  /** Expired entries deprovisioned. */
  processed: number;
  /** Expired entries whose deprovision failed; recorded on the entry (expiryFailure). */
  failed: number;
  expiringSoonCount: number;
  expiringTomorrowCount: number;
}

@Injectable()
export class EntitlementExpiryActivities {
  private readonly logger = new Logger(EntitlementExpiryActivities.name);

  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly provisioningService: IdentityProvisioningService,
    private readonly deprovisioner: EntitlementExpiryDeprovision,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly tenantService: TenantService,
    private readonly privilegedAccessService: PrivilegedAccessService,
    private readonly identityService: IdentityService,
    // Absent where Okta is not wired in (tests): the sweep then starts runs as before
    @Optional() private readonly oktaService?: OktaService,
  ) {}

  /**
   * Find and process expired provisioning entries. When tenantId is empty, process all tenants.
   */
  async runEntitlementExpiryCheck(
    tenantId: string,
    nowIso: string,
    limit: number,
  ): Promise<EntitlementExpiryResult> {
    const now = new Date(nowIso);
    const tenants = tenantId
      ? [{ tenantId }]
      : (await this.tenantService.findAll())
          .filter((t) => t.status === 'active')
          .map((t) => ({ tenantId: t.tenantId }));

    let processed = 0;
    let failed = 0;
    let expiringSoonCount = 0;
    let expiringTomorrowCount = 0;

    for (const { tenantId: tid } of tenants) {
      const result = await withTenantContext(tid, async () =>
        this.processTenantExpiries(tid, now, limit),
      );
      processed += result.processed;
      failed += result.failed;
      expiringSoonCount += result.expiringSoonCount;
      expiringTomorrowCount += result.expiringTomorrowCount;

      // PAM: end expired sessions (safety net for the session's own timer), then disable the
      // admin accounts that may still be enabled outside a session (bounded per tenant)
      try {
        const pamDeactivated = await withTenantContext(tid, () =>
          this.privilegedAccessService.deactivateExpiredSessions(tid),
        );
        if (pamDeactivated > 0) {
          this.logger.log(
            `[ExpiryCheck] Ended ${pamDeactivated} expired PAM sessions for tenant ${tid}`,
          );
        }
        // Okta: an admin account still waiting for its owner's activation gets no run
        const oktaService = this.oktaService;
        const readOktaStatus = oktaService
          ? (account: { oktaUserId?: string; login: string }) => oktaService.getUserStatus(account)
          : undefined;
        const disabling = await withTenantContext(tid, () =>
          this.privilegedAccessService.convergeStandingState(tid, readOktaStatus),
        );
        if (disabling > 0) {
          this.logger.log(
            `[ExpiryCheck] Started ${disabling} PAM disable runs for admin accounts of unknown ` +
              `state in tenant ${tid}`,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[ExpiryCheck] PAM session sweep failed for tenant ${tid}: ${msg}`);
      }

      // The identity limit: creates running at once may have passed it unseen (their
      // transactions could not see each other); one alert per overshoot (identity-limit.ts)
      try {
        await withTenantContext(tid, () =>
          reportIdentityLimitOvershoot(this.identityModel, this.eventEmitter, tid),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[ExpiryCheck] Identity limit check failed for tenant ${tid}: ${msg}`);
      }

      // End the attribute controls (department, job title overrides) whose expiry has passed:
      // the HR value returns and the mover runs (IdentityControlsService.endExpiredControls)
      try {
        const ended = await withTenantContext(tid, () =>
          this.identityService.endExpiredControls(tid, now, limit),
        );
        if (ended > 0) {
          this.logger.log(`[ExpiryCheck] Ended expired controls of ${ended} identities in ${tid}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[ExpiryCheck] Control expiry sweep failed for tenant ${tid}: ${msg}`);
      }
    }

    return { processed, failed, expiringSoonCount, expiringTomorrowCount };
  }

  private async processTenantExpiries(
    tenantId: string,
    now: Date,
    limit: number,
  ): Promise<EntitlementExpiryResult> {
    const { processed, failed } = await this.expireDue(tenantId, now, limit);
    const expiringSoonCount = await this.warnExpiring(tenantId, now, 'soon', limit);
    const expiringTomorrowCount = await this.warnExpiring(tenantId, now, 'tomorrow', limit);

    return { processed, failed, expiringSoonCount, expiringTomorrowCount };
  }

  /**
   * Deprovision the due expired entries (isExpiryDue) of up to `limit` identities. Each attempted
   * entry is DEPROVISIONED or gets its failure recorded, which keeps it out of the rest of this
   * run (same `now`), so the workflow's next batch reaches other identities.
   */
  private async expireDue(
    tenantId: string,
    now: Date,
    limit: number,
  ): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;

    const expiredIdentities = await this.identityModel
      .find({
        ...NOT_DELETED,
        tenantId,
        provisioning: {
          $elemMatch: {
            expiresAt: { $exists: true, $lte: now },
            status: { $ne: 'DEPROVISIONED' },
          },
        },
        $expr: expiryDueExpr(now),
      })
      .limit(limit)
      .lean()
      .exec();

    for (const identity of expiredIdentities) {
      const doc = identity as unknown as IdentityDocument;
      const dueEntries = (doc.provisioning || []).filter((p) => isExpiryDue(p, now));
      for (const entry of dueEntries) {
        const outcome = await this.deprovisionEntry(doc, entry, tenantId);
        if (outcome.deprovisioned) {
          processed++;
          this.eventEmitter.emit(DomainEventType.ENTITLEMENT_EXPIRED, doc._id.toString(), {
            identityId: doc._id.toString(),
            targetSystem: entry.targetSystem,
            expiresAt: entry.expiresAt,
            outcome: outcome.outcome,
            ...(outcome.detail ? { detail: outcome.detail } : {}),
          });
        } else if (await this.recordFailure(doc, entry, outcome, now)) {
          failed++;
        }
      }
    }
    return { processed, failed };
  }

  /**
   * Record a failed deprovision on the entry (expiryFailure, for its expiresAt) and emit
   * entitlement.expiry_failed (audit log, identity timeline). False when the entry changed
   * meanwhile (another expiresAt, or DEPROVISIONED): nothing is recorded then.
   */
  private async recordFailure(
    doc: IdentityDocument,
    entry: ProvisioningState,
    failure: DeprovisionFailure,
    now: Date,
  ): Promise<boolean> {
    const record = nextExpiryFailure(entry, failure, now, new Date());
    const updated = await this.identityModel
      .updateOne(
        {
          _id: doc._id,
          provisioning: {
            $elemMatch: {
              targetSystem: entry.targetSystem,
              expiresAt: entry.expiresAt,
              status: { $ne: 'DEPROVISIONED' },
            },
          },
        },
        { $set: { 'provisioning.$.expiryFailure': record } },
      )
      .exec();
    if (updated.modifiedCount === 0) return false;

    const identityId = doc._id.toString();
    this.logger.warn(
      `[ExpiryCheck] Expired access of identity ${identityId} not removed from ` +
        `${entry.targetSystem} (attempt ${record.attempts}, ` +
        `${record.retryable ? 'retried later' : 'not retried'}): ${record.reason}`,
    );
    const payload: EntitlementExpiryFailedPayload = {
      identityId,
      targetSystem: entry.targetSystem,
      expiresAt: record.expiresAt.toISOString(),
      reason: record.reason,
      retryable: record.retryable,
      attempts: record.attempts,
      ...(record.nextAttemptAt ? { nextAttemptAt: record.nextAttemptAt.toISOString() } : {}),
    };
    this.eventEmitter.emit(DomainEventType.ENTITLEMENT_EXPIRY_FAILED, identityId, payload);
    return true;
  }

  /**
   * Emit the 7-day (`soon`) or 1-day (`tomorrow`) warning for entries whose expiry falls on that
   * calendar day, once per entry and expiry date: the run records the expiresAt it warned about
   * on the entry (`expiryWarnings`) before emitting, and an entry whose recorded warning is on the
   * same day is skipped, by later hourly runs, extra batches and a run racing this one alike. A
   * changed expiry date is warned about again. Returns the warnings emitted.
   */
  private async warnExpiring(
    tenantId: string,
    now: Date,
    window: ExpiryWindow,
    limit: number,
  ): Promise<number> {
    const day = new Date(now);
    day.setDate(day.getDate() + WARNINGS[window].days);
    const start = new Date(day);
    start.setHours(0, 0, 0, 0);
    const end = new Date(day);
    end.setHours(23, 59, 59, 999);
    const inWindow = (value: Date | undefined) => {
      const time = value ? new Date(value).getTime() : NaN;
      return time >= start.getTime() && time <= end.getTime();
    };
    const warnedPath = `expiryWarnings.${window}`;
    const notWarned = { [warnedPath]: { $not: { $gte: start, $lte: end } } };

    const identities = await this.identityModel
      .find({
        ...NOT_DELETED,
        tenantId,
        provisioning: {
          $elemMatch: {
            expiresAt: { $gte: start, $lte: end },
            status: { $ne: 'DEPROVISIONED' },
            ...notWarned,
          },
        },
      })
      .limit(limit)
      .lean()
      .exec();

    let warned = 0;
    for (const identity of identities) {
      const doc = identity as unknown as IdentityDocument;
      const due = (doc.provisioning || []).filter(
        (p) =>
          inWindow(p.expiresAt) &&
          p.status !== 'DEPROVISIONED' &&
          !inWindow(p.expiryWarnings?.[window]),
      );
      for (const entry of due) {
        const claimed = await this.identityModel
          .updateOne(
            {
              _id: doc._id,
              provisioning: {
                $elemMatch: {
                  targetSystem: entry.targetSystem,
                  expiresAt: entry.expiresAt,
                  ...notWarned,
                },
              },
            },
            { $set: { [`provisioning.$.${warnedPath}`]: entry.expiresAt } },
          )
          .exec();
        if (claimed.modifiedCount === 0) continue;
        warned++;
        // No email: the expiring-access mail reads the identity's (EmailNotificationHandler)
        this.eventEmitter.emit(WARNINGS[window].event, doc._id.toString(), {
          identityId: doc._id.toString(),
          targetSystem: entry.targetSystem,
          expiresAt: entry.expiresAt,
        });
      }
    }
    return warned;
  }

  /**
   * Remove the expired access in the target as offboarding does (EntitlementExpiryDeprovision)
   * and mark the entry DEPROVISIONED when it is removed, already gone or the target keeps no
   * account.
   */
  private async deprovisionEntry(
    identity: IdentityDocument,
    entry: ProvisioningState,
    tenantId: string,
  ): Promise<DeprovisionOutcome> {
    const outcome = await this.deprovisioner.deprovision(identity, entry, tenantId);
    if (outcome.deprovisioned) {
      await this.provisioningService.updateProvisioningState(
        identity._id.toString(),
        entry.targetSystem,
        'DEPROVISIONED',
      );
    }
    return outcome;
  }
}
