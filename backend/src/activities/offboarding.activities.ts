import { Injectable, Logger } from '@nestjs/common';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { OffboardingCompletedPayload } from '@infrastructure/events/event-payloads';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import type { OffboardingResult } from '@shared/types/deprovision';
import { maskPersonalData } from './deprovision-failure';

/** Longest failure reason kept on the timeline and the Leavers page. */
const MAX_REASON_LENGTH = 500;

/**
 * Temporal activity: publish an offboarding's per-system result (and what became of the person's
 * linked admin accounts) as IDENTITY_OFFBOARDING_COMPLETED. The identity timeline and the Leavers
 * history read it from there (and the audit log keeps it).
 */
@Injectable()
export class OffboardingActivities {
  private readonly logger = new Logger(OffboardingActivities.name);

  constructor(private readonly eventEmitter: DomainEventEmitterService) {}

  async recordOffboardingOutcome(
    result: OffboardingResult,
    tenantId?: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    await withTenantContext(
      tenantId ?? '',
      async () => {
        const masked = (reason: string) => maskPersonalData(reason).slice(0, MAX_REASON_LENGTH);
        const payload: OffboardingCompletedPayload = {
          ...result,
          systems: result.systems.map((s) => (s.reason ? { ...s, reason: masked(s.reason) } : s)),
          ...(result.linkedAdmins
            ? {
                linkedAdmins: result.linkedAdmins.map((a) =>
                  a.reason ? { ...a, reason: masked(a.reason) } : a,
                ),
              }
            : {}),
        };
        this.eventEmitter.emit<OffboardingCompletedPayload>(
          DomainEventType.IDENTITY_OFFBOARDING_COMPLETED,
          result.identityId,
          payload,
          { tenantId, actor: 'offboarding-workflow' },
        );
        this.logger.log(
          `Offboarding ${result.workflowId}: ${result.status}, Golden Record ${result.hubStatus}`,
        );
      },
      { correlationId },
    );
  }
}
