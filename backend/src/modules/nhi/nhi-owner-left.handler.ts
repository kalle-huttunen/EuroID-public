import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { DomainEvent } from '@infrastructure/events/domain-event.interface';
import type {
  IdentityDeletedPayload,
  OffboardingCompletedPayload,
} from '@infrastructure/events/event-payloads';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { NhiOwnershipService } from './nhi-ownership.service';

/**
 * An agent owner who leaves makes the owner's agents ownerless (NhiOwnershipService): when their
 * offboarding has run (IDENTITY_OFFBOARDING_COMPLETED, also with failed targets or the identity
 * only suspended: the employment ended), and when the identity is deleted from the hub any other
 * way (IDENTITY_DELETED). Offboarding sends both; the second marks nothing. A failure is left to
 * HandlerFailureCaptureService (dead-letter, retryable from there).
 */
@Injectable()
export class NhiOwnerLeftHandler {
  private readonly logger = new Logger(NhiOwnerLeftHandler.name);

  constructor(private readonly ownership: NhiOwnershipService) {}

  @OnEvent(DomainEventType.IDENTITY_OFFBOARDING_COMPLETED, { async: true })
  async onOffboardingCompleted(event: DomainEvent<OffboardingCompletedPayload>): Promise<void> {
    await this.ownerLeft(event.metadata?.tenantId, event.payload.identityId, event.type);
  }

  @OnEvent(DomainEventType.IDENTITY_DELETED, { async: true })
  async onIdentityDeleted(event: DomainEvent<IdentityDeletedPayload>): Promise<void> {
    await this.ownerLeft(event.metadata?.tenantId, event.payload.identityId, event.type);
  }

  private async ownerLeft(tenantId: string | undefined, identityId: string, type: string) {
    if (!tenantId) {
      this.logger.warn(`Event ${type} missing tenantId, agents of ${identityId} not checked`);
      return;
    }
    await withTenantContext(tenantId, () =>
      this.ownership.markOwnerless(tenantId, identityId, 'offboarded'),
    );
  }
}
