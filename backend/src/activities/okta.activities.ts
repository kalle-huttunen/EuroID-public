/**
 * [ACTIVITIES] Okta Activities
 * -----------------------------
 * Temporal-compatible activities for Okta Identity Cloud operations.
 *
 * ARCHITECTURE:
 * - Activities are the "hands" that do work
 * - OktaService is the "dumb pipe" to Okta (5-File Pattern)
 * - Transient errors (network, 5xx) propagate naturally for Temporal retry
 * - 409 Conflict = idempotent success (Safety Rule 7)
 */

import { Injectable, Logger } from '@nestjs/common';
import { OktaService } from '../modules/connectors/okta-connector/okta.service';
import {
  OktaConfig,
  OktaProvisioningIntent,
} from '../modules/connectors/okta-connector/okta.interface';
import { OKTA_SYSTEM } from '../modules/connectors/okta-connector/okta.constants';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EntitlementCatalogService } from '../modules/entitlement-catalog/entitlement-catalog.service';
import type { Entitlement } from '@shared/interfaces/provisioning.interface';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import type { DeprovisionResult } from '@shared/types/deprovision';
import type { PamAccountResult } from '@shared/types/pam-session';
import { asDeprovisionFailure, maskPersonalData } from './deprovision-failure';
import { eventAccountId, provisioningSubject } from './target-provision';
import { maskEmail } from '../modules/identity/identity-pii';

@Injectable()
export class OktaActivities {
  private readonly logger = new Logger(OktaActivities.name);

  constructor(
    private readonly oktaService: OktaService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly entitlementCatalog: EntitlementCatalogService,
  ) {}

