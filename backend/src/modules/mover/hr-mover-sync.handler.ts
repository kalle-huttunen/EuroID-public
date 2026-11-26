import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { DomainEvent } from '@infrastructure/events/domain-event.interface';
import type { HrSyncCompletedPayload } from '@infrastructure/events/event-payloads';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { MoverSyncSummary } from '@shared/interfaces/mover-sync';
import { HrMoverDetectionService } from './hr-mover-detection.service';

/**
 * Runs HR mover detection after each HR ingest (HR_SYNC_MOVERS_REQUESTED, emitted by
 * HrIngestionService once leaver detection answered HR_SYNC_COMPLETED). The tenant is the one
 * the event was emitted in, i.e. the sync's own context.
 */
@Injectable()
export class HrMoverSyncHandler {
  private readonly logger = new Logger(HrMoverSyncHandler.name);

  constructor(private readonly detection: HrMoverDetectionService) {}

  // No `async: true`: HrIngestionService waits for the summary through emitAndWait.
  @OnEvent(DomainEventType.HR_SYNC_MOVERS_REQUESTED)
  async handleMoversRequested(
    event: DomainEvent<HrSyncCompletedPayload>,
  ): Promise<MoverSyncSummary | undefined> {
    const tenantId = event.metadata?.tenantId;
    if (!tenantId) {
      this.logger.warn(`[HrMover] ${event.type} without a tenant, skipping mover detection`);
      return undefined;
    }
    return withTenantContext(tenantId, () => this.detection.evaluateSync(tenantId, event.payload), {
      actor: event.metadata.actor,
      correlationId: event.metadata.correlationId,
    });
  }
}
