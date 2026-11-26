import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { DomainEvent } from '@infrastructure/events/domain-event.interface';
import type { HrSyncCompletedPayload } from '@infrastructure/events/event-payloads';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { JoinerSyncSummary } from '@shared/interfaces/joiner-sync';
import { JoinerDetectionService } from './joiner-detection.service';

/**
 * Runs HR joiner detection after each HR ingest (HR_SYNC_JOINERS_REQUESTED, emitted by
 * HrIngestionService after leaver and mover detection). The tenant is the one the event was
 * emitted in, i.e. the sync's own context.
 */
@Injectable()
export class JoinerSyncHandler {
  private readonly logger = new Logger(JoinerSyncHandler.name);

  constructor(private readonly detection: JoinerDetectionService) {}

  // No `async: true`: HrIngestionService waits for the summary through emitAndWait.
  @OnEvent(DomainEventType.HR_SYNC_JOINERS_REQUESTED)
  async handleJoinersRequested(
    event: DomainEvent<HrSyncCompletedPayload>,
  ): Promise<JoinerSyncSummary | undefined> {
    const tenantId = event.metadata?.tenantId;
    if (!tenantId) {
      this.logger.warn(`[Joiners] ${event.type} without a tenant, skipping joiner detection`);
      return undefined;
    }
    return withTenantContext(tenantId, () => this.detection.evaluateSync(tenantId, event.payload), {
      actor: event.metadata.actor,
      correlationId: event.metadata.correlationId,
    });
  }
}
