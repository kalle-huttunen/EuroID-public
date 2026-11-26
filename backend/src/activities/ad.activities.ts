import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import { AdClient } from '../modules/connectors/ad-connector/ad.client';
import { AdService } from '../modules/connectors/ad-connector/ad.service';
import { AccountNameService } from '../modules/connectors/ad-connector/account-name.service';
import {
  AdConfig,
  AdHealthCheckResult,
  ProvisioningIntent,
  isInsideBaseDn,
} from '../modules/connectors/ad-connector/ad.interface';
import { adCommonName, toDn } from '../modules/connectors/ad-connector/ad.mapper';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type {
  ProvisioningOperationResult,
  ProvisioningResult,
} from '@shared/dtos/provisioning-result.dto';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EntitlementCatalogService } from '../modules/entitlement-catalog/entitlement-catalog.service';
import { CredentialGenerationService } from '@infrastructure/secrets/credential-generation.service';
import type { DeprovisionResult } from '@shared/types/deprovision';
import type { PamAccountResult } from '@shared/types/pam-session';
import { asDeprovisionFailure, maskPersonalData } from './deprovision-failure';
import { provisioningSubject } from './target-provision';
import { adChangesFailure, applyAdGroupChanges } from './ad-group-changes';
import {
  adProvisionFailure,
  assertOwnAccountAt,
  findOwnAdAccount,
  ownAccountResult,
  resolveUniqueCn,
  resolveUniqueSam,
  type AdProvisionStep,
} from './ad-provision-account';

/**
 * [ACTIVITIES] Active Directory Activities
 * -----------------------------------------
 * Temporal-compatible activities for on-premises AD operations via LDAP/LDAPS.
 * Provisions users within Base DN (tenant isolation boundary).
 *
 * ARCHITECTURE:
 * - Activities orchestrate: SAM/UPN resolution, provision, group operations
 * - AdService is the "dumb pipe": field mapping + LDAP only
 */
@Injectable()
export class AdActivities {
  private readonly logger = new Logger(AdActivities.name);

  constructor(
    private readonly adService: AdService,
    private readonly adClient: AdClient,
    private readonly accountNameService: AccountNameService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly entitlementCatalog: EntitlementCatalogService,
    private readonly credentialGeneration: CredentialGenerationService,
  ) {}

  /**
   * Health check — bind + unbind to verify LDAP connectivity.
   */
  async checkAdHealth(
    config?: AdConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<boolean> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        try {
          return await this.adService.healthCheck(config);
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
   * Enriched health check for UI — returns detailed connectivity and scoping info.
   */
  async checkAdHealthEnriched(
    config?: AdConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<AdHealthCheckResult> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        try {
          if (!config?.host?.trim()) {
            return { connected: false, error: 'Host is required' };
          }
          const resolved = this.resolveAdConfig(config);
          if (!resolved) {
            return { connected: false, error: 'Invalid config: missing host or base DN' };
          }
          return await this.adClient.healthCheckEnriched(resolved);
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return { connected: false, error: msg };
        }
      },
      { correlationId },
    );
  }

  private resolveAdConfig(c: AdConfig): AdConfig | null {
    const rootBaseDn = c.rootBaseDn?.trim() || c.baseDn?.trim();
    if (!rootBaseDn) return null;
    const userSearchBase = c.userSearchBase?.trim();
    if (userSearchBase && !isInsideBaseDn(userSearchBase, rootBaseDn)) {
      throw new ConnectorException(
        `User Search Base "${userSearchBase}" is not inside Root Base DN "${rootBaseDn}"`,
      );
    }
    return { ...c, rootBaseDn, userSearchBase: userSearchBase || undefined };
  }

