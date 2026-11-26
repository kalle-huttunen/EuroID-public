/**
 * Scheduled Sync Activities
 *
 * Wraps SyncSchedulerService.executeSync for Temporal workflow execution.
 * Runs with tenant context so connector config and ingestion are tenant-scoped.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SyncSchedulerService } from '../modules/connectors/sync-scheduler.service';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import type { ScheduledSyncInput, ScheduledSyncResult } from '../workflows/scheduled-sync.workflow';

@Injectable()
export class ScheduledSyncActivities {
  private readonly logger = new Logger(ScheduledSyncActivities.name);

  constructor(private readonly syncScheduler: SyncSchedulerService) {}

  async runScheduledSync(input: ScheduledSyncInput): Promise<ScheduledSyncResult> {
    validateActivityContext({ tenantId: input.tenantId, correlationId: input.correlationId });
    return withTenantContext(
      input.tenantId,
      async () => {
        this.logger.log(
          `[ScheduledSync] Running ${input.connectorName} for tenant ${input.tenantId}`,
        );
        const result = await this.syncScheduler.executeSync(input.tenantId, input.connectorName);
        return {
          success: result.success,
          connectorName: input.connectorName,
          tenantId: input.tenantId,
          type: result.type,
          count: result.count,
          error: result.error,
        };
      },
      { correlationId: input.correlationId },
    );
  }
}
