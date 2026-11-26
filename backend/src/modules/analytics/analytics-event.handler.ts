/**
 * Analytics Event Handler
 *
 * Listens to identity.updated and identity.created to invalidate
 * stale pre-computed offboarding cache. Listens to provisioning.completed
 * for license count cache updates (no-op for now; refresh on demand).
 */

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '@infrastructure/events/event-types';
import { DomainEvent } from '@infrastructure/events/domain-event.interface';
import { IdentityUpdatedPayload } from '@infrastructure/events/event-payloads';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { PredictiveAnalyticsService } from './analytics.service';

@Injectable()
export class AnalyticsEventHandler {
  private readonly logger = new Logger(AnalyticsEventHandler.name);

  constructor(private readonly analyticsService: PredictiveAnalyticsService) {}

  @OnEvent(DomainEventType.IDENTITY_UPDATED, { async: true })
  async handleIdentityUpdated(event: DomainEvent<IdentityUpdatedPayload>): Promise<void> {
    const identityId = event.payload?.identityId ?? event.aggregateId;
    const tenantId = event.metadata?.tenantId;
    const changedFields = event.payload?.changedFields ?? [];

    if (!(changedFields.includes('endDate') || changedFields.includes('profile.endDate'))) return;
    if (!tenantId) {
      this.logger.warn('[Analytics] IDENTITY_UPDATED missing tenantId, skipping cache invalidation');
      return;
    }
    try {
      await withTenantContext(tenantId, () =>
        this.analyticsService.markOffboardingStale(identityId),
      );
      this.logger.debug('Invalidated offboarding cache (endDate changed)');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Analytics event handler failed: ${message}`);
    }
  }

  @OnEvent(DomainEventType.IDENTITY_CREATED, { async: true })
  async handleIdentityCreated(event: DomainEvent): Promise<void> {
    try {
      // New identity may have endDate - no need to invalidate existing cache
      // License count will be updated on next provisioning.completed
      this.logger.debug(`Identity created: ${event.aggregateId}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Analytics event handler failed: ${message}`);
    }
  }

  @OnEvent(DomainEventType.PROVISIONING_COMPLETED, { async: true })
  async handleProvisioningCompleted(event: DomainEvent): Promise<void> {
    try {
      // License operations: cache could be updated, but we compute on-demand for forecasts
      // No invalidation needed - forecasts use audit history
      this.logger.debug(`Provisioning completed for ${event.aggregateId}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Analytics event handler failed: ${message}`);
    }
  }
}
