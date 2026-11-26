/**
 * Starts and signals an admin identity's privileged session (workflows/privileged-session.workflow.ts)
 * under its one workflow id (privilegedSessionWorkflowId), with the tenant's TenantId search
 * attribute. Callers pass ids they have checked against the tenant-scoped model; the workflow id
 * is built here, never taken from a request.
 */
import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Client } from '@temporalio/client';
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowNotFoundError,
} from '@temporalio/common';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { DEFAULT_PROVISIONING_QUEUE } from '@infrastructure/temporal/task-queue.config';
import {
  endPrivilegedSessionSignal,
  privilegedSessionWorkflow,
  type PrivilegedSessionInput,
} from '../../workflows/privileged-session.workflow';
import { privilegedSessionWorkflowId } from '../../workflows/privileged-session-id';

@Injectable()
export class PamSessionService {
  constructor(private readonly temporal: TemporalClientProvider) {}

  /**
   * Start a session that enables the admin identity's accounts for `durationMs`. A session or a
   * disable run that still runs for it is a 409: one at a time.
   */
  async startSession(
    adminIdentityId: string,
    tenantId: string,
    sessionId: string,
    durationMs: number,
  ): Promise<string> {
    const input: PrivilegedSessionInput = {
      adminIdentityId,
      tenantId,
      mode: 'session',
      sessionId,
      durationMs,
    };
    try {
      return await this.start(input, 'session');
    } catch (err: unknown) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) {
        throw new ConflictException(
          `A session of admin account ${adminIdentityId} is already running (activating, active ` +
            'or being disabled): deactivate it, or wait until it has ended, before activating again.',
        );
      }
      throw err;
    }
  }

  /**
   * End the admin identity's session: a running one gets the signal; with none running a
   * disable-only run starts with it, so the accounts end disabled either way.
   */
  async endSession(adminIdentityId: string, tenantId: string, reason: string): Promise<string> {
    const workflowId = privilegedSessionWorkflowId(tenantId, adminIdentityId);
    const input: PrivilegedSessionInput = { adminIdentityId, tenantId, mode: 'disable', reason };
    await this.client().workflow.signalWithStart(privilegedSessionWorkflow, {
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      workflowId,
      args: [input],
      signal: endPrivilegedSessionSignal,
      signalArgs: [reason],
      searchAttributes: { TenantId: [tenantId] },
      memo: this.memo(adminIdentityId, `disable (${reason})`),
    });
    return workflowId;
  }

  /**
   * Start a disable-only run unless one of the admin identity's runs is running (it owns the
   * accounts then); false when one is.
   */
  async startDisable(adminIdentityId: string, tenantId: string, reason: string): Promise<boolean> {
    try {
      await this.start(
        { adminIdentityId, tenantId, mode: 'disable', reason },
        `disable (${reason})`,
      );
      return true;
    } catch (err: unknown) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) return false;
      throw err;
    }
  }

  /** Signal the running session to end; false when none runs. Starts nothing. */
  async endIfRunning(adminIdentityId: string, tenantId: string, reason: string): Promise<boolean> {
    const workflowId = privilegedSessionWorkflowId(tenantId, adminIdentityId);
    try {
      await this.client().workflow.getHandle(workflowId).signal(endPrivilegedSessionSignal, reason);
      return true;
    } catch (err: unknown) {
      // Never ran, or has closed
      if (err instanceof WorkflowNotFoundError) return false;
      throw err;
    }
  }

  private async start(input: PrivilegedSessionInput, what: string): Promise<string> {
    const workflowId = privilegedSessionWorkflowId(input.tenantId, input.adminIdentityId);
    await this.client().workflow.start(privilegedSessionWorkflow, {
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      workflowId,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
      args: [input],
      searchAttributes: { TenantId: [input.tenantId] },
      memo: this.memo(input.adminIdentityId, what),
    });
    return workflowId;
  }

  /** The memo shows in the Temporal UI: the admin identity by id, no UPN. */
  private memo(adminIdentityId: string, what: string) {
    return {
      triggeredBy: 'PamSessionService',
      targetDescription: `Privileged session: admin identity ${adminIdentityId} (${what})`,
    };
  }

  private client(): Client {
    if (!this.temporal.isConnected()) {
      throw new ServiceUnavailableException(
        'Temporal is not connected: the privileged session cannot be started or ended now.',
      );
    }
    return this.temporal.getClient();
  }
}
