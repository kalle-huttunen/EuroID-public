import { Injectable, NotFoundException } from '@nestjs/common';
import { Client } from '@temporalio/client';
import { WorkflowExecutionAlreadyStartedError, WorkflowIdConflictPolicy } from '@temporalio/common';
import { onboardingWorkflow } from '../../workflows/onboarding.workflow';
import { DEFAULT_PROVISIONING_QUEUE } from '@infrastructure/temporal/task-queue.config';
import { AuditService } from '../audit/audit.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { getTenantWorkflow } from '@infrastructure/temporal/tenant-workflow';

/** The person one onboarding run is for: the identity, and the email the workflow reads it by. */
export interface OnboardingTarget {
  identityId: string;
  email: string;
}

/**
 * Orchestrates onboarding workflows. Uses shared Temporal client from TemporalClientProvider.
 *
 * One run per person at a time (TW-4): the workflow id is `t-<tenant>-onboard-<identityId>` and a
 * start while one runs fails
 * (WorkflowExecutionAlreadyStartedError). The id, memo, log and audit entry name the identity by
 * id, never by email; only the workflow input carries the email (`targetEmail`, the workflow reads
 * the identity by it).
 */
@Injectable()
export class OnboardingService {
  private readonly logger = this.loggerFactory.create(OnboardingService.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly loggerFactory: LoggerFactoryService,
    private readonly temporalClientProvider: TemporalClientProvider,
  ) {}

  /**
   * Exposes the Temporal client. Throws if Temporal is not connected.
   */
  getTemporalClient(): Client {
    return this.temporalClientProvider.getClient();
  }

  /**
   * @param target The person to onboard. Every run has one: the workflow fails a run started
   *   without (patch onboarding:target-required).
   * @param options.syncToEntra PATCH /identity/:id?syncToEntra=true: the run provisions Entra ID
   *   even when it is already SYNCED (onboarding skips SYNCED targets otherwise).
   * @param options.reason Why onboarding starts (e.g. `joiner:hr-sync:csv-hr`); kept in the
   *   workflow memo. The workflow input does not change.
   */
  async triggerOnboarding(
    target: OnboardingTarget,
    options?: { syncToEntra?: boolean; reason?: string },
  ): Promise<string> {
    const client = this.getTemporalClient();
    const tenantId = getRequestContext()?.tenantId || 'default';
    const who = `identity ${target.identityId}`;
    const startedAt = new Date().toISOString();
    this.logger.log(`[ONBOARDING TRIGGER] Starting workflow at ${startedAt} for: ${who}`);

    const workflowId = `t-${tenantId}-onboard-${target.identityId}`;
    await this.failIfLegacyRunOpen(client, tenantId, target.email);

    await client.workflow.start(onboardingWorkflow, {
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      workflowId,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
      args: [
        {
          targetEmail: target.email,
          tenantId,
          ...(options?.syncToEntra ? { syncToEntra: true } : {}),
        },
      ],
      searchAttributes: {
        TenantId: [tenantId],
      },
      memo: {
        triggeredBy: 'OnboardingService',
        targetDescription: `Onboarding: ${who}`,
        ...(options?.reason ? { reason: options.reason } : {}),
      },
    });

    this.logger.log(`Started Workflow ID: ${workflowId} for ${who}`);

    // Audit
    this.auditService.logFireAndForget({
      action: 'PROVISIONING_EXECUTED',
      severity: 'info',
      actor: 'OnboardingService',
      resourceType: 'workflow',
      resourceId: workflowId,
      resourceName: `Onboarding: ${who}`,
      description: `Onboarding workflow started for ${who}`,
      tenantId,
    });

    return workflowId;
  }

  /**
   * Runs started before plan 2.0dn have the id `t-<tenant>-onboard-<email>` (`@` and `.` replaced
   * by `-at-` and `-`). One still open is this person's run in progress, so the start fails as a
   * second start under its id would, naming that run: callers report it as in progress (a joiner
   * is superseded, PATCH ?syncToEntra=true answers "already in progress"). The id is only looked
   * up, never started or logged. Not needed once no run started before 2.0dn can be open.
   */
  private async failIfLegacyRunOpen(client: Client, tenantId: string, email: string) {
    const legacyId = `t-${tenantId}-onboard-${email.replace(/@/g, '-at-').replace(/\./g, '-')}`;
    let open = false;
    try {
      const { description } = await getTenantWorkflow(client, legacyId, tenantId);
      open = description.status.name === 'RUNNING';
    } catch (err: unknown) {
      if (!(err instanceof NotFoundException)) throw err;
    }
    if (open) {
      throw new WorkflowExecutionAlreadyStartedError(
        'Workflow execution already started',
        legacyId,
        'onboardingWorkflow',
      );
    }
  }
}
