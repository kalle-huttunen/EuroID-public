/**
 * Temporal activity that applies a mover run's access change in one target system (mover
 * workflow, patch mover:identity-by-id). It runs on each connector's own queue
 * (provisioning-entra, -ad, -okta, -scim), registered there by worker.ts through
 * moverAccessQueueActivities, like the access review's revokeReviewAccess.
 *
 * Only ids travel through workflow history (MoverAccessTask): the activity reads the identity,
 * its account in the target and the connector config itself.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { QUEUE_NAMES } from '@infrastructure/temporal/task-queue.config';
import { validateActivityContext } from '@shared/utils/activity-context';
import {
  MOVER_CONNECTORS,
  type MoverAccessResult,
  type MoverAccessTask,
} from '@shared/types/mover';
import { IdentityService } from '../modules/identity/identity.service';
import { MoverTargetAccessService } from '../modules/mover/mover-target-access.service';
import { asDeprovisionFailure, DEPROVISION_REJECTED } from './deprovision-failure';

@Injectable()
export class MoverAccessActivities {
  private readonly logger = new Logger(MoverAccessActivities.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly targets: MoverTargetAccessService,
  ) {}

  /**
   * Apply the task's removals and additions for the identity in the connector's target. A 429
   * waits the target's retry-after, a client error (bad credentials, missing config, an account
   * or group the target does not know, a membership EuroID cannot change) fails at once,
   * anything else is retried per CONNECTOR_RETRY. Failure messages reach workflow history, the
   * identity's provisioning entry and the timeline, so email addresses and the names in LDAP DNs
   * are masked (deprovision-failure.ts, identity-pii.ts maskEmail).
   */
  async applyMoverAccess(
    task: MoverAccessTask,
    tenantId: string,
    correlationId?: string,
  ): Promise<MoverAccessResult> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        const identity = await this.identityService.findIdentityById(task.identityId);
        if (!identity) {
          throw ApplicationFailure.nonRetryable(
            'The identity no longer exists in the Hub',
            DEPROVISION_REJECTED,
          );
        }
        try {
          const result = await this.targets.apply(
            task.connector,
            identity,
            task.operations,
            tenantId,
            correlationId,
          );
          this.logger.log(
            `[Mover] ${task.connector}, identity ${task.identityId}: ${result.changed} changed, ` +
              `${result.unchanged} already as wanted`,
          );
          return result;
        } catch (e: unknown) {
          throw asDeprovisionFailure(task.connector, e);
        }
      },
      { correlationId },
    );
  }
}

/**
 * applyMoverAccess for each connector queue it runs on, keyed by queue name. worker.ts adds
 * these to the queue's plugin activities, so the queue the workflow calls is the queue that
 * registers the activity.
 */
export function moverAccessQueueActivities(
  activities: MoverAccessActivities,
): Record<string, Record<string, MoverAccessActivities['applyMoverAccess']>> {
  const onQueue = { applyMoverAccess: activities.applyMoverAccess.bind(activities) };
  return Object.fromEntries(MOVER_CONNECTORS.map((c) => [QUEUE_NAMES[c], onQueue]));
}
