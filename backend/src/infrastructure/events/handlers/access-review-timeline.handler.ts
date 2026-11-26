import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import type {
  AccessReviewAccountRevokedPayload,
  AccessReviewMembershipRevokedPayload,
} from '../event-payloads';
import { UserEventService } from '../../../modules/identity/user-event.service';
import type { RecordEventDto } from '../../../modules/identity/user-event.service';
import { withTenantContext } from '../../multi-tenancy/tenant-context.helper';
import type { RevocationOutcome } from '@shared/types/access-review-revocation';

type Entries = Record<
  RevocationOutcome,
  { title: (system: string) => string; severity: RecordEventDto['severity'] }
>;

const ACCOUNT: Entries = {
  removed: { title: (s) => `Account removed after access review: ${s}`, severity: 'success' },
  'already-gone': { title: (s) => `No account left after access review: ${s}`, severity: 'info' },
  'manual-action-needed': {
    title: (s) => `Account to remove by hand after access review: ${s}`,
    severity: 'warning',
  },
  failed: { title: (s) => `Account removal after access review failed: ${s}`, severity: 'error' },
};

const MEMBERSHIP: Entries = {
  removed: {
    title: (s) => `Group membership removed after access review: ${s}`,
    severity: 'success',
  },
  'already-gone': {
    title: (s) => `No group membership left after access review: ${s}`,
    severity: 'info',
  },
  'manual-action-needed': {
    title: (s) => `Group membership to remove by hand after access review: ${s}`,
    severity: 'warning',
  },
  failed: {
    title: (s) => `Group membership removal after access review failed: ${s}`,
    severity: 'error',
  },
};

/**
 * Puts the removal of a revoked account item (access_review.account_revoked, a target whose
 * memberships EuroID cannot read) and of a revoked group membership
 * (access_review.membership_revoked) on the identity timeline, as offboarding and entitlement
 * expiry put theirs: what the target did, or why it was not removed. The actor is the reviewer
 * who revoked it (the system for an auto-revoked expired item).
 */
@Injectable()
export class AccessReviewTimelineHandler {
  private readonly logger = new Logger(AccessReviewTimelineHandler.name);

  constructor(private readonly userEventService: UserEventService) {}

  @OnEvent(DomainEventType.ACCESS_REVIEW_ACCOUNT_REVOKED, { async: true })
  async handleAccountRevoked(event: DomainEvent<AccessReviewAccountRevokedPayload>): Promise<void> {
    await this.record(event, 'USER_DEPROVISIONED', ACCOUNT);
  }

  @OnEvent(DomainEventType.ACCESS_REVIEW_MEMBERSHIP_REVOKED, { async: true })
  async handleMembershipRevoked(
    event: DomainEvent<AccessReviewMembershipRevokedPayload>,
  ): Promise<void> {
    const { groupId } = event.payload;
    await this.record(event, 'GROUP_REMOVED', MEMBERSHIP, groupId ? { groupId } : {});
  }

  private async record(
    event: DomainEvent<AccessReviewAccountRevokedPayload>,
    type: RecordEventDto['type'],
    entries: Entries,
    metadata: Record<string, string> = {},
  ): Promise<void> {
    const tenantId = event.metadata.tenantId;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, skipping timeline`);
      return;
    }
    const { identityId, campaignId, itemId, targetSystem, outcome, detail, reason } = event.payload;
    const description = reason ?? detail;
    try {
      await withTenantContext(tenantId, async () => {
        await this.userEventService.recordEvent({
          userId: identityId,
          actor: event.metadata.actor,
          type,
          severity: entries[outcome].severity,
          title: entries[outcome].title(targetSystem),
          ...(description ? { description } : {}),
          targetSystem,
          metadata: { campaignId, itemId, ...metadata, outcome },
        });
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to record access review timeline for ${identityId}: ${message}`);
    }
  }
}
