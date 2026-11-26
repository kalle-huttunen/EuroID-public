/**
 * Reconciliation Service
 *
 * Service for managing reconciliation workflows. Uses shared Temporal client from TemporalClientProvider.
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Client } from '@temporalio/client';
import { WorkflowIdConflictPolicy } from '@temporalio/common';
import {
  dailyReconciliationWorkflow,
  userReconciliationWorkflow,
} from '../../workflows/reconciliation.workflow';
import { distributedTransactionWorkflow } from '../../workflows/distributed-transaction.workflow';
import {
  ReconciliationConfig,
  DistributedTransactionRequest,
} from '@shared/dtos/distributed-transaction.dto';
import { DevToolsService } from '../dev-tools/dev-tools.service';
import { AuditService } from '../audit/audit.service';
import { DEFAULT_PROVISIONING_QUEUE } from '@infrastructure/temporal/task-queue.config';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { getTenantWorkflow } from '@infrastructure/temporal/tenant-workflow';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { nationalIdRule, takeNationalId } from '../identity/national-id';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly devToolsService: DevToolsService,
    private readonly auditService: AuditService,
    private readonly temporalClientProvider: TemporalClientProvider,
    private readonly correlationConfig: CorrelationConfigService,
    private readonly correlationHash: CorrelationHashService,
  ) {}

  private getClient(): Client {
    return this.temporalClientProvider.getClient();
  }

  /**
   * Start daily reconciliation workflow
   */
  async startDailyReconciliation(config: ReconciliationConfig): Promise<string> {
    // The request tenant decides: a config.tenantId from a caller is overwritten.
    const tenantId = getRequestContext()?.tenantId || 'default';
    const scopedConfig: ReconciliationConfig = { ...config, tenantId };
    const workflowId = `t-${tenantId}-daily-recon`;
    const client = this.getClient();
    this.logger.log(`Starting daily reconciliation: ${workflowId}`);

    await client.workflow.start(dailyReconciliationWorkflow, {
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      workflowId,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
      args: [scopedConfig],
      searchAttributes: {
        TenantId: [tenantId],
      },
      workflowExecutionTimeout: '12 hours',
      memo: {
        triggeredBy: 'ReconciliationService',
        targetDescription: `Daily recon: ${config.targetSystems.join(', ')}`,
      },
    });

    this.auditService.logFireAndForget({
      action: 'RECONCILIATION_RUN',
      severity: 'info',
      actor: 'ReconciliationService',
      resourceType: 'workflow',
      resourceId: workflowId,
      resourceName: 'Daily Reconciliation',
      description: `Daily reconciliation started for ${config.targetSystems.join(', ')}`,
      tenantId,
    });

    return workflowId;
  }

  /**
   * Start user-specific reconciliation
   */
  async startUserReconciliation(userId: string, targetSystems: string[]): Promise<string> {
    if (!userId?.trim()) {
      throw new BadRequestException('User ID is required');
    }
    const ctx = getRequestContext();
    const tenantId = ctx?.tenantId ?? '';
    const workflowId = `t-${tenantId || 'default'}-user-recon-${userId}-${Date.now()}`;
    const client = this.getClient();
    this.logger.log(`Starting user reconciliation: ${workflowId}`);

    await client.workflow.start(userReconciliationWorkflow, {
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      workflowId,
      args: [userId, targetSystems, tenantId || 'default'],
      searchAttributes: {
        TenantId: [tenantId || 'default'],
      },
      workflowExecutionTimeout: '1 hour',
      memo: {
        triggeredBy: 'ReconciliationService',
        targetDescription: `User ${userId}`,
      },
    });

    return workflowId;
  }

  /**
   * Start distributed transaction
   */
  async startDistributedTransaction(request: DistributedTransactionRequest): Promise<string> {
    if (!request?.transactionId?.trim()) {
      throw new BadRequestException('Transaction ID is required');
    }
    // The request tenant decides: request.tenantId and request.user.tenantId are overwritten,
    // since the workflow runs its activities under them.
    const tenantId = getRequestContext()?.tenantId || 'default';
    const scopedRequest: DistributedTransactionRequest = {
      ...request,
      tenantId,
      user: await this.withoutNationalId({ ...request.user, tenantId }, tenantId),
    };
    const workflowId = `t-${tenantId}-dist-tx-${request.transactionId}`;
    const client = this.getClient();
    this.logger.log(`Starting distributed transaction: ${workflowId}`);

    await client.workflow.start(distributedTransactionWorkflow, {
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      workflowId,
      args: [scopedRequest],
      searchAttributes: {
        TenantId: [tenantId],
      },
      workflowExecutionTimeout: request.timeout ? `${request.timeout}ms` : '5 minutes',
      memo: {
        triggeredBy: request.initiatedBy || 'ReconciliationService',
        targetDescription: `Transaction ${request.transactionId}: ${request.operation}`,
      },
    });

    this.devToolsService
      .recordTransaction({
        transactionId: request.transactionId,
        workflowId,
        operation: request.operation,
        initiatedBy: request.initiatedBy || 'system',
        targetUser: request.user?.email,
        participants: request.targetSystems.map((s) => ({
          systemName: s,
          status: 'PREPARING' as const,
        })),
        autoRollback: request.autoRollback,
        notes: request.notes,
        tenantId,
      })
      .catch((err) => {
        this.logger.error(
          `Reconciliation workflow emit failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    return workflowId;
  }

  /**
   * The user with its national ID taken out (identity/national-id.ts takeNationalId), so the
   * workflow input, which the Temporal history keeps, holds none: the tenant's Hashed National ID
   * field and `hetu`, at the top level and in customAttributes. With the tenant's rule (and
   * CORRELATION_HMAC_SECRET) their hash goes in as the user's correlationId, which the Hub save
   * matches on (IdentityActivities.saveToHub); a correlationId the body brings is dropped under
   * the rule. The settings are read strictly: unreadable, nothing starts.
   */
  private async withoutNationalId<T extends object>(user: T, tenantId: string): Promise<T> {
    const config = await this.correlationConfig.getCorrelationConfig(tenantId, { strict: true });
    const record = { ...user } as Record<string, unknown>;
    const hash = takeNationalId(record, nationalIdRule(config), (value) =>
      this.correlationHash.hash(value, tenantId),
    );
    if (hash) record.correlationId = hash;
    return record as T;
  }

  /**
   * Handle of a workflow of the caller's tenant; another tenant's id is a 404 (getTenantWorkflow).
   */
  async getWorkflowHandle(workflowId: string) {
    return (await getTenantWorkflow(this.getClient(), workflowId)).handle;
  }

  /**
   * Get workflow result
   */
  async getWorkflowResult(workflowId: string) {
    const handle = await this.getWorkflowHandle(workflowId);
    return await handle.result();
  }

  /**
   * Get workflow status
   */
  async getWorkflowStatus(workflowId: string) {
    const handle = await this.getWorkflowHandle(workflowId);
    const description = await handle.describe();

    return {
      workflowId,
      status: description.status.name,
      startTime: description.startTime,
      closeTime: description.closeTime,
    };
  }
}
