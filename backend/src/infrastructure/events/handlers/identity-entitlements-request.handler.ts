import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import type {
  IdentityEntitlementsQueryPayload,
  IdentityEntitlementsQueryResult,
} from '../event-payloads';
import { AccessRequestsService } from '../../../modules/access-requests/access-requests.service';

/**
 * Handles IDENTITY_ENTITLEMENTS_QUERY (from GET /identity/:id/entitlements).
 * Returns the entitlements granted to the identity through access requests that are
 * active or still provisioning (tenant-scoped by AccessRequestsService), each with the end of a
 * time-bound request's access (the granted expiresAt, else the requested one).
 */
@Injectable()
export class IdentityEntitlementsRequestHandler {
  constructor(private readonly accessRequestsService: AccessRequestsService) {}

  // No `async: true`: EventEmitter2 would then return a setImmediate handle instead of this
  // result to emitAndWait. suppressErrors: false lets a failure reach the HTTP caller.
  @OnEvent(DomainEventType.IDENTITY_ENTITLEMENTS_QUERY, { suppressErrors: false })
  async handleEntitlementsQuery(
    event: DomainEvent<IdentityEntitlementsQueryPayload>,
  ): Promise<IdentityEntitlementsQueryResult> {
    const requests = await this.accessRequestsService.findActiveRequestsForIdentity(
      event.payload.identityId,
    );
    const grants = requests.flatMap((request) => {
      const expiresAt = request.expiresAt ?? request.timeConstraint?.expiresAt;
      return (request.entitlements ?? []).map((e) => ({
        grantedBy: 'request' as const,
        entitlement: e.entitlementName,
        type: (e.entitlementType ?? 'Group').toLowerCase(),
        targetSystem: e.system,
        source: `Access request ${request.requestId}`,
        requestStatus: request.status,
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      }));
    });
    return { kind: 'identity-entitlements', grants };
  }
}
