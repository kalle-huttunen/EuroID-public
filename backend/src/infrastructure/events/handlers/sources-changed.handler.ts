import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import { IdentityService } from '../../../modules/identity/identity.service';
import { OnboardingService } from '../../../modules/onboarding/onboarding.service';
import { withTenantContext } from '../../multi-tenancy/tenant-context.helper';
import {
  JoinerEvent,
  type JoinerEventDocument,
} from '../../../modules/joiners/schemas/joiner-event.schema';
import { hasOpenJoiner } from '../../../modules/joiners/open-joiner';

/** identity.sources_changed */
export interface IdentitySourcesChangedPayload {
  identityId: string;
  newSourceName: string;
  totalSourceCount: number;
  contractType: string;
}

/**
 * Fire-and-forget: When a new source is added to an identity, enqueue onboarding workflow.
 * No policy evaluation or delta computation here — provisioning logic lives in the workflow.
 * Keeps event handlers as notification/audit layers only to prevent circularity.
 * None starts for an open HR joiner (hasOpenJoiner): the joiner flow starts its onboarding when
 * its rules allow (start date, HR leaver, mass-joiner limit). The workflow provisions only while
 * the pipeline is DEPLOYED, whatever started it.
 */
@Injectable()
export class SourcesChangedHandler {
  private readonly logger = new Logger(SourcesChangedHandler.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly onboardingService: OnboardingService,
    // Read only: an open HR joiner's onboarding is the joiner flow's (hasOpenJoiner)
    @InjectModel(JoinerEvent.name) private readonly joinerEventModel: Model<JoinerEventDocument>,
  ) {}

  @OnEvent(DomainEventType.IDENTITY_SOURCES_CHANGED, { async: true })
  async handleSourcesChanged(event: DomainEvent<IdentitySourcesChangedPayload>): Promise<void> {
    const depth = event.metadata?.depth ?? 0;
    if (depth > 0) {
      this.logger.debug(`[SourcesChanged] Skipping depth=${depth} (prevent circular provisioning)`);
      return;
    }

    const { identityId, newSourceName } = event.payload;
    const tenantId = event.metadata?.tenantId;
    if (!tenantId) {
      this.logger.warn(`[SourcesChanged] Event for ${identityId} missing tenantId, skipping`);
      return;
    }

    try {
      await withTenantContext(tenantId, async () => {
        const identity = await this.identityService.findIdentityById(identityId);
        if (!identity?.profile?.email) {
          this.logger.warn(`[SourcesChanged] Identity ${identityId} has no email, skipping`);
          return;
        }
        if (await hasOpenJoiner(this.joinerEventModel, tenantId, identityId)) {
          this.logger.log(
            `[SourcesChanged] Identity ${identityId} is an open HR joiner: the joiner flow starts it`,
          );
          return;
        }
        this.logger.log(
          `[SourcesChanged] Identity ${identityId}: new source ${newSourceName}, enqueueing onboarding`,
        );
        await this.onboardingService.triggerOnboarding({
          identityId,
          email: identity.profile!.email,
        });
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[SourcesChanged] Failed to enqueue onboarding for ${identityId}: ${msg}`);
    }
  }
}
