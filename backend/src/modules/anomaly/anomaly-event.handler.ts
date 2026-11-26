/**
 * Anomaly Event Handler
 *
 * Listens to provisioning.completed and drift.detected to trigger
 * targeted anomaly analysis for the affected identity.
 */

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '@infrastructure/events/event-types';
import { DomainEvent } from '@infrastructure/events/domain-event.interface';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { AccessAnomalyService } from './anomaly.service';

@Injectable()
export class AnomalyEventHandler {
  private readonly logger = new Logger(AnomalyEventHandler.name);

  constructor(private readonly anomalyService: AccessAnomalyService) {}

  @OnEvent(DomainEventType.PROVISIONING_COMPLETED, { async: true })
  async handleProvisioningCompleted(event: DomainEvent): Promise<void> {
    // Without an identity id the event goes under its connector: nothing to analyse
    const identityId = (event.payload as Record<string, unknown>)?.identityId;
    const tenantId = event.metadata?.tenantId;
    if (!identityId || typeof identityId !== 'string') return;
    if (!tenantId) {
      this.logger.warn('[Anomaly] PROVISIONING_COMPLETED missing tenantId, skipping');
      return;
    }
    try {
      await withTenantContext(tenantId, () => this.anomalyService.runAnalysis({ identityId }));
      this.logger.debug('Triggered anomaly analysis after provisioning');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Anomaly analysis after provisioning failed: ${message}`);
    }
  }

  @OnEvent(DomainEventType.DRIFT_DETECTED, { async: true })
  async handleDriftDetected(event: DomainEvent): Promise<void> {
    const identityId = (event.payload as Record<string, unknown>)?.identityId ?? event.aggregateId;
    const tenantId = event.metadata?.tenantId;
    if (!identityId || typeof identityId !== 'string') return;
    if (!tenantId) {
      this.logger.warn('[Anomaly] DRIFT_DETECTED missing tenantId, skipping');
      return;
    }
    try {
      await withTenantContext(tenantId, () => this.anomalyService.runAnalysis({ identityId }));
      this.logger.debug('Triggered anomaly analysis after drift detected');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Anomaly analysis after drift failed: ${message}`);
    }
  }
}
