import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import {
  IdentityCreatedPayload,
  IdentityUpdatedPayload,
  IdentityProvisionRequestedPayload,
} from '../event-payloads';
import { IdentityService } from '../../../modules/identity/identity.service';
import { OnboardingService } from '../../../modules/onboarding/onboarding.service';
import { withTenantContext } from '../../multi-tenancy/tenant-context.helper';
import { isProvisionedForMover, movedTriggerFields } from './mover.handler';
import { maskEmails } from '../../../activities/deprovision-failure';
import {
  JoinerEvent,
  type JoinerEventDocument,
} from '../../../modules/joiners/schemas/joiner-event.schema';
import { hasOpenJoiner } from '../../../modules/joiners/open-joiner';

const CRITICAL_FIELDS = ['departmentName', 'jobTitle', 'location', 'managerEmail'];

/** identity.correlated payload shape */
interface IdentityCorrelatedPayload {
  correlationRule: string;
  matchedBy: string;
  confidence: number;
  existingIdentityId?: string;
  incomingIdentityId?: string;
}

/**
 * Fire-and-forget: When identity is updated with critical fields or correlated via manual link,
 * enqueue onboarding workflow. No policy evaluation here — provisioning logic lives in the workflow.
 * Keeps event handlers as notification/audit layers only to prevent circularity.
 * An edit starts none for an open HR joiner (hasOpenJoiner): the joiner flow starts its onboarding
 * when its rules allow (start date, HR leaver, mass-joiner limit). The workflow provisions only
 * while the pipeline is DEPLOYED, whatever started it.
 */
@Injectable()
export class OnboardingEventHandler {
  private readonly logger = new Logger(OnboardingEventHandler.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly onboardingService: OnboardingService,
    // Read only: an open HR joiner's onboarding is the joiner flow's (hasOpenJoiner)
    @InjectModel(JoinerEvent.name) private readonly joinerEventModel: Model<JoinerEventDocument>,
  ) {}

