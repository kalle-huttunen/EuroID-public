import { Injectable, Logger } from '@nestjs/common';
import { SCIMService } from '../modules/connectors/scim-connector/scim.service';
import {
  SCIMConnectorConfig,
  SCIMHealthStatus,
} from '../modules/connectors/scim-connector/scim.interface';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { ProvisioningResult } from '@shared/dtos/provisioning-result.dto';
import { Entitlement } from '@shared/interfaces/provisioning.interface';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import type { DeprovisionResult } from '@shared/types/deprovision';
import type { PamAccountResult } from '@shared/types/pam-session';
import { IdentityService } from '../modules/identity/identity.service';
import { ApplicationFailure } from '@temporalio/common';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { asDeprovisionFailure } from './deprovision-failure';
import { asProvisionFailure, eventAccountId, provisioningSubject } from './target-provision';
import { maskEmail } from '../modules/identity/identity-pii';

/**
 * [ACTIVITIES] SCIM 2.0 Activities
 * ---------------------------------
 * Temporal-compatible activities for SCIM outbound operations.
 * These are called by workflows to provision users to any SCIM-compliant SaaS app.
 *
 * ARCHITECTURE:
 * - Activities are the "hands" that do work
 * - SCIMService is the "dumb pipe" to the SCIM target (5-File Pattern)
 * - Transient errors propagate naturally for Temporal retry
 * - Health checks legitimately return failure status (not retried)
 */
@Injectable()
export class ScimActivities {
  private readonly logger = new Logger(ScimActivities.name);

  constructor(
    private readonly scimService: SCIMService,
    private readonly identityService: IdentityService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /**
   * Provision a user to a SCIM-compliant target system.
   * Handles idempotency internally (lookup by userName → create or update).
   * Errors propagate to Temporal for automatic retry, with email addresses in the message
   * masked (asProvisionFailure). Emits provisioning.completed (with the SCIM id) or
   * provisioning.failed (the masked reason) under the identity's id (provisioningSubject).
   */
  async provisionUserToScim(
    config: SCIMConnectorConfig,
    user: StandardUserDto,
    tenantId?: string,
    correlationId?: string,
  ): Promise<{ success: true; targetUserId?: string; objectId?: string }> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const { aggregateId, identityId } = provisioningSubject(user, 'scim');
        const startTime = Date.now();
        this.logger.log(`Starting provision for ${maskEmail(user.email)} at ${config.baseUrl}`);
        let result: ProvisioningResult;
        try {
          result = await this.scimService.provision(config, user);
        } catch (error: unknown) {
          const failure = asProvisionFailure('scim', error);
          this.eventEmitter.emit(DomainEventType.PROVISIONING_FAILED, aggregateId, {
            ...(identityId ? { identityId } : {}),
            connector: 'scim',
            error: failure instanceof Error ? failure.message : String(failure),
            retryable: !(failure instanceof ApplicationFailure && failure.nonRetryable),
          });
          throw failure;
        }
        this.logger.log(`Provisioned ${maskEmail(user.email)} → ${result.targetUserId}`);
        const targetUserId = eventAccountId(result.targetUserId);
        this.eventEmitter.emit(DomainEventType.PROVISIONING_COMPLETED, aggregateId, {
          ...(identityId ? { identityId } : {}),
          connector: 'scim',
          ...(targetUserId ? { targetUserId } : {}),
          operations: [],
          durationMs: Date.now() - startTime,
        });
        // objectId: the SCIM id for the onboarding writeback (identity's scim account record)
        return {
          success: true as const,
          targetUserId: result.targetUserId,
          objectId: result.targetUserId,
        };
      },
      { correlationId },
    );
  }

  /**
   * Deprovision (deactivate or delete, per deprovisionStrategy) a user from a SCIM target.
   * `externalId` is the stored SCIM id (404: already gone). Without one (accounts provisioned
   * before the id was written back) the user is looked up by the identifiers provisioning used,
   * read here from the identity (`identityId`) so they stay out of workflow history: userName
   * is the profile's UPN or else its email, emails[0] the email; `email` (the workflow input) is
   * tried too. No match fails without retry for an admin to check. Bad credentials fail at
   * once; 429 waits; other errors are retried by Temporal. A removed account emits
   * provisioning.deprovisioned under `identityId`.
   */
  async deprovisionScimUser(
    config: SCIMConnectorConfig,
    externalId: string | undefined,
    tenantId?: string,
    correlationId?: string,
    email?: string,
    identityId?: string,
  ): Promise<{ success: true } & DeprovisionResult> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        this.logger.log(`Deprovisioning ${externalId ?? 'user by lookup'} at ${config.baseUrl}`);
        try {
          const profile =
            !externalId && identityId
              ? (await this.identityService.findIdentityById(identityId, { includeDeleted: true }))
                  ?.profile
              : undefined;
          const result = await this.scimService.deprovisionUser(config, {
            id: externalId,
            userNames: [profile?.userPrincipalName, profile?.email, email].filter(isText),
            emails: [profile?.email, email].filter(isText),
          });
          this.logger.log(`Deprovision ${externalId ?? ''}: ${result.outcome}`);
          if (result.outcome === 'deprovisioned') {
            const targetUserId = eventAccountId(externalId);
            this.eventEmitter.emit(
              DomainEventType.PROVISIONING_DEPROVISIONED,
              identityId ?? 'scim',
              {
                ...(identityId ? { identityId } : {}),
                connector: 'scim',
                ...(targetUserId ? { targetUserId } : {}),
                ...(result.detail ? { detail: result.detail } : {}),
              },
            );
          }
          return { success: true as const, ...result };
        } catch (error: unknown) {
          throw asDeprovisionFailure('scim', error);
        }
      },
      { correlationId },
    );
  }

  /**
   * A privileged session (privilegedSessionWorkflow): set a linked admin account's `active`
   * (SCIM PATCH replace active), by the stored SCIM id, else looked up by `login` (the admin
   * identity's UPN, its email) as userName and email. No such user is not-found. Failures as
   * deprovisionScimUser's (asDeprovisionFailure). Emits no event.
   */
  async setScimUserActive(
    config: SCIMConnectorConfig,
    externalId: string | undefined,
    active: boolean,
    tenantId?: string,
    correlationId?: string,
    login?: string,
  ): Promise<PamAccountResult> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        try {
          const logins = [login].filter(isText);
          const result = await this.scimService.setActive(
            config,
            { id: externalId, userNames: logins, emails: logins },
            active,
          );
          this.logger.log(`SCIM active=${active} ${externalId ?? 'by lookup'}: ${result.outcome}`);
          return result;
        } catch (error: unknown) {
          throw asDeprovisionFailure('scim', error);
        }
      },
      { correlationId },
    );
  }

  /**
   * Discover entitlements (groups) from a SCIM target system.
   * Errors propagate to Temporal for automatic retry.
   */
  async discoverScimEntitlements(
    config: SCIMConnectorConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<Entitlement[]> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        this.logger.log(`Discovering entitlements from ${config.baseUrl}`);
        const entitlements = await this.scimService.discover(config);
        this.logger.log(`Discovered ${entitlements.length} entitlements`);
        return entitlements;
      },
      { correlationId },
    );
  }

  /**
   * Health check a SCIM target system.
   * Health checks legitimately return failure status (not retried by Temporal).
   */
  async checkScimHealth(
    config: SCIMConnectorConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<SCIMHealthStatus> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        try {
          this.logger.log(`Health check for ${config.baseUrl}`);
          return await this.scimService.healthCheck(config);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn('Health check failed', message);
          return { healthy: false, error: message };
        }
      },
      { correlationId },
    );
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
