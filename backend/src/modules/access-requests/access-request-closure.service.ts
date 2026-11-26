import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { AccessRequestClosedPayload } from '@infrastructure/events/event-payloads';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import {
  AccessRequest,
  type AccessRequestDocument,
  type AccessRequestStatus,
} from './schemas/access-request.schema';

/** Why the system closed a request (`statusReason`, the `reason` of access_request.closed). */
export const CLOSE_REASONS = {
  /** A time-bound request whose end date passed before its last approval came in. */
  endDatePassed: 'The requested end date passed before approval completed.',
  /** An approver decided, but the request's approval workflow had ended. */
  workflowGone: 'The approval workflow is no longer running.',
} as const;

export type AccessRequestCloseReason = (typeof CLOSE_REASONS)[keyof typeof CLOSE_REASONS];

/**
 * Ends a request the system closes without a decision that says why by itself: the reason is
 * stored on the request (`statusReason`, shown on the request page) and goes to the audit log as
 * access_request.closed, with the actor `system`. Two cases: a time-bound request whose end date
 * passed before approval completed (EXPIRED, from the approval workflow's expireBeforeFulfilment
 * activity), and a request whose approval workflow no longer runs when an approver decides or
 * delegates (CANCELLED, from AccessRequestDecisionService: nobody rejected it). Runs in the
 * tenant context of the request or the activity.
 */
@Injectable()
export class AccessRequestClosureService {
  private readonly logger = new Logger(AccessRequestClosureService.name);

  constructor(
    @InjectModel(AccessRequest.name)
    private readonly accessRequestModel: Model<AccessRequestDocument>,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /**
   * Closes the request with `status` and `reason` while it is still `from`; a request that moved
   * on meanwhile (cancelled, decided) is left as it is. Returns whether this call closed it.
   */
  async close(
    requestId: string,
    status: Extract<AccessRequestStatus, 'EXPIRED' | 'CANCELLED'>,
    reason: AccessRequestCloseReason,
    from: AccessRequestStatus,
  ): Promise<boolean> {
    const tenantId = getCurrentTenantId();
    const result = await this.accessRequestModel
      .updateOne({ requestId, tenantId, status: from }, { $set: { status, statusReason: reason } })
      .exec();
    if (result.modifiedCount === 0) {
      this.logger.warn(`[AccessRequest] ${requestId} not closed as ${status}: it is not ${from}`);
      return false;
    }
    this.eventEmitter.emit<AccessRequestClosedPayload>(
      DomainEventType.ACCESS_REQUEST_CLOSED,
      requestId,
      { requestId, status, reason },
      { actor: 'system' },
    );
    this.logger.log(`[AccessRequest] ${requestId} closed as ${status}: ${reason}`);
    return true;
  }
}
