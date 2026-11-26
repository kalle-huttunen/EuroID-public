import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import { UserEventService } from '../../../modules/identity/user-event.service';
import { withTenantContext } from '../../multi-tenancy/tenant-context.helper';
import type {
  LeaverDetectedPayload,
  LeaverOffboardingStartedPayload,
  LeaverReason,
} from '../event-payloads';

const REASON_TEXT: Record<LeaverReason, string> = {
  terminated: 'terminated in HR',
  'end-date': 'employment end date passed',
  'missing-from-source': 'missing from the HR feed',
};

/**
 * Puts HR leaver events on the identity timeline: the detection (and whether it waits for a
 * mass-leaver approval) and the offboarding workflow it started.
 */
@Injectable()
export class LeaverTimelineHandler {
  private readonly logger = new Logger(LeaverTimelineHandler.name);

  constructor(private readonly userEventService: UserEventService) {}

  @OnEvent(DomainEventType.LEAVER_DETECTED, { async: true })
  async handleLeaverDetected(event: DomainEvent<LeaverDetectedPayload>): Promise<void> {
    const { reason, sourceName, effectiveDate, paused, batchId, leaverEventId } = event.payload;
    await this.record(event, {
      type: 'LEAVER_DETECTED',
      severity: 'warning',
      title: `Leaver detected: ${REASON_TEXT[reason]}`,
      description: paused
        ? `Found by the ${sourceName} sync. Waiting for approval: the sync exceeded the mass-leaver limit.`
        : `Found by the ${sourceName} sync. Offboarding starts automatically.`,
      targetSystem: sourceName,
      metadata: { reason, sourceName, effectiveDate, paused, batchId, leaverEventId },
    });
  }

  @OnEvent(DomainEventType.LEAVER_OFFBOARDING_STARTED, { async: true })
  async handleOffboardingStarted(
    event: DomainEvent<LeaverOffboardingStartedPayload>,
  ): Promise<void> {
    const { reason, workflowId, batchId, leaverEventId } = event.payload;
    await this.record(event, {
      type: 'WORKFLOW_STARTED',
      severity: 'info',
      title: 'Offboarding started',
      description: `Leaver: ${REASON_TEXT[reason]}${batchId ? ' (mass-leaver batch approved)' : ''}`,
      metadata: { reason, workflowId, batchId, leaverEventId, workflow: 'offboarding' },
    });
  }

  private async record(
    event: DomainEvent<{ identityId: string }>,
    entry: {
      type: 'LEAVER_DETECTED' | 'WORKFLOW_STARTED';
      severity: 'warning' | 'info';
      title: string;
      description: string;
      targetSystem?: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    const tenantId = event.metadata.tenantId;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, skipping timeline`);
      return;
    }
    try {
      await withTenantContext(tenantId, () =>
        this.userEventService.recordEvent({
          userId: event.payload.identityId,
          actor: event.metadata.actor,
          ...entry,
        }),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to record ${event.type} timeline for ${event.aggregateId}: ${message}`,
      );
    }
  }
}
