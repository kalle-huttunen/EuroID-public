import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import type { OffboardingCompletedPayload } from '../event-payloads';
import { withTenantContext } from '../../multi-tenancy/tenant-context.helper';
import { ReviewExclusionService } from '../../../modules/policy/review-exclusion.service';

/**
 * Ends an offboarded identity's access review exclusions when its offboarding has run
 * (IDENTITY_OFFBOARDING_COMPLETED, also with failed targets: the employment ended either way).
 * They judged that employment; a rehire is evaluated afresh. Each is lifted by the system with
 * the reason "identity offboarded" and audited (ReviewExclusionService.endForOffboarding). A
 * failure is left to HandlerFailureCaptureService (dead-letter, retryable from there).
 * Registered by PolicyModule.
 */
@Injectable()
export class ReviewExclusionOffboardingHandler {
  private readonly logger = new Logger(ReviewExclusionOffboardingHandler.name);

  constructor(private readonly exclusions: ReviewExclusionService) {}

  @OnEvent(DomainEventType.IDENTITY_OFFBOARDING_COMPLETED, { async: true })
  async handleOffboardingCompleted(event: DomainEvent<OffboardingCompletedPayload>): Promise<void> {
    const tenantId = event.metadata?.tenantId;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, review exclusions kept`);
      return;
    }
    const { identityId } = event.payload;
    const ended = await withTenantContext(tenantId, () =>
      this.exclusions.endForOffboarding(identityId, tenantId),
    );
    if (ended > 0) {
      this.logger.log(`Identity ${identityId} offboarded: ${ended} review exclusion(s) ended`);
    }
  }
}
