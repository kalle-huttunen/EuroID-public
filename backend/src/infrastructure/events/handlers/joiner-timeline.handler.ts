import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import type {
  JoinerOnboardingStartedPayload,
  JoinerOnboardingWaitingPayload,
} from '../event-payloads';
import {
  UserEventService,
  type RecordEventDto,
} from '../../../modules/identity/user-event.service';
import { withTenantContext } from '../../multi-tenancy/tenant-context.helper';

/**
 * Puts an HR joiner's onboarding start on the identity timeline: "Onboarding started by HR sync",
 * with the source ("New in", or "Rehired in" for a rehire) and, for a mass-joiner batch member,
 * that the batch was approved; and "Onboarding waits: start date unreadable" once when the HR
 * start date is not a date. The actor is the event's (system:hr-sync, or the approving admin).
 * Written like the mover's "Access change started by HR sync"; the events carry no names or emails.
 */
@Injectable()
export class JoinerTimelineHandler {
  private readonly logger = new Logger(JoinerTimelineHandler.name);

  constructor(private readonly userEventService: UserEventService) {}

  @OnEvent(DomainEventType.JOINER_ONBOARDING_STARTED, { async: true })
  async handleOnboardingStarted(event: DomainEvent<JoinerOnboardingStartedPayload>): Promise<void> {
    const { identityId, joinerEventId, sourceName, workflowId, batchId, rehire } = event.payload;
    const joined = rehire ? `Rehired in the ${sourceName} sync` : `New in the ${sourceName} sync`;
    await this.record(event, {
      userId: identityId,
      actor: event.metadata.actor,
      type: 'WORKFLOW_STARTED',
      severity: 'info',
      title: 'Onboarding started by HR sync',
      description: batchId ? `${joined} (mass-joiner batch approved).` : `${joined}.`,
      targetSystem: sourceName,
      metadata: { workflow: 'onboarding', workflowId, sourceName, joinerEventId, batchId },
    });
  }

  /** "Onboarding waits": the HR sync does not onboard the joiner until its HR data is fixed. */
  @OnEvent(DomainEventType.JOINER_ONBOARDING_WAITING, { async: true })
  async handleOnboardingWaiting(event: DomainEvent<JoinerOnboardingWaitingPayload>): Promise<void> {
    const { identityId, joinerEventId, sourceName, reason } = event.payload;
    await this.record(event, {
      userId: identityId,
      actor: event.metadata.actor,
      type: 'USER_PROVISIONED',
      severity: 'warning',
      title: 'Onboarding waits: start date unreadable',
      description:
        `The start date in the ${sourceName} record is not a date, so the HR sync does not ` +
        'onboard this person. Correct it in HR (the next full sync then onboards on that date), ' +
        'or provision by hand.',
      targetSystem: sourceName,
      metadata: { workflow: 'onboarding', sourceName, joinerEventId, reason },
    });
  }

  private async record(event: DomainEvent<unknown>, entry: RecordEventDto): Promise<void> {
    const tenantId = event.metadata.tenantId;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, skipping timeline`);
      return;
    }
    try {
      await withTenantContext(tenantId, () => this.userEventService.recordEvent(entry));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to record joiner timeline for ${entry.userId}: ${message}`);
    }
  }
}
