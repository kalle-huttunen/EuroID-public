/**
 * Access review: removes an account item a campaign revoked (the identity's account in a target
 * whose memberships EuroID cannot read, modules/access-review/review-account-items.ts) through
 * the per-target deprovision offboarding and entitlement expiry use (EntitlementExpiryDeprovision:
 * GitHub removes the organization membership, ServiceNow deactivates the user). As expiry does,
 * the provisioning entry becomes DEPROVISIONED once the account is removed, already gone, or kept
 * nowhere. Outcomes:
 * - removed: the target removed or disabled the account in this run (`detail` says how);
 * - already-gone: the target has no such account any more, it keeps no account (File outbound,
 *   Google Sheets, Discord webhook), the identity's entry no longer counts an account there
 *   (deprovisioned since the review), or the identity is deleted (offboarded);
 * - manual-action-needed: a target offboarding has no deprovision for;
 * - failed: thrown, as connector revocations are: not retryable (client error, no connector
 *   config) or retryable (5xx, network, timeout, 429), with the reason masked.
 * The recorded outcome goes on the identity timeline (announce: access_review.account_revoked).
 */
import { Injectable } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import type {
  AccessReviewAccountRevokedPayload,
  ConnectorRevocationResult,
  RevocationOutcome,
} from '@shared/types/access-review-revocation';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { ReviewItem } from '../modules/access-review/schemas/review-item.schema';
import { IdentityService } from '../modules/identity/identity.service';
import {
  IdentityProvisioningService,
  hasProvisionedAccount,
} from '../modules/identity/identity-provisioning.service';
import { offboardingTargetKind } from '../workflows/offboarding-targets';
import { EntitlementExpiryDeprovision } from './entitlement-expiry-deprovision';
import type { DeprovisionOutcome } from './entitlement-expiry-failure';
import { DEPROVISION_REJECTED } from './deprovision-failure';

type Removed = Extract<DeprovisionOutcome, { deprovisioned: true }>;

/** A revocation outcome as the review item stores it (detail and reason masked). */
export type StoredRevocation = { outcome: RevocationOutcome; detail?: string; reason?: string };

/** The review outcome of an account the deprovision removed, found gone, or found kept nowhere. */
function reviewResult({ outcome, detail }: Removed): ConnectorRevocationResult {
  switch (outcome) {
    case 'deprovisioned':
      return { outcome: 'removed', ...(detail ? { detail } : {}) };
    case 'already-gone':
      return { outcome: 'already-gone', ...(detail ? { detail } : {}) };
    case 'not-applicable':
      return { outcome: 'already-gone', detail: 'keeps no account (notification or log target)' };
  }
}

@Injectable()
export class ReviewAccountRevocation {
  constructor(
    private readonly identityService: IdentityService,
    private readonly provisioningService: IdentityProvisioningService,
    private readonly deprovisioner: EntitlementExpiryDeprovision,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /**
   * Put a recorded account outcome on the identity timeline (access_review.account_revoked), by
   * the reviewer who revoked the item; an expired item the campaign auto-revokes is the system's.
   */
  announce(
    campaignId: string,
    item: Pick<ReviewItem, 'itemId' | 'identityId' | 'decision' | 'decidedBy' | 'entitlements'>,
    entitlementIndex: number,
    result: StoredRevocation,
  ): void {
    const payload: AccessReviewAccountRevokedPayload = {
      identityId: item.identityId,
      campaignId,
      itemId: item.itemId,
      targetSystem: item.entitlements?.[entitlementIndex]?.system ?? '',
      ...result,
    };
    const actor = item.decision === 'revoked' ? item.decidedBy : undefined;
    this.eventEmitter.emit(
      DomainEventType.ACCESS_REVIEW_ACCOUNT_REVOKED,
      item.identityId,
      payload,
      actor ? { actor } : undefined,
    );
  }

  /** Remove the identity's account in `system` (runs inside the item's tenant context). */
  async revoke(
    identityId: string,
    system: string,
    tenantId: string,
  ): Promise<ConnectorRevocationResult> {
    if (offboardingTargetKind(system) === 'unknown') {
      return {
        outcome: 'manual-action-needed',
        reason: `EuroID has no deprovision for ${system}: remove the account in that system.`,
      };
    }
    const identity = await this.identityService.findIdentityById(identityId);
    if (!identity)
      return { outcome: 'already-gone', detail: 'the identity is deleted (offboarded)' };
    const entry = identity.provisioning?.find((p) => p.targetSystem === system);
    const accountId = this.provisioningService.accountIdFor(identity, system);
    if (!entry || !hasProvisionedAccount(entry, accountId)) {
      return { outcome: 'already-gone', detail: 'no account recorded there any more' };
    }
    const outcome = await this.deprovisioner.deprovision(identity, entry, tenantId);
    if (!outcome.deprovisioned) {
      throw outcome.retryable
        ? new Error(outcome.reason)
        : ApplicationFailure.nonRetryable(outcome.reason, DEPROVISION_REJECTED);
    }
    await this.provisioningService.updateProvisioningState(identityId, system, 'DEPROVISIONED');
    return reviewResult(outcome);
  }
}
