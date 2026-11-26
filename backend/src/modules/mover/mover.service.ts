import { Injectable, NotFoundException } from '@nestjs/common';
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowNotFoundError,
} from '@temporalio/common';
import { QueryNotRegisteredError, type WorkflowHandle } from '@temporalio/client';
import { moverWorkflow, MoverWorkflowInput } from '../../workflows/mover.workflow';
import { acceptsQueuedEditsQuery, reevaluateMoverSignal } from '../../workflows/mover-reevaluation';
import { DEFAULT_PROVISIONING_QUEUE } from '@infrastructure/temporal/task-queue.config';
import { AuditService } from '../audit/audit.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { getTenantWorkflow } from '@infrastructure/temporal/tenant-workflow';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { MoverStartedPayload } from '@infrastructure/events/event-payloads';
import { toAccessBaseline } from '@shared/utils/access-baseline';

/** What starts a mover run: the identity by id, never by email (patch mover:identity-by-id). */
export type MoverStartInput = Omit<MoverWorkflowInput, 'email'>;

/** A run started for the change, or the open run the change was queued on. */
export interface MoverStart {
  workflowId: string;
  queued: boolean;
}

/**
 * Orchestrates mover workflows for role/department changes (PATCH or HR sync) and access
 * re-evaluation.
 * Uses shared Temporal client from TemporalClientProvider.
 *
 * One run per identity at a time: the workflow id is `t-<tenant>-mover-<identityId>` and a start
 * while one runs fails (WorkflowExecutionAlreadyStartedError). The id, memo, log and audit entry
 * name the identity by id, never by email. The workflow input carries no email either, and of
 * `previousAttributes` only what the access baseline keeps (shared/utils/access-baseline.ts: no
 * names, contact data or identifiers), so no such value enters workflow history. The start is
 * published as mover.started (identity timeline: what changed and who started it).
 */
