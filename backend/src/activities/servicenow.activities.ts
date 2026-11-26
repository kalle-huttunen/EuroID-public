import { Injectable, Logger } from '@nestjs/common';
import { ServiceNowService } from '../modules/connectors/servicenow-connector/servicenow.service';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import type { DeprovisionResult } from '@shared/types/deprovision';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { ApplicationFailure } from '@temporalio/common';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { asDeprovisionFailure } from './deprovision-failure';
import {
  asProvisionFailure,
  eventAccountId,
  provisioningSubject,
  type TargetProvisionResult,
} from './target-provision';

/**
 * Temporal activities for the ServiceNow connector (default task queue). The connector resolves
 * its config from the installed connector, so no secret passes through workflow history.
 */
@Injectable()
export class ServiceNowActivities {
  private readonly logger = new Logger(ServiceNowActivities.name);

  constructor(
    private readonly serviceNowService: ServiceNowService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** Onboarding health check: the instance answers to the saved credentials. */
  async checkServiceNowHealth(
    _config?: undefined,
    tenantId?: string,
    correlationId?: string,
  ): Promise<boolean> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(tenantId ?? '', () => this.serviceNowService.healthCheck(), {
      correlationId,
    });
  }

  /**
   * Onboarding: create the sys_user record, or update the one with the person's email, and open
   * a tracking incident. The id written back is `snow-<sys_id>`, the one offboarding
   * deactivates. Errors are retried by Temporal. Emits provisioning.completed (with that id) or
   * provisioning.failed (the masked reason) under the identity's id.
   */
  async provisionUserToServiceNow(
    user: StandardUserDto,
    intent?: unknown,
    _config?: undefined,
    tenantId?: string,
    correlationId?: string,
  ): Promise<TargetProvisionResult> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const { aggregateId, identityId } = provisioningSubject(user, 'servicenow');
        const startTime = Date.now();
        const detail = 'sys_user created or updated, tracking incident opened';
        let objectId: string;
        try {
          objectId = (await this.serviceNowService.create(user, intent)).targetUserId;
        } catch (error: unknown) {
          const failure = asProvisionFailure('servicenow', error);
          this.eventEmitter.emit(DomainEventType.PROVISIONING_FAILED, aggregateId, {
            ...(identityId ? { identityId } : {}),
            connector: 'servicenow',
            error: failure instanceof Error ? failure.message : String(failure),
            retryable: !(failure instanceof ApplicationFailure && failure.nonRetryable),
          });
          throw failure;
        }
        const targetUserId = eventAccountId(objectId);
        this.eventEmitter.emit(DomainEventType.PROVISIONING_COMPLETED, aggregateId, {
          ...(identityId ? { identityId } : {}),
          connector: 'servicenow',
          ...(targetUserId ? { targetUserId } : {}),
          operations: [],
          detail,
          durationMs: Date.now() - startTime,
        });
        return { success: true as const, objectId, detail };
      },
      { correlationId },
    );
  }

  /**
   * Offboarding: deactivate and lock the sys_user record (never deleted), found by the stored
   * id or else by email. Bad credentials and ambiguous emails fail without retry; 429 waits the
   * retry-after; other errors are retried by Temporal. A deactivation emits
   * provisioning.deprovisioned under `identityId` (the identity the caller names).
   */
  async deprovisionServiceNowUser(
    externalId: string | undefined,
    email: string,
    tenantId?: string,
    correlationId?: string,
    identityId?: string,
  ): Promise<DeprovisionResult> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        let result: DeprovisionResult;
        try {
          result = await this.serviceNowService.deprovision({ externalId, email });
          this.logger.log(`ServiceNow deprovision: ${result.outcome}`);
        } catch (error: unknown) {
          throw asDeprovisionFailure('servicenow', error);
        }
        if (result.outcome === 'deprovisioned') {
          const targetUserId = eventAccountId(externalId);
          this.eventEmitter.emit(
            DomainEventType.PROVISIONING_DEPROVISIONED,
            identityId ?? 'servicenow',
            {
              ...(identityId ? { identityId } : {}),
              connector: 'servicenow',
              ...(targetUserId ? { targetUserId } : {}),
              ...(result.detail ? { detail: result.detail } : {}),
            },
          );
        }
        return result;
      },
      { correlationId },
    );
  }
}
