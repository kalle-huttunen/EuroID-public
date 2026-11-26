/**
 * Bulk Provisioning Service
 *
 * Service for managing bulk user provisioning operations via Temporal workflows.
 * Handles workflow initiation, status tracking, and result retrieval.
 * Uses shared Temporal client from TemporalClientProvider.
 */

import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Client, WorkflowHandle } from '@temporalio/client';
import { bulkProvisioningWorkflow } from '../../workflows/bulk-provisioning.workflow';
import { DEFAULT_PROVISIONING_QUEUE } from '@infrastructure/temporal/task-queue.config';
import { BulkOperationRequest, BulkOperationResult } from '@shared/dtos/bulk-operation.dto';
import { AuditService } from '../audit/audit.service';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { getTenantWorkflow } from '@infrastructure/temporal/tenant-workflow';
import { redactBulkResults } from './bulk-result-redaction';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { nationalIdRule, takeNationalId } from '../identity/national-id';

/** Initiators recorded by batches started before the caller's principal was recorded. */
const UNRECORDED_INITIATORS = new Set(['admin', 'BulkProvisioningService']);

@Injectable()
export class BulkProvisioningService {
  private readonly logger = new Logger(BulkProvisioningService.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly temporalClientProvider: TemporalClientProvider,
    private readonly correlationConfig: CorrelationConfigService,
    private readonly correlationHash: CorrelationHashService,
  ) {}

  private getClient(): Client {
    return this.temporalClientProvider.getClient();
  }

  /**
   * Get Temporal client (for direct access). Throws if not connected.
   */
  getTemporalClient(): Client {
    return this.getClient();
  }

  /**
   * Start a bulk provisioning workflow. The users' national IDs never reach its input
   * (takeNationalIds).
   */
  async startBulkProvisioning(received: BulkOperationRequest): Promise<string> {
    const client = this.getClient();
    const request = await this.takeNationalIds(received);
    const tenantId = request.tenantId ?? '';
    this.logger.log(
      `Starting bulk provisioning workflow: ${request.batchId} (${request.operations.length} operations)`,
    );

    const workflowId = `t-${tenantId || 'default'}-bulk-${request.batchId}-${Date.now()}`;

    try {
      await client.workflow.start(bulkProvisioningWorkflow, {
        taskQueue: DEFAULT_PROVISIONING_QUEUE,
        workflowId,
        args: [request],
        searchAttributes: {
          TenantId: [tenantId || 'default'],
        },
        memo: {
          triggeredBy: request.initiatedBy || 'BulkProvisioningService',
          targetDescription: `Batch ${request.batchId}: ${request.operations.length} operations`,
        },
        // Workflow options
        workflowExecutionTimeout: '6 hours', // Max time for entire workflow
        workflowRunTimeout: '6 hours',
        workflowTaskTimeout: '10 seconds',
      });

      this.logger.log(`Started Bulk Provisioning Workflow: ${workflowId}`);

      this.auditService.logFireAndForget({
        action: 'BULK_OPERATION_STARTED',
        severity: 'info',
        actor: request.initiatedBy || 'admin',
        resourceType: 'workflow',
        resourceId: workflowId,
        resourceName: `Bulk Batch ${request.batchId}`,
        description: `Bulk provisioning started: ${request.operations.length} operations`,
        payload: {
          metadata: {
            batchId: request.batchId,
            operationCount: request.operations.length,
            dryRun: request.dryRun,
          },
        },
        tenantId: request.tenantId || 'default',
      });

      return workflowId;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to start bulk provisioning workflow: ${message}`, stack);
      throw error;
    }
  }

  /**
   * The request with each user's national ID taken out (identity/national-id.ts takeNationalId),
   * so the workflow input, which the Temporal history keeps, holds none: the tenant's Hashed
   * National ID field and `hetu` are removed, and with the rule and CORRELATION_HMAC_SECRET their
   * hash goes in the user's `nationalIdHash` (null without one), which the Hub save matches on
   * (activities/bulk-provisioning-hub.ts). A `correlationId` or `nationalIdHash` the body brings is
   * always dropped: only a hash computed here is matched on, also when the rule is added while
   * the batch runs. The settings are read strictly (CorrelationConfigUnavailableError: nothing
   * starts). The caller's request is left as it is.
   */
  private async takeNationalIds(request: BulkOperationRequest): Promise<BulkOperationRequest> {
    const tenantId = request.tenantId ?? '';
    const config = await this.correlationConfig.getCorrelationConfig(tenantId, { strict: true });
    const rule = nationalIdRule(config);
    const hash = (value: string) => this.correlationHash.hash(value, tenantId);
    const operations = request.operations.map((op) => {
      const user = { ...op.user } as Record<string, unknown>;
      delete user.correlationId;
      delete user.nationalIdHash;
      user.nationalIdHash = takeNationalId(user, rule, hash);
      return { ...op, user: user as unknown as typeof op.user };
    });
    return { ...request, operations };
  }

  /**
   * Handle of a workflow of the caller's tenant; another tenant's id is a 404 (getTenantWorkflow).
   */
  async getWorkflowHandle(workflowId: string): Promise<WorkflowHandle> {
    return (await getTenantWorkflow(this.getClient(), workflowId)).handle;
  }

  /**
   * Get workflow status and progress
   */
  async getWorkflowStatus(workflowId: string) {
    try {
      const { handle, description } = await getTenantWorkflow(this.getClient(), workflowId);

      // Query current phase
      let currentPhase = 'UNKNOWN';
      try {
        currentPhase = await handle.query('getCurrentPhase');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Could not query phase for workflow ${workflowId}: ${message}`);
      }

