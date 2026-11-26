import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import { IdentityOffboardRequestedPayload } from '../event-payloads';
import { OffboardingService } from '../../../modules/offboarding/offboarding.service';
import { IdentityService } from '../../../modules/identity/identity.service';
import { withTenantContext } from '../../multi-tenancy/tenant-context.helper';

/**
 * Handles IDENTITY_OFFBOARD_REQUESTED (DELETE /identity/:id, or an HR leaver from LeaverExecutionService).
 * Triggers offboarding workflow and returns workflowId for controller response.
 */
@Injectable()
export class OffboardingEventHandler {
  private readonly logger = new Logger(OffboardingEventHandler.name);

  constructor(
    private readonly offboardingService: OffboardingService,
    private readonly identityService: IdentityService,
  ) {}

  // No `async: true`: called through emitAndWait, and EventEmitter2 would then return a
  // setImmediate handle instead of this result.
  @OnEvent(DomainEventType.IDENTITY_OFFBOARD_REQUESTED)
  async handleOffboardRequested(
    event: DomainEvent<IdentityOffboardRequestedPayload>,
  ): Promise<string | undefined> {
    const { userId, reason } = event.payload;
    const tenantId = event.metadata?.tenantId;

    try {
      const workflowId = await withTenantContext(tenantId ?? '', async () => {
        // The event carries no email: the workflow input takes the one stored now
        const identity = await this.identityService.findIdentityById(userId);
        const userEmail = identity?.profile?.email;
        if (!userEmail) {
          this.logger.warn(`[Offboarding] Identity ${userId} not found or has no email, skipping`);
          return undefined;
        }
        return this.offboardingService.triggerOffboarding(userId, userEmail, reason);
      });
      if (workflowId) {
        this.logger.log(
          `[Offboarding] Triggered offboarding for ${userId}, workflowId: ${workflowId}`,
        );
      }
      return workflowId;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[Offboarding] Failed to trigger offboarding for ${userId}: ${msg}`);
      throw error;
    }
  }
}