  @OnEvent(DomainEventType.IDENTITY_CREATED, { async: true })
  async handleIdentityCreated(event: DomainEvent<IdentityCreatedPayload>): Promise<void> {
    const depth = event.metadata?.depth ?? 0;
    if (depth > 0) return;
    const { identityId } = event.payload;
    if (!event.payload.triggerWorkflow) return;

    const tenantId = event.metadata?.tenantId;
    if (!tenantId) {
      this.logger.warn(
        `[Onboarding] IDENTITY_CREATED for ${event.aggregateId} missing tenantId, skipping`,
      );
      return;
    }

    try {
      await withTenantContext(tenantId, async () => {
        // The event carries no email: the workflow reads the identity by the one stored now
        const identity = await this.identityService.findIdentityById(identityId);
        const email = identity?.profile?.email;
        if (!email) {
          this.logger.warn(`[Onboarding] Identity ${identityId} has no email, skipping`);
          return;
        }
        this.logger.log(
          `[Onboarding] Identity ${identityId} created with triggerWorkflow, enqueueing onboarding`,
        );
        await this.onboardingService.triggerOnboarding({ identityId, email });
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[Onboarding] Failed to enqueue onboarding for ${identityId}: ${maskEmails(msg)}`,
      );
    }
  }

  @OnEvent(DomainEventType.IDENTITY_UPDATED, { async: true })
  async handleIdentityUpdated(event: DomainEvent<IdentityUpdatedPayload>): Promise<void> {
    const depth = event.metadata?.depth ?? 0;
    if (depth > 0) {
      this.logger.debug(
        `[Onboarding] Skipping IDENTITY_UPDATED depth=${depth} (prevent circular provisioning)`,
      );
      return;
    }

    // PATCH /identity/:id?syncToEntra=true starts its run itself (the mover, else onboarding
    // through identity.provision_requested) and reports the outcome. Starting one here as well
    // collided with it on the workflow id, so the API could report a failed sync for a run that
    // started.
    if (event.payload.syncToEntra) {
      this.logger.debug(
        `[Onboarding] Skipping IDENTITY_UPDATED with syncToEntra (started by PATCH)`,
      );
      return;
    }

    const criticalFieldsChanged = event.payload.changedFields?.some((f) =>
      CRITICAL_FIELDS.includes(f),
    );
    if (!criticalFieldsChanged) return;

    // Mover guard: an edit that changed a trigger attribute's value (the event carries its
    // before-value) of an identity provisioned to a target system is the mover handler's.
    // Onboarding re-runs only for an identity that is not provisioned yet.
    const moved = movedTriggerFields(event.payload).length > 0;

    const identityId = event.payload.identityId;
    const tenantId = event.metadata?.tenantId;
    if (!tenantId) {
      this.logger.warn(
        `[Onboarding] IDENTITY_UPDATED for ${identityId} missing tenantId, skipping`,
      );
      return;
    }

    try {
      await withTenantContext(tenantId, async () => {
        // The event carries no email: the workflow reads the identity by the one stored now
        const identity = await this.identityService.findIdentityById(identityId);
        if (moved && isProvisionedForMover(identity)) {
          this.logger.debug(`[Onboarding] Skipping ${identityId}: deferring to the mover handler`);
          return;
        }
        const email = identity?.profile?.email;
        if (!email) {
          this.logger.warn(`[Onboarding] Identity ${identityId} has no email, skipping`);
          return;
        }
        if (await hasOpenJoiner(this.joinerEventModel, tenantId, identityId)) {
          this.logger.log(
            `[Onboarding] Identity ${identityId} is an open HR joiner: the joiner flow starts it`,
          );
          return;
        }
        this.logger.log(
          `[Onboarding] Identity ${identityId}: critical fields changed, enqueueing onboarding`,
        );
        await this.onboardingService.triggerOnboarding({ identityId, email });
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[Onboarding] Failed to enqueue onboarding for ${identityId}: ${maskEmails(msg)}`,
      );
    }
  }

  // No `async: true`: called through emitAndWait, and EventEmitter2 would then return a
  // setImmediate handle instead of this result. suppressErrors: false lets a failed start reach
  // the controller, which reports an onboarding run already in progress as such.
  @OnEvent(DomainEventType.IDENTITY_PROVISION_REQUESTED, { suppressErrors: false })
  async handleProvisionRequested(
    event: DomainEvent<IdentityProvisionRequestedPayload>,
  ): Promise<string | undefined> {
    const { syncToEntra, reason } = event.payload;
    // Every emitter names the identity as the aggregate (controller, joiners, identity-sync-run)
    const identityId = event.aggregateId;
    const tenantId = event.metadata?.tenantId;

    try {
      const workflowId = await withTenantContext(tenantId ?? '', async () => {
        // The event carries no email: the workflow reads the identity by the one stored now
        const identity = await this.identityService.findIdentityById(identityId);
        const email = identity?.profile?.email;
        if (!email) {
          this.logger.warn(`[Onboarding] Identity ${identityId} has no email, nothing started`);
          return undefined;
        }
        return this.onboardingService.triggerOnboarding(
          { identityId, email },
          syncToEntra || reason
            ? { ...(syncToEntra ? { syncToEntra: true } : {}), ...(reason ? { reason } : {}) }
            : undefined,
        );
      });
      return workflowId;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[Onboarding] Failed to trigger for ${identityId}: ${maskEmails(msg)}`);
      throw error;
    }
  }

  @OnEvent(DomainEventType.IDENTITY_CORRELATED, { async: true })
  async handleIdentityCorrelated(event: DomainEvent<IdentityCorrelatedPayload>): Promise<void> {
    const depth = event.metadata?.depth ?? 0;
    if (depth > 0) {
      this.logger.debug(
        `[Onboarding] Skipping IDENTITY_CORRELATED depth=${depth} (prevent circular provisioning)`,
      );
      return;
    }

    if (event.payload.correlationRule !== 'manual-link') return;

    const identityId = event.aggregateId;
    const tenantId = event.metadata?.tenantId;
    if (!tenantId) {
      this.logger.warn(
        `[Onboarding] IDENTITY_CORRELATED for ${identityId} missing tenantId, skipping`,
      );
      return;
    }

    try {
      await withTenantContext(tenantId, async () => {
        const identity = await this.identityService.findIdentityById(identityId);
        if (!identity?.profile?.email) {
          this.logger.warn(`[Onboarding] Identity ${identityId} has no email, skipping`);
          return;
        }
        this.logger.log(
          `[Onboarding] Identity ${identityId}: manual link completed, enqueueing onboarding`,
        );
        await this.onboardingService.triggerOnboarding({
          identityId,
          email: identity.profile!.email,
        });
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[Onboarding] Failed to enqueue onboarding for ${identityId}: ${maskEmails(msg)}`,
      );
    }
  }
}