  /**
   * Health Check Activity
   * Used by connector management to verify Okta is reachable.
   */
  async checkOktaHealth(
    config?: OktaConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<boolean> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        try {
          return await this.oktaService.healthCheck(config);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn('Health check failed', message);
          return false;
        }
      },
      { correlationId },
    );
  }

  /**
   * Provision user to Okta
   *
   * The service handles everything internally:
   * - Idempotency check (409 = update existing)
   * - Mapping via OktaMapper (StandardUser -> Okta profile)
   * - Execution via OktaClient (HTTP/Auth)
   * - Intent execution (groups/apps) if provided
   */
  async provisionUserToOkta(
    standardUser: StandardUserDto,
    intent?: OktaProvisioningIntent,
    config?: OktaConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<{
    success: true;
    oktaUserId?: string;
    /** The Okta user id again, for the onboarding writeback (identity's okta account record). */
    objectId?: string;
    skipped?: boolean;
  }> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const connector = 'okta';
        const { aggregateId, identityId } = provisioningSubject(standardUser, connector);
        const startTime = Date.now();

        try {
          this.logger.log(`Starting provision/update for ${maskEmail(standardUser.email)}`);
          const result = await this.oktaService.provision(standardUser, intent, config);
          this.logger.log(
            `Successfully provisioned/updated ${maskEmail(standardUser.email)} with ID ${result.targetUserId}`,
          );

          const durationMs = Date.now() - startTime;
          const operations = (intent?.operations ?? []).map((op) => ({
            action: op.action ?? ('add' as const),
            type: op.type,
            targetId: op.targetId,
            success: true,
          }));

          this.eventEmitter.emit(DomainEventType.PROVISIONING_COMPLETED, aggregateId, {
            ...(identityId ? { identityId } : {}),
            connector,
            targetUserId: result.targetUserId,
            operations,
            durationMs,
          });

          return {
            success: true as const,
            oktaUserId: result.targetUserId,
            objectId: result.targetUserId,
            skipped: false,
          };
        } catch (e: unknown) {
          this.eventEmitter.emit(DomainEventType.PROVISIONING_FAILED, aggregateId, {
            ...(identityId ? { identityId } : {}),
            connector,
            error: maskPersonalData(e instanceof Error ? e.message : String(e)),
            retryable: true,
          });
          throw e;
        }
      },
      { correlationId },
    );
  }

  /**
   * Disable (deactivate) Okta user. True when it is deactivated, or Okta has no such user
   * (OktaProvisioningService.deactivateUser takes a 404 for nothing left to do). Any other error
   * fails the activity, so Temporal retries it: answering false for it hid a deactivation that
   * never happened. (A registered manifest activity; offboarding uses deprovisionOktaUser.)
   */
  async disableOktaUser(
    oktaUserId: string,
    config?: OktaConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<boolean> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        await this.oktaService.deactivateUser(oktaUserId, config);
        this.logger.log(`Deactivated Okta user ${oktaUserId}`);
        return true;
      },
      { correlationId },
    );
  }

  /**
   * Offboarding: deactivate (or deactivate and delete, per the connector's deprovisionStrategy)
   * the Okta user, found by its stored id or else by login (the email). Already gone (404) is a
   * result, not an error. Bad credentials fail at once; 429 waits the retry-after; other errors
   * are retried by Temporal. A deactivation emits provisioning.deprovisioned under `identityId`
   * (the identity the caller names).
   */
  async deprovisionOktaUser(
    oktaUserId: string | undefined,
    login: string,
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
          result = await this.oktaService.offboardUser({ oktaUserId, login });
        } catch (error: unknown) {
          throw asDeprovisionFailure(OKTA_SYSTEM, error);
        }
        if (result.outcome === 'deprovisioned') {
          const targetUserId = eventAccountId(oktaUserId);
          this.eventEmitter.emit(
            DomainEventType.PROVISIONING_DEPROVISIONED,
            identityId ?? OKTA_SYSTEM,
            {
              ...(identityId ? { identityId } : {}),
              connector: OKTA_SYSTEM,
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

  /**
   * A privileged session (privilegedSessionWorkflow): unsuspend (enable) or suspend (disable) a
   * linked admin account, found by its stored Okta id, else by login (the admin identity's UPN).
   * What each Okta status allows: OktaProvisioningService.setUserEnabled. No such user is
   * not-found. Failures as deprovisionOktaUser's (asDeprovisionFailure). Emits no event.
   */
  async setOktaUserEnabled(
    oktaUserId: string | undefined,
    login: string,
    enabled: boolean,
    tenantId?: string,
    correlationId?: string,
  ): Promise<PamAccountResult> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        try {
          const result = await this.oktaService.setUserEnabled({ oktaUserId, login }, enabled);
          this.logger.log(`Okta ${enabled ? 'enable' : 'disable'}: ${result.outcome}`);
          return result;
        } catch (error: unknown) {
          throw asDeprovisionFailure(OKTA_SYSTEM, error);
        }
      },
      { correlationId },
    );
  }

  /**
   * Discovery: Fetch available entitlements (groups + applications) from Okta.
   * Raw entitlements are passed to EntitlementCatalogService for classification.
   */
  async discoverOktaEntitlements(
    config?: OktaConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<{ nativeId: string; name: string; type: string }[]> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const entitlements = await this.oktaService.discover(config);

        // Filter to catalog-compatible types (Group, License, DirectoryRole).
        // Okta 'Application' entitlements are returned to the caller but not
        // absorbed into the catalog (which only supports the core Entitlement types).
        const catalogEntitlements: Entitlement[] = entitlements
          .filter((e) => e.type === 'Group')
          .map((e) => ({
            nativeId: e.nativeId,
            name: e.name,
            type: e.type as Entitlement['type'],
            system: OKTA_SYSTEM,
            origin: 'EXTERNAL' as const,
            governanceLevel: 'OPEN' as const,
          }));

        // PAM classification happens in EntitlementCatalogService.absorbDiscovered()
        // (Brain layer) — discovery just passes catalog-compatible entitlements through.
        if (catalogEntitlements.length > 0) {
          await this.entitlementCatalog.absorbDiscovered(OKTA_SYSTEM, catalogEntitlements);
        }
        return entitlements;
      },
      { correlationId },
    );
  }
}