  /**
   * Provision user to Active Directory.
   * Orchestrates: SAM/UPN resolution, user creation, then the intent's group adds and removals
   * (ad-group-changes.ts), each reported in `operations`: applied, unchanged or failed.
   * Idempotent: the person's existing account (the user with the UPN this run sets; only the UPN
   * identifies it) is used with its own sAMAccountName and DN, and nothing is created. A new
   * account gets a numeric suffix on a sAMAccountName or CN another account holds, and an account
   * LDAP 68 answers with for another UPN is refused, not retried (ad-provision-account.ts).
   *
   * Returns on success, or when config is missing (skipped). A group change AD did not make
   * fails the call after the other changes were made (adChangesFailure: an LDAP error is
   * retried, a 4xx is not), so the target is ERROR with the reason, never SYNCED with groups
   * missing. Other errors propagate to Temporal for automatic retry, their message naming the
   * step and LDAP result code with DN names and emails masked (adProvisionFailure). Each outcome
   * emits provisioning.completed or provisioning.failed under the identity's id, without the DN.
   */
  async provisionUserToAd(
    standardUser: StandardUserDto,
    intent?: ProvisioningIntent,
    config?: AdConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<
    | {
        success: true;
        objectId: string;
        generatedAttributes?: { mail?: string; userPrincipalName?: string };
        skipped: false;
        operations: ProvisioningOperationResult[];
      }
    | { success: false; skipped: true; error: string }
  > {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        // Config-missing guard — legitimate skip (not an error)
        const resolved = config ? this.resolveAdConfig(config) : null;
        if (!config?.host || !resolved) {
          return {
            success: false as const,
            error: 'AD config missing host or baseDn',
            skipped: true as const,
          };
        }
        const baseDn =
          resolved.userSearchBase?.trim() ||
          resolved.rootBaseDn?.trim() ||
          resolved.baseDn?.trim() ||
          '';
        if (!baseDn) {
          return {
            success: false as const,
            error: 'AD config missing baseDn',
            skipped: true as const,
          };
        }

        const { aggregateId, identityId } = provisioningSubject(standardUser, 'ad');
        const startTime = Date.now();
        let result: ProvisioningResult;
        let operations: ProvisioningOperationResult[];

        let step: AdProvisionStep = 'find the account';
        try {
          const domain =
            config.defaultDomain || this.accountNameService.inferDomainFromBaseDn(baseDn);
          const upn = this.accountNameService.buildUserPrincipalName(standardUser, domain);
          const own = await findOwnAdAccount(this.adClient, resolved, baseDn, upn);
          if (own) {
            this.logger.log("The person's AD account exists: its sAMAccountName and DN are kept");
            result = ownAccountResult(own, upn);
          } else {
            const baseSam = this.accountNameService.generateSamAccountName(standardUser);
            const uniqueSam = await resolveUniqueSam(this.adClient, resolved, baseDn, baseSam);
            // A namesake's account at the planned DN is theirs: this person gets a free CN
            const commonName = await resolveUniqueCn(
              this.adClient,
              resolved,
              baseDn,
              adCommonName(standardUser),
              (cn) => toDn(standardUser, resolved, uniqueSam, cn),
            );
            const userWithResolvedAttrs: StandardUserDto = {
              ...standardUser,
              samAccountName: uniqueSam,
              userPrincipalName: upn,
            };

            // Generate password in the Brain (activity layer), not the connector
            const password = this.credentialGeneration.generatePassword({
              length: 16,
              upperChars: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
              lowerChars: 'abcdefghjkmnpqrstuvwxyz',
              digitChars: '23456789',
              specialChars: '!@#$%',
            });

            step = 'create the account';
            result = await this.adService.provision(
              config,
              userWithResolvedAttrs,
              intent,
              password,
              commonName,
            );
            // LDAP 68 answers success for whatever holds the DN: never another person's account
            await assertOwnAccountAt(this.adClient, resolved, baseDn, result.targetUserId, upn);
          }
          step = "read the account's groups";
          operations = await applyAdGroupChanges(
            this.adService,
            config,
            result.targetUserId,
            intent,
          );
        } catch (error: unknown) {
          // The reason before adProvisionFailure prefixes the step to the message
          const reason = maskPersonalData(error instanceof Error ? error.message : String(error));
          const failure = adProvisionFailure(step, error);
          // Emit PROVISIONING_FAILED event before re-throwing (mirrors entra.activities.ts)
          this.eventEmitter.emit(DomainEventType.PROVISIONING_FAILED, aggregateId, {
            ...(identityId ? { identityId } : {}),
            connector: 'ad',
            error: reason,
            retryable: !(failure instanceof ApplicationFailure && failure.nonRetryable),
          });
          throw failure; // Temporal retries it unless it is non-retryable
        }

        const failed = operations.filter((op) => op.outcome === 'failed');
        if (failed.length > 0) {
          const failure = adChangesFailure(operations, failed);
          this.logger.warn(failure.message);
          this.eventEmitter.emit(DomainEventType.PROVISIONING_FAILED, aggregateId, {
            ...(identityId ? { identityId } : {}),
            connector: 'ad',
            error: failure.message,
            retryable: !(failure instanceof ApplicationFailure && failure.nonRetryable),
            partialFailure: true,
          });
          throw failure;
        }

        // No DN (it holds the person's name), mail or UPN: the event reaches the audit log
        this.eventEmitter.emit(DomainEventType.PROVISIONING_COMPLETED, aggregateId, {
          ...(identityId ? { identityId } : {}),
          connector: 'ad',
          operations: operations.map((op) => ({
            action: op.action,
            type: op.type,
            targetId: op.targetId,
            success: true,
          })),
          durationMs: Date.now() - startTime,
        });

        return {
          success: true as const,
          objectId: result.targetUserId,
          generatedAttributes: result.generatedAttributes,
          skipped: false as const,
          operations,
        };
      },
      { correlationId },
    );
  }

  /**
   * Discover groups under baseDn for Entitlement Catalog.
   * Raw entitlements with metadata are passed to EntitlementCatalogService for PAM classification.
   */
  async discoverAdEntitlements(
    config?: AdConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<{ nativeId: string; name: string; type: string }[]> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const entitlements = await this.adService.discover(config);

        // PAM classification now happens in EntitlementCatalogService.absorbDiscovered()
        // (Brain layer) — discovery just passes raw entitlements with metadata through.
        await this.entitlementCatalog.absorbDiscovered('ad', entitlements);
        return entitlements;
      },
      { correlationId },
    );
  }

  /**
   * Deprovision — disable user (set userAccountControl to 514).
   *
   * Errors propagate to Temporal for automatic retry.
   * Returns false only when config is missing (AD not configured).
   */
  async disableAdUser(
    externalId: string,
    config?: AdConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<boolean> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        // Config-missing guard — legitimate skip (not an error)
        const resolved = config ? this.resolveAdConfig(config) : null;
        if (!config?.host || !resolved) return false;
        return await this.adService.deprovision(config, externalId);
      },
      { correlationId },
    );
  }

  /**
   * A privileged session (privilegedSessionWorkflow): enable a linked admin account by its DN
   * (clear ACCOUNTDISABLE, keep its other userAccountControl flags) or disable it (514). "No such
   * object" for the DN is not-found; a config without host fails at once. Failures pass through
   * asDeprovisionFailure (DN names and emails masked; LDAP errors retried). Emits no event: the
   * session's own admin_account events say what happened.
   */
  async setAdUserEnabled(
    externalId: string,
    enabled: boolean,
    config?: AdConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<PamAccountResult> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        try {
          const resolved = config ? this.resolveAdConfig(config) : null;
          if (!config?.host || !resolved) {
            throw new ConnectorException(
              'AD connector config incomplete (no host)',
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          }
          const result = await this.adService.setUserEnabled(config, externalId, enabled);
          this.logger.log(`AD ${enabled ? 'enable' : 'disable'}: ${result.outcome}`);
          return result;
        } catch (error: unknown) {
          throw asDeprovisionFailure('ad', error);
        }
      },
      { correlationId },
    );
  }

  /**
   * Offboarding (patch offboarding:ad-deprovision-outcome): disable the account by its DN and
   * say what happened. "No such object" for the DN is already gone; a config without host
   * fails at once. Failures pass through asDeprovisionFailure, which masks the DN's name and
   * emails (the message reaches workflow history and the Leavers page); LDAP errors are retried.
   * A disabled account emits provisioning.deprovisioned (under `identityId`, the identity the
   * caller names; never the DN).
   */
  async deprovisionAdUser(
    externalId: string,
    config?: AdConfig,
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
          const resolved = config ? this.resolveAdConfig(config) : null;
          if (!config?.host || !resolved) {
            throw new ConnectorException(
              'AD connector config incomplete (no host)',
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          }
          result = await this.adService.deprovisionUser(config, externalId);
          this.logger.log(`AD deprovision: ${result.outcome}`);
        } catch (error: unknown) {
          throw asDeprovisionFailure('ad', error);
        }
        if (result.outcome === 'deprovisioned') {
          this.eventEmitter.emit(DomainEventType.PROVISIONING_DEPROVISIONED, identityId ?? 'ad', {
            ...(identityId ? { identityId } : {}),
            connector: 'ad',
            ...(result.detail ? { detail: result.detail } : {}),
          });
        }
        return result;
      },
      { correlationId },
    );
  }
}