      // Query progress
      let progress = null;
      try {
        progress = await handle.query('getProgress');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Could not query progress for workflow ${workflowId}: ${message}`);
      }

      return {
        workflowId,
        status: description.status.name, // RUNNING, COMPLETED, FAILED, etc.
        currentPhase,
        progress,
        startTime: description.startTime,
        closeTime: description.closeTime,
        historyLength: description.historyLength,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to get workflow status for ${workflowId}: ${message}`);
      throw error;
    }
  }

  /**
   * Get workflow results (when completed), without pre-change snapshot values and with PII masked
   */
  async getWorkflowResults(workflowId: string): Promise<BulkOperationResult> {
    try {
      const handle = await this.getWorkflowHandle(workflowId);
      const result = await handle.result();
      return redactBulkResults(result as BulkOperationResult);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to get workflow results for ${workflowId}: ${message}`);
      throw error;
    }
  }

  /**
   * Get partial results (while workflow is running), redacted like getWorkflowResults
   */
  async getPartialResults(workflowId: string) {
    try {
      const handle = await this.getWorkflowHandle(workflowId);

      let results: unknown[] = [];
      try {
        const raw = await handle.query('getResults');
        results = Array.isArray(raw) ? redactBulkResults(raw) : [];
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Could not query results for workflow ${workflowId}: ${message}`);
      }

      return results;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to get partial results for ${workflowId}: ${message}`);
      throw error;
    }
  }

  /**
   * Signal workflow to approve deletes, only while it waits for that approval (409 otherwise: a
   * finished batch, or one not at its deletes yet).
   * SoD: Rejects if approver is the same person who initiated the batch (their email, else their
   * principal id; compared without case). A batch started before the initiator was recorded so
   * (no initiator, or the placeholders 'admin' and 'BulkProvisioningService') cannot be checked.
   */
  async approveDeletes(workflowId: string, approvedBy: string): Promise<void> {
    try {
      const { handle, description } = await getTenantWorkflow(this.getClient(), workflowId);
      const rawTriggeredBy = description.memo?.triggeredBy;
      const triggeredBy = rawTriggeredBy != null ? String(rawTriggeredBy) : '';

      // SoD check: approver must not be the same person who started the batch
      if (triggeredBy && triggeredBy.toLowerCase() === approvedBy.toLowerCase()) {
        throw new ForbiddenException(
          'Segregation of Duties: The person who initiated a bulk operation cannot approve its deletes.',
        );
      }
      if (!triggeredBy || UNRECORDED_INITIATORS.has(triggeredBy)) {
        this.logger.warn(
          `Workflow ${workflowId} has no recorded initiator (${triggeredBy || 'missing'}), allowing approval for legacy workflows`,
        );
      }

      const status = description.status?.name;
      if (status !== 'RUNNING') {
        throw new ConflictException(
          `The batch is not running (${status ?? 'unknown'}): there are no deletes to approve.`,
        );
      }
      const phase = await handle.query<string>('getCurrentPhase');
      if (phase !== 'AWAITING_DELETE_APPROVAL') {
        throw new ConflictException(
          `The batch is not waiting for delete approval (phase ${phase}): approve when it is.`,
        );
      }

      await handle.signal('approveDeletes');
      this.logger.log(
        `Sent delete approval signal to workflow ${workflowId} (approvedBy: ${approvedBy})`,
      );

      const ctx = getRequestContext();
      this.auditService.logFireAndForget({
        action: 'BULK_DELETES_APPROVED',
        severity: 'warning',
        actor: approvedBy,
        resourceType: 'workflow',
        resourceId: workflowId,
        resourceName: 'Bulk Delete Approval',
        description: `Delete operations approved for workflow ${workflowId}`,
        payload: { metadata: { approvedBy, initiatedBy: triggeredBy } },
        tenantId: ctx?.tenantId ?? 'default',
      });
    } catch (error: unknown) {
      if (error instanceof ForbiddenException || error instanceof ConflictException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send approval signal to ${workflowId}: ${message}`);
      throw error;
    }
  }

  /**
   * Cancel a running batch: the cancel signal, which the workflow reads before its next batch or
   * delete; it then compensates what it changed and ends CANCELLED with its results
   * (bulk-provisioning:cancel-compensates). The run is never terminated: that left an operation
   * half done and lost the results. 409 for a batch that is not running.
   */
  async cancelWorkflow(workflowId: string, cancelledBy?: string): Promise<void> {
    try {
      const { handle, description } = await getTenantWorkflow(this.getClient(), workflowId);
      const status = description.status?.name;
      if (status !== 'RUNNING') {
        throw new ConflictException(
          `The batch is not running (${status ?? 'unknown'}): there is nothing to cancel.`,
        );
      }

      await handle.signal('cancelWorkflow');

      this.logger.log(`Cancelled workflow ${workflowId} (cancelledBy: ${cancelledBy})`);

      const cancelCtx = getRequestContext();
      this.auditService.logFireAndForget({
        action: 'BULK_OPERATION_CANCELLED',
        severity: 'warning',
        actor: cancelledBy || 'unknown',
        resourceType: 'workflow',
        resourceId: workflowId,
        resourceName: 'Bulk Operation Cancellation',
        description: `Workflow ${workflowId} cancelled`,
        payload: { metadata: { cancelledBy } },
        tenantId: cancelCtx?.tenantId ?? 'default',
      });
    } catch (error: unknown) {
      if (error instanceof ConflictException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to cancel workflow ${workflowId}: ${message}`);
      throw error;
    }
  }
}
