/**
 * Orphan Cleanup Service
 *
 * Reads, signals, starts and stops the cleanup workflow of an orphan drift
 * (workflows/orphan-cleanup.workflow.ts). Callers pass a drift loaded through the tenant-scoped
 * model: the workflow id is the drift's own `workflowId`, or built from the drift
 * (orphanCleanupWorkflowId), never taken from a request.
 */

import { ConflictException, Injectable } from '@nestjs/common';
import { WorkflowNotFoundError } from '@temporalio/common';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { DEFAULT_PROVISIONING_QUEUE } from '@infrastructure/temporal/task-queue.config';
import {
  orphanCleanupWorkflow,
  type OrphanCleanupInput,
} from '../../workflows/orphan-cleanup.workflow';
import { orphanCleanupWorkflowId } from '../../workflows/orphan-cleanup-id';
import type { DriftDocument, DriftStatus } from './schemas/drift.schema';

export type OrphanAction = 'ADOPT' | 'DELETE';

/** The cleanup workflow's signal per action (orphan-cleanup.workflow.ts). */
const SIGNALS: Record<OrphanAction, string> = { ADOPT: 'ADOPT_ACCOUNT', DELETE: 'DELETE_ACCOUNT' };

/** An orphan drift in one of these still awaits a decision. */
const UNDECIDED: DriftStatus[] = ['open', 'quarantined'];

/** The cleanup's input from its drift, as runOrphanDetection builds it. */
function cleanupInput(drift: DriftDocument): OrphanCleanupInput {
  return {
    driftId: String(drift._id),
    targetSystem: drift.targetSystem,
    externalId: drift.orphanDetails?.externalId ?? drift.userId,
    accountIdentifier: drift.userEmail ?? drift.orphanDetails?.accountName ?? drift.userId,
    tenantId: drift.tenantId,
  };
}

@Injectable()
export class OrphanCleanupService {
  constructor(private readonly temporal: TemporalClientProvider) {}

  /** Whether the workflow runs; a closed one, or one Temporal does not know, does not. */
  async isRunning(workflowId: string): Promise<boolean> {
    try {
      const handle = this.temporal.getClient().workflow.getHandle(workflowId);
      return (await handle.describe()).status.name === 'RUNNING';
    } catch (err: unknown) {
      if (err instanceof WorkflowNotFoundError) return false;
      throw err;
    }
  }

  /**
   * ADOPT or DELETE an orphan drift's account; answers the id of the cleanup that got it. A
   * running cleanup is signalled. Otherwise (it ended, or never ran) a fresh cleanup run for the
   * drift starts with the signal, which it applies before any grace period or disable. A drift
   * already decided (corrected, ignored) without a running cleanup is a 409. `actor`, the operator,
   * follows the action's arguments: the cleanup records them as the decision's decidedBy.
   */
  async signal(
    drift: DriftDocument,
    action: OrphanAction,
    identityId?: string,
    actor?: string,
  ): Promise<string> {
    const client = this.temporal.getClient();
    const signal = SIGNALS[action];
    const signalArgs: unknown[] = action === 'ADOPT' ? [identityId] : [];
    if (actor) signalArgs.push(actor);
    if (drift.workflowId && (await this.isRunning(drift.workflowId))) {
      await client.workflow.getHandle(drift.workflowId).signal(signal, ...signalArgs);
      return drift.workflowId;
    }

    const driftId = String(drift._id);
    if (!UNDECIDED.includes(drift.status)) {
      throw new ConflictException(
        `Orphan drift ${driftId} is ${drift.status} and its cleanup has ended: nothing to adopt or delete`,
      );
    }
    const workflowId = orphanCleanupWorkflowId(drift.tenantId, driftId);
    // A running cleanup under this id gets the signal; otherwise a new run starts with it
    await client.workflow.signalWithStart<typeof orphanCleanupWorkflow, unknown[]>(
      orphanCleanupWorkflow,
      {
        taskQueue: DEFAULT_PROVISIONING_QUEUE,
        workflowId,
        args: [cleanupInput(drift)],
        signal,
        signalArgs,
        searchAttributes: { TenantId: [drift.tenantId] },
        memo: {
          triggeredBy: 'OrphanCleanupService',
          targetDescription: `Orphan cleanup: drift ${driftId} (${action})`,
        },
      },
    );
    return workflowId;
  }

  /**
   * Cancels the cleanup when it runs (it ends CANCELLED and disables or deletes nothing more);
   * one that has ended is left as it is. For an orphan drift closed by hand.
   */
  async stop(workflowId: string): Promise<void> {
    if (!(await this.isRunning(workflowId))) return;
    try {
      await this.temporal.getClient().workflow.getHandle(workflowId).cancel();
    } catch (err: unknown) {
      // It ended between the check and the cancel
      if (!(err instanceof WorkflowNotFoundError)) throw err;
    }
  }
}
