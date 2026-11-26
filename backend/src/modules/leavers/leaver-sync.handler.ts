import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { DomainEvent } from '@infrastructure/events/domain-event.interface';
import type { HrSyncCompletedPayload } from '@infrastructure/events/event-payloads';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { LeaverSyncSummary } from '@shared/interfaces/leaver-sync';
import { LeaverDetectionService } from './leaver-detection.service';

/**
 * Runs leaver detection after each HR ingest (HR_SYNC_COMPLETED, emitted by HrIngestionService).
 * The tenant is the one the event was emitted in, i.e. the sync's own context.
 */
@Injectable()
export class LeaverSyncHandler {
  private readonly logger = new Logger(LeaverSyncHandler.name);

  constructor(private readonly detection: LeaverDetectionService) {}

  // No `async: true`: HrIngestionService waits for the summary through emitAndWait.
  @OnEvent(DomainEventType.HR_SYNC_COMPLETED)
  async handleHrSyncCompleted(
    event: DomainEvent<HrSyncCompletedPayload>,
  ): Promise<LeaverSyncSummary | undefined> {
    const tenantId = event.metadata?.tenantId;
    if (!tenantId) {
      this.logger.warn(`[Leavers] ${event.type} without a tenant, skipping leaver detection`);
      return undefined;
    }
    return withTenantContext(tenantId, () => this.detection.evaluateSync(tenantId, event.payload), {
      actor: event.metadata.actor,
      correlationId: event.metadata.correlationId,
    });
  }
}
