import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import type { Client } from '@temporalio/client';
import { WorkflowIdConflictPolicy } from '@temporalio/common';
import { offboardingWorkflow } from '../../workflows/offboarding.workflow';
import { offboardingWorkflowId } from '../../workflows/offboarding-id';
import { DEFAULT_PROVISIONING_QUEUE } from '@infrastructure/temporal/task-queue.config';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { IdentityService } from '../identity/identity.service';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';

import { temporalWorkflowUrl } from '@infrastructure/config/temporal.config';
import { maskEmail } from '../identity/identity-pii';

/**
 * Orchestrates offboarding workflows. Uses shared Temporal client from TemporalClientProvider.
 */
@Injectable()
export class OffboardingService {
  private readonly logger = new Logger(OffboardingService.name);
  private identityService: IdentityService | null = null;

  constructor(
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly temporalClientProvider: TemporalClientProvider,
  ) {}

  /** Allow external injection to avoid circular dependency (set from IdentityModule or controller). */
  setIdentityService(service: IdentityService): void {
    this.identityService = service;
  }

  getTemporalClient(): Client {
    return this.temporalClientProvider.getClient();
  }

  /**
   * Trigger the offboarding workflow for a specific user
   *
   * @param userId - The MongoDB _id of the user
   * @param userEmail - The user's email (for Entra ID deletion)
   * @param reason - Why offboarding starts (e.g. `leaver:terminated`); kept in the workflow memo
   * @returns The workflow ID for tracking
   */
  async triggerOffboarding(userId: string, userEmail: string, reason?: string): Promise<string> {
    const client = this.temporalClientProvider.getClient();
    const ctx = getRequestContext();
    const tenantId = ctx?.tenantId ?? '';
    this.logger.log(
      `Starting offboarding workflow for user: ${maskEmail(userEmail)} (ID: ${userId})`,
    );

    this.eventEmitter.emit(DomainEventType.IDENTITY_STATUS_CHANGED, userId, {
      identityId: userId,
      previousStatus: 'ACTIVE',
      newStatus: 'SUSPENDED',
      reason: reason ? `offboarding (${reason})` : 'offboarding',
    });

    // Deterministic workflow ID: reject duplicate runs for same user (OF-1 / TW-4)
    const workflowId = offboardingWorkflowId(tenantId, userId);

    await client.workflow.start(offboardingWorkflow, {
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      workflowId,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
      args: [{ userId, userEmail, tenantId: tenantId || 'default' }],
      searchAttributes: {
        TenantId: [tenantId || 'default'],
      },
      // The memo shows in the Temporal UI and describe: the identity by id, as onboarding's
      memo: {
        triggeredBy: 'OffboardingService',
        targetDescription: `Offboarding: identity ${userId}`,
        ...(reason ? { reason } : {}),
      },
    });

    this.logger.log(
      `🚀 Started Offboarding Workflow ID: ${workflowId} for ${maskEmail(userEmail)}`,
    );
    return workflowId;
  }

  /**
   * Validate user existence and trigger offboarding by user ID.
   * Encapsulates the lookup + validation + workflow trigger that the controller previously owned.
   */
  async triggerOffboardingById(userId: string): Promise<{
    success: boolean;
    workflowId?: string;
    trackingUrl?: string;
    message?: string;
    error?: string;
  }> {
    if (!this.identityService) {
      throw new InternalServerErrorException(
        'IdentityService not injected into OffboardingService',
      );
    }

    const user = await this.identityService.findById(userId);
    if (!user) {
      return { success: false, error: 'User not found' };
    }

    const userEmail = user.email as string | undefined;
    if (!userEmail) {
      return { success: false, error: 'User has no email; cannot trigger offboarding' };
    }

    try {
      const workflowId = await this.triggerOffboarding(String(userId), userEmail);
      return {
        success: true,
        workflowId,
        trackingUrl: temporalWorkflowUrl(workflowId),
        message: `Offboarding workflow started for ${userEmail}`,
      };
    } catch (error: unknown) {
      const internalMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to trigger offboarding workflow for ${maskEmail(userEmail)}: ${internalMsg}`,
        error instanceof Error ? error.stack : undefined,
      );
      return {
        success: false,
        error: 'Failed to start offboarding workflow',
      };
    }
  }
}
