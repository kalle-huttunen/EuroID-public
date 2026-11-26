/**
 * Audit Archive Activities
 *
 * Temporal activities for exporting Merkle-checkpointed audit events
 * to S3 with Object Lock (WORM compliance). The daily run also creates the tenants' Merkle
 * checkpoints over the audit events written since their last one and, once per tenant, the legacy
 * checkpoints over the events written before hash version 2, so those are archived too.
 */

import { Injectable, Logger } from '@nestjs/common';
import { AuditArchiveService } from '../modules/audit/audit-archive.service';
import { AuditMerkleService } from '../modules/audit/audit-merkle.service';
import { TenantService } from '../infrastructure/multi-tenancy/tenant.service';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';

@Injectable()
export class AuditArchiveActivities {
  private readonly logger = new Logger(AuditArchiveActivities.name);

  constructor(
    private readonly auditArchiveService: AuditArchiveService,
    private readonly tenantService: TenantService,
    private readonly auditMerkleService: AuditMerkleService,
  ) {}

  /**
   * Checkpoint each tenant's audit events written since its last checkpoint, then get the
   * unarchived checkpoints across all tenants (or a specific tenant). The new checkpoints are
   * archived by a later run, once settled (older than 24 hours). A retry makes no second
   * checkpoint over the same events.
   */
  async getUnarchivedCheckpoints(
    tenantId: string,
  ): Promise<Array<{ _id: string; checkpointId: string; tenantId: string }>> {
    const tenants = tenantId ? [{ tenantId }] : await this.tenantService.findAll();

    const results: Array<{ _id: string; checkpointId: string; tenantId: string }> = [];

    for (const t of tenants) {
      await this.checkpointTenant(t.tenantId);
      try {
        const checkpoints = await this.auditArchiveService.getUnarchivedCheckpoints(t.tenantId);
        for (const cp of checkpoints) {
          results.push({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose lean() returns POJO with _id as ObjectId
            _id: String((cp as any)._id),
            checkpointId: cp.checkpointId,
            tenantId: cp.tenantId,
          });
        }
      } catch (err) {
        this.logger.warn(
          `[AuditArchive] Failed to query tenant ${t.tenantId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return results;
  }

  /** A tenant whose checkpoints fail is logged; its earlier checkpoints are still archived. */
  private async checkpointTenant(tenantId: string): Promise<void> {
    try {
      const made = await withTenantContext(tenantId, () =>
        this.auditMerkleService.createPendingCheckpoints(tenantId),
      );
      if (made > 0) this.logger.log(`[AuditArchive] ${made} checkpoints created for ${tenantId}`);
    } catch (err) {
      this.logger.warn(
        `[AuditArchive] Failed to checkpoint tenant ${tenantId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Export a single checkpoint to S3 with Object Lock, in the checkpoint's tenant context: the
   * service reads and marks the checkpoint by its _id, which the tenant plugin refuses without one.
   */
  async exportCheckpoint(
    tenantId: string,
    merkleRootId: string,
  ): Promise<{ storagePath: string; eventCount: number }> {
    const result = await withTenantContext(tenantId, () =>
      this.auditArchiveService.exportToS3(tenantId, merkleRootId),
    );
    return {
      storagePath: result.storagePath,
      eventCount: result.eventCount,
    };
  }
}