@Injectable()
export class MoverService {
  private readonly logger = this.loggerFactory.create(MoverService.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly loggerFactory: LoggerFactoryService,
    private readonly temporalClientProvider: TemporalClientProvider,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /**
   * @param options.requestedBy who started it (the operator for a re-evaluation, system:hr-sync or
   *   the approving admin for an HR sync); defaults to MoverService for runs started by an
   *   attribute change
   */
  async triggerMover(input: MoverStartInput, options?: { requestedBy?: string }): Promise<string> {
    const client = this.temporalClientProvider.getClient();
    const ctx = getRequestContext();
    const tenantId = input.tenantId || ctx?.tenantId || 'default';
    const trigger = input.trigger ?? 'attribute-change';
    const actor = options?.requestedBy ?? 'MoverService';

    const workflowId = `t-${tenantId}-mover-${input.identityId}`;
    const args: MoverWorkflowInput = {
      identityId: input.identityId,
      tenantId,
      changedFields: input.changedFields,
      previousAttributes: toAccessBaseline(input.previousAttributes),
      trigger,
      ...(input.syncToEntra ? { syncToEntra: true } : {}),
    };

    await client.workflow.start(moverWorkflow, {
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      workflowId,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
      args: [args],
      searchAttributes: {
        TenantId: [tenantId],
      },
      memo: {
        triggeredBy: actor,
        trigger,
        targetDescription: `Mover: identity ${input.identityId}`,
        changedFields: input.changedFields,
      },
    });

    this.logger.log(`Started mover workflow ${workflowId} (${trigger})`);

    this.eventEmitter.emit<MoverStartedPayload>(
      DomainEventType.MOVER_STARTED,
      input.identityId,
      { identityId: input.identityId, workflowId, trigger, changedFields: input.changedFields },
      { tenantId, actor },
    );

    this.auditService.logFireAndForget({
      action: 'MOVER_WORKFLOW_STARTED',
      severity: 'info',
      actor,
      resourceType: 'workflow',
      resourceId: workflowId,
      resourceName: `Mover: identity ${input.identityId}`,
      description:
        `Mover workflow started for identity ${input.identityId} (${trigger}): ` +
        (input.changedFields.join(', ') || 'no attribute changed since access was last applied'),
      tenantId,
    });

    return workflowId;
  }

  /**
   * Start the mover for an edit, or, while a run for the identity is open, queue the edit on that
   * run (signal reevaluate, mover-reevaluation.ts): the run evaluates the identity once more when
   * it ends, so the edit is never lost. Only a run that answers acceptsQueuedEdits is signalled
   * (patch mover:queued-edit-query); for one that does not (started before the patch, or run by
   * a worker of an older build, which would drop the edit) the API waits in the background until
   * it ends and then starts the edit's own run (startAfterOpenRun). A run that ends between the
   * start and the signal is started again. Other start failures propagate.
   */
  async startOrQueueMover(
    input: MoverStartInput,
    options?: { requestedBy?: string },
  ): Promise<MoverStart> {
    try {
      return { workflowId: await this.triggerMover(input, options), queued: false };
    } catch (error: unknown) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
    const tenantId = input.tenantId || getRequestContext()?.tenantId || 'default';
    const workflowId = `t-${tenantId}-mover-${input.identityId}`;
    const startAgain = async () => ({
      workflowId: await this.triggerMover(input, options),
      queued: false,
    });
    try {
      const { handle } = await getTenantWorkflow(
        this.temporalClientProvider.getClient(),
        workflowId,
        tenantId,
      );
      if (!(await this.acceptsQueuedEdits(handle, workflowId))) {
        void this.startAfterOpenRun(handle, input, options, workflowId);
        this.auditQueued(input, options, workflowId, tenantId, 'after the run in progress ends');
        return { workflowId, queued: true };
      }
      await handle.signal(reevaluateMoverSignal, {
        changedFields: input.changedFields,
        // As a run's input: only what the access baseline keeps enters history
        previousAttributes: toAccessBaseline(input.previousAttributes),
        ...(input.syncToEntra ? { syncToEntra: true } : {}),
      });
    } catch (error: unknown) {
      // The open run ended (or is gone) meanwhile: this edit gets its own run
      if (error instanceof WorkflowNotFoundError || error instanceof NotFoundException) {
        return startAgain();
      }
      throw error;
    }
    this.logger.log(`Queued an edit on the open mover workflow ${workflowId}`);
    this.auditQueued(input, options, workflowId, tenantId, 'on the run in progress');
    return { workflowId, queued: true };
  }

  /**
   * Whether the open run takes a queued edit (acceptsQueuedEdits). A run without the handler, or
   * one whose worker does not answer, is treated as one that would drop it. A run gone
   * meanwhile propagates (WorkflowNotFoundError: the caller starts the edit's own run).
   */
  private async acceptsQueuedEdits(handle: WorkflowHandle, workflowId: string): Promise<boolean> {
    try {
      return (await handle.query(acceptsQueuedEditsQuery)) === true;
    } catch (error: unknown) {
      if (error instanceof WorkflowNotFoundError) throw error;
      this.logger.warn(
        `Mover workflow ${workflowId} does not take queued edits (` +
          `${error instanceof QueryNotRegisteredError ? 'started before the upgrade' : String(error)}` +
          '): the edit gets its own run when it ends',
      );
      return false;
    }
  }

  /**
   * Waits until the open run has ended (completed, failed or terminated), then starts the edit's
   * run (or queues it on a run another edit started meanwhile). Runs in the background of the
   * request; if the API stops before the open run ends, the edit's run is not started: the
   * warning logged here names the identity, whose access an operator then re-evaluates
   * (POST /identity/:id/access/re-evaluate).
   */
  private async startAfterOpenRun(
    handle: WorkflowHandle,
    input: MoverStartInput,
    options: { requestedBy?: string } | undefined,
    workflowId: string,
  ): Promise<void> {
    this.logger.warn(
      `Mover edit for identity ${input.identityId} waits for ${workflowId} to end before its run`,
    );
    try {
      await handle.result();
    } catch {
      // Failed, cancelled or terminated: it has ended either way
    }
    try {
      await this.startOrQueueMover(input, options);
    } catch (error: unknown) {
      this.logger.error(
        `Mover run for the edit of identity ${input.identityId} not started after ${workflowId} ` +
          `ended: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private auditQueued(
    input: MoverStartInput,
    options: { requestedBy?: string } | undefined,
    workflowId: string,
    tenantId: string,
    where: string,
  ): void {
    this.auditService.logFireAndForget({
      action: 'MOVER_CHANGE_QUEUED',
      severity: 'info',
      actor: options?.requestedBy ?? 'MoverService',
      resourceType: 'workflow',
      resourceId: workflowId,
      resourceName: `Mover: identity ${input.identityId}`,
      description:
        `Mover change queued ${where} for identity ${input.identityId}: ` +
        input.changedFields.join(', '),
      tenantId,
    });
  }
}
