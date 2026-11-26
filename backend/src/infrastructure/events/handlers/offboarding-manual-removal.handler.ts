import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import type { OffboardingTargetRemovedManuallyPayload } from '../event-payloads';
import { IdentityService } from '../../../modules/identity/identity.service';
import { withTenantContext } from '../../multi-tenancy/tenant-context.helper';

/** Why the Golden Record is deleted when an admin closes the last failed target by hand. */
export const MANUAL_COMPLETION_REASON = 'offboarding completed: failed targets removed manually';

/**
 * Identity side of an admin closing a failed offboarding target by hand (Leavers page): the
 * target's provisioning entry becomes DEPROVISIONED, and when no target of that offboarding is
 * left failed the Golden Record is soft-deleted through the same markAsDeleted (and
 * identity.deleted audit) a fully successful offboarding uses, with the admin as actor.
 * Called through emitAndWait, so a failure reaches the admin's request.
 */
@Injectable()
export class OffboardingManualRemovalHandler {
  private readonly logger = new Logger(OffboardingManualRemovalHandler.name);

  constructor(private readonly identityService: IdentityService) {}

  // No `async: true`: called through emitAndWait, which needs the handler's result.
  @OnEvent(DomainEventType.IDENTITY_OFFBOARDING_TARGET_REMOVED_MANUALLY)
  async handleTargetRemovedManually(
    event: DomainEvent<OffboardingTargetRemovedManuallyPayload>,
  ): Promise<'deleted' | 'suspended'> {
    const tenantId = event.metadata.tenantId;
    if (!tenantId) throw new Error(`${event.type} without a tenant: identity not updated`);
    const { identityId, system, offboardingComplete } = event.payload;
    return withTenantContext(tenantId, async () => {
      await this.identityService.updateProvisioningState(identityId, system, 'DEPROVISIONED');
      if (!offboardingComplete) return 'suspended';
      await this.identityService.markAsDeleted(identityId, {
        actor: event.metadata.actor,
        reason: MANUAL_COMPLETION_REASON,
      });
      this.logger.log(`Identity ${identityId}: last failed target closed by hand, deleted`);
      return 'deleted';
    });
  }
}
