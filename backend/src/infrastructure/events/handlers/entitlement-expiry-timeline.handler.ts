import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import type {
  EntitlementExpiredPayload,
  EntitlementExpiryFailedPayload,
  EntitlementExpiryRemovedManuallyPayload,
  EntitlementExpiryRetryRequestedPayload,
} from '../event-payloads';
import { UserEventService } from '../../../modules/identity/user-event.service';
import type { RecordEventDto } from '../../../modules/identity/user-event.service';
import { withTenantContext } from '../../multi-tenancy/tenant-context.helper';

type Entry = Omit<RecordEventDto, 'userId' | 'actor'>;

const iso = (value: Date | string) => new Date(value).toISOString();

/** Timeline title of expired access that ended, by what the target did (offboarding's outcomes). */
const ENDED_TITLE: Record<NonNullable<EntitlementExpiredPayload['outcome']>, string> = {
  deprovisioned: 'Access expired, removed',
  'already-gone': 'Access expired, no account left',
  'not-applicable': 'Access expired, the target keeps no account',
};

/**
 * Puts time-bound access that ended on the identity timeline: removed at expiry
 * (entitlement.expired, with what the target did), or not removed (entitlement.expiry_failed)
 * with the reason and whether the hourly run tries again, and the admin actions on a failed one:
 * retried (entitlement.expiry_retry_requested) or removed by hand
 * (entitlement.expiry_removed_manually), with the admin as actor. Entries carry the target
 * system and dates, no email.
 */
@Injectable()
export class EntitlementExpiryTimelineHandler {
  private readonly logger = new Logger(EntitlementExpiryTimelineHandler.name);

  constructor(private readonly userEventService: UserEventService) {}

  @OnEvent(DomainEventType.ENTITLEMENT_EXPIRED, { async: true })
  async handleExpired(event: DomainEvent<EntitlementExpiredPayload>): Promise<void> {
    const { identityId, targetSystem, expiresAt, outcome, detail } = event.payload;
    await this.record(event, identityId, {
      type: 'USER_DEPROVISIONED',
      severity: 'success',
      title: `${ENDED_TITLE[outcome ?? 'deprovisioned']}: ${targetSystem}`,
      description: `Time-bound access ended ${iso(expiresAt)}.`,
      targetSystem,
      metadata: {
        expiresAt: iso(expiresAt),
        ...(outcome ? { outcome } : {}),
        ...(detail ? { detail } : {}),
      },
    });
  }

  @OnEvent(DomainEventType.ENTITLEMENT_EXPIRY_FAILED, { async: true })
  async handleExpiryFailed(event: DomainEvent<EntitlementExpiryFailedPayload>): Promise<void> {
    const { identityId, targetSystem, expiresAt, reason, retryable, attempts, nextAttemptAt } =
      event.payload;
    const next = retryable
      ? `Tried again from ${nextAttemptAt ?? 'the next run'}.`
      : `Not retried: the access stays until it is removed in ${targetSystem} and marked ` +
        'removed manually, an admin retries it after fixing the cause, or the expiry date ' +
        'changes.';
    await this.record(event, identityId, {
      type: 'USER_DEPROVISIONED',
      severity: retryable ? 'warning' : 'error',
      title: `Expired access not removed: ${targetSystem}`,
      description: `${reason}. ${next}`,
      targetSystem,
      metadata: { expiresAt, retryable, attempts, nextAttemptAt },
    });
  }

  @OnEvent(DomainEventType.ENTITLEMENT_EXPIRY_RETRY_REQUESTED, { async: true })
  async handleRetryRequested(
    event: DomainEvent<EntitlementExpiryRetryRequestedPayload>,
  ): Promise<void> {
    const { identityId, targetSystem, expiresAt, failureReason } = event.payload;
    await this.record(event, identityId, {
      type: 'USER_DEPROVISIONED',
      severity: 'info',
      title: `Expired access removal retried: ${targetSystem}`,
      description:
        `The failure was cleared (${failureReason}). ` +
        'The next hourly expiry run tries to remove the access again.',
      targetSystem,
      metadata: { expiresAt },
    });
  }

  @OnEvent(DomainEventType.ENTITLEMENT_EXPIRY_REMOVED_MANUALLY, { async: true })
  async handleRemovedManually(
    event: DomainEvent<EntitlementExpiryRemovedManuallyPayload>,
  ): Promise<void> {
    const { identityId, targetSystem, expiresAt, reason, failureReason } = event.payload;
    await this.record(event, identityId, {
      type: 'USER_DEPROVISIONED',
      severity: 'success',
      title: `Expired access removed manually: ${targetSystem}`,
      description: reason,
      targetSystem,
      metadata: { expiresAt, outcome: 'removed-manually', failureReason },
    });
  }

  private async record(event: DomainEvent<unknown>, identityId: string, entry: Entry) {
    const tenantId = event.metadata.tenantId;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, skipping timeline`);
      return;
    }
    try {
      await withTenantContext(tenantId, async () => {
        await this.userEventService.recordEvent({
          ...entry,
          userId: identityId,
          actor: event.metadata.actor,
        });
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to record expiry timeline for ${identityId}: ${message}`);
    }
  }
}
