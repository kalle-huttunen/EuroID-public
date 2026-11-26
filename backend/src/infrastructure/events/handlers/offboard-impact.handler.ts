import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import { IdentityOffboardImpactQueryPayload } from '../event-payloads';
import { AccessRequestsService } from '../../../modules/access-requests/access-requests.service';
import type { AccessRequestDocument } from '../../../modules/access-requests/schemas/access-request.schema';

/**
 * Handles IDENTITY_OFFBOARD_IMPACT_QUERY (from GET /identity/:id/offboard-impact).
 * Returns active access requests for the identity so the controller can build the impact preview.
 */
@Injectable()
export class OffboardImpactEventHandler {
  constructor(private readonly accessRequestsService: AccessRequestsService) {}

  // No `async: true`: called through emitAndWait, and EventEmitter2 would then return a
  // setImmediate handle instead of this result. suppressErrors: false lets a failure reach the
  // HTTP caller as an error, so the preview cannot mistake it for "no impact".
  @OnEvent(DomainEventType.IDENTITY_OFFBOARD_IMPACT_QUERY, { suppressErrors: false })
  async handleOffboardImpactQuery(
    event: DomainEvent<IdentityOffboardImpactQueryPayload>,
  ): Promise<AccessRequestDocument[]> {
    return this.accessRequestsService.findActiveRequestsForIdentity(event.payload.identityId);
  }
}
