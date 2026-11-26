import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import { isValidObjectId } from 'mongoose';
import { EntraService } from '../modules/connectors/entra-connector/entra.service';
import { ProvisioningIntent } from '@shared/interfaces/provisioning.interface';
import { EntraConfig } from '../modules/connectors/entra-connector/entra.interface';
import { ENTRA_SYSTEM } from '../modules/connectors/entra-connector/entra.constants';
import { IdentityService } from '../modules/identity/identity.service';
import {
  liveTargetAccountId,
  provisionedSystems,
} from '../modules/identity/identity-provisioning.service';
import { getSystemType } from '@shared/utils/normalize-system-name';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { IdentityDocument } from '../modules/identity/schemas/identity.schema';
import type {
  ProvisioningOperationResult,
  ProvisioningResult,
} from '@shared/dtos/provisioning-result.dto';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EntitlementCatalogService } from '../modules/entitlement-catalog/entitlement-catalog.service';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import type { DeprovisionResult } from '@shared/types/deprovision';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { asDeprovisionFailure, maskEmails } from './deprovision-failure';
import { entraChangesFailure } from './entra-changes-failure';
import { eventAccountId, provisioningSubject } from './target-provision';

/**
 * [ACTIVITIES] Entra ID Activities
 * ---------------------------------
 * Temporal-compatible activities for Microsoft Entra ID operations.
 * These are called by workflows to provision users to Entra ID.
 *
 * ARCHITECTURE:
 * - Activities are the "hands" that do work
 * - EntraService is the "dumb pipe" to Entra ID (5-File Pattern)
 * - EntraService.provision() handles mapping (via Mapper) and execution (via Client) internally
 * - provisionUserToEntra, disableEntraUser, enableEntraUser and offboarding's deleteUser classify
 *   failures like offboarding (asDeprovisionFailure): a 4xx Graph answer other than 408/409/429,
 *   refused credentials (401) and an incomplete or missing Entra ID config (400) fail at once
 *   with ApplicationFailure.nonRetryable; a 429 waits its retry-after; a 5xx, no answer or
 *   another error is retried per the caller's retry policy. Messages have emails masked.
 * - A group, directory role or license change Entra ID did not make fails provisionUserToEntra
 *   (entra-changes-failure.ts), after the other changes were made
 * - 409 Conflict = idempotent success (Safety Rule 7)
 */
@Injectable()
export class EntraActivities {
  private readonly logger = new Logger(EntraActivities.name);

  constructor(
    private readonly entraService: EntraService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly entitlementCatalog: EntitlementCatalogService,
    private readonly identityService: IdentityService,
  ) {}

  /**
   * Health Check Activity
   * Used by connector management to verify Entra ID is reachable.
   * Health checks legitimately return false on failure (not retried by Temporal).
   */
  async checkEntraHealth(
    config?: EntraConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<boolean> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        try {
          return await this.entraService.checkConnection(config);
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
   * Whether Entra ID has a config to run on for the canvas config `config` (or none): the same
   * pick as every Entra ID call, canvas config, else the tenant's installed connector config, else
   * ENTRA_* (EntraService.isConfiguredFor). Onboarding asks this before the health check and
   * leaves an Entra ID that is not configured out of the run. A failed config read propagates
   * for Temporal to retry.
   */
  async isEntraConfigured(
    config?: EntraConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<boolean> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(tenantId ?? '', () => this.entraService.isConfiguredFor(config), {
      correlationId,
    });
  }

  /**
   * Provision user to Entra ID
   *
   * The service handles everything internally:
   * - Idempotency check (won't create duplicates)
   * - Mapping via EntraMapper (StandardUser → EntraUser)
   * - Execution via EntraClient (HTTP/Auth)
   * - Intent execution (groups, directory roles, licenses) if provided, each change reported
   *
   * The account: the object id written back for the identity (`accountId` from a caller that
   * read it, else the identity of the profile's `_id`, liveTargetAccountId); an id Entra ID no
   * longer knows fails (422, not retried) instead of creating a second account. Without one,
   * the account is looked up by UPN and created when there is none. `mustExist` (the mover and
   * an edit's sync, syncToEntra): when the identity's Entra ID provisioning entry says it has an
   * account (provisionedSystems), an account without a recorded id is found by the profile's
   * UPN, email or employee id, and none found fails (422, not retried) instead of creating one.
   * `createAs` (a distributed-transaction CREATE): the account is created under that UPN and no
   * account is looked up to update; one in the way fails the call with a conflict
   * (EntraService.createAccount), so the account returned is always one this call created.
   *
   * Returns only when the account call succeeded and every change of the intent was made or was
   * already as requested (`operations`: one result per change). Otherwise it throws, after
   * emitting provisioning.failed: the call's error classified (see the class comment), or, when
   * a change was not made, entraChangesFailure (the other changes stay made; a run that created
   * the account carries it in the failure's details and is not retried).
   */
  async provisionUserToEntra(
    standardUser: StandardUserDto,
    intent?: ProvisioningIntent,
    config?: EntraConfig,
    tenantId?: string,
    correlationId?: string,
    accountId?: string,
    mustExist?: boolean,
    createAs?: string,
  ): Promise<{
    success: true;
    objectId?: string;
    generatedAttributes?: { mail?: string; userPrincipalName?: string };
    upnResolution?: { chosenUpn: string; candidatesChecked: string[] };
    skipped?: boolean;
    operations?: ProvisioningOperationResult[];
  }> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const connector = 'entra-id';
        const subject = provisioningSubject(standardUser, connector);
        const { aggregateId, identityId } = subject;
        const startTime = Date.now();

        this.logger.log(`Starting provision/update for ${maskEmails(standardUser.email)}`);
        let result: ProvisioningResult;
        try {
          const identity = accountId || createAs ? null : await this.identityOf(identityId);
          const account =
            accountId ?? (identity ? liveTargetAccountId(identity, ENTRA_SYSTEM) : undefined);
          const existing =
            mustExist === true &&
            !!identity &&
            provisionedSystems(identity).some((system) => getSystemType(system) === 'entra');
          result = createAs
            ? await this.entraService.createAccount(standardUser, createAs, intent, config)
            : await this.entraService.provision(standardUser, intent, config, account, existing);
        } catch (e: unknown) {
          throw this.provisioningFailed(subject, asDeprovisionFailure(connector, e));
        }
        const failed = (result.operations ?? []).filter((op) => op.outcome === 'failed');
        if (failed.length > 0) {
          throw this.provisioningFailed(subject, entraChangesFailure(result, failed), true);
        }
        this.logger.log(
          `Successfully provisioned/updated ${maskEmails(standardUser.email)} with ID ${result.targetUserId}`,
        );

        const durationMs = Date.now() - startTime;
        const operations = (result.operations ?? []).map((op) => ({
          action: op.action,
          type: op.type,
          targetId: op.targetId,
          success: true,
        }));

        // No generated mail or UPN: the event reaches the audit log and the websocket
        this.eventEmitter.emit(DomainEventType.PROVISIONING_COMPLETED, aggregateId, {
          ...(identityId ? { identityId } : {}),
          connector,
          targetUserId: result.targetUserId,
          operations,
          durationMs,
        });

        return {
          success: true as const,
          objectId: result.targetUserId,
          generatedAttributes: result.generatedAttributes,
          upnResolution: result.upnResolution,
          skipped: false,
          ...(result.operations ? { operations: result.operations } : {}),
        };
      },
      { correlationId },
    );
  }

  /** The identity of the profile's id: its Entra ID account id and provisioning entry. */
  private async identityOf(identityId: string | undefined): Promise<IdentityDocument | null> {
    // Profiles of bulk rows and PAM admin accounts carry no identity id
    if (!identityId || !isValidObjectId(identityId)) return null;
    return this.identityService.findIdentityById(identityId);
  }

  /** Emit provisioning.failed for the failure about to be thrown; returns the failure. */
  private provisioningFailed(
    { aggregateId, identityId }: ReturnType<typeof provisioningSubject>,
    failure: unknown,
    partialFailure = false,
  ) {
    this.eventEmitter.emit(DomainEventType.PROVISIONING_FAILED, aggregateId, {
      ...(identityId ? { identityId } : {}),
      connector: 'entra-id',
      error: failure instanceof Error ? failure.message : String(failure),
      retryable: !(failure instanceof ApplicationFailure && failure.nonRetryable),
      ...(partialFailure ? { partialFailure: true } : {}),
    });
    return failure;
  }

  /**
   * Discovery: Fetch available entitlements (groups + licenses + directory roles) from Entra ID.
   * Raw entitlements with metadata are passed to EntitlementCatalogService for PAM classification.
   *
   * Errors propagate to Temporal for automatic retry.
   * An empty array means "connected, no entitlements found" — not "connection failed."
   */
  async discoverEntitlements(
    config?: EntraConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<{ nativeId: string; name: string; type: string }[]> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const entitlements = await this.entraService.discoverEntitlements(config);

        // PAM classification now happens in EntitlementCatalogService.absorbDiscovered()
        // (Brain layer) — discovery just passes raw entitlements with metadata through.
        await this.entitlementCatalog.absorbDiscovered(ENTRA_SYSTEM, entitlements);
        return entitlements;
      },
      { correlationId },
    );
  }

  /**
   * Resolve an available UPN for a user (validates domain, generates candidates, returns first available).
   * Used by Impact Analysis to show suggested UPN and conflicts.
   *
   * @returns { chosenUpn, candidatesChecked } or throws UpnExhaustedError / InvalidDomainError
   */
  async resolveUpnForUser(
    user: StandardUserDto,
    config?: EntraConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<{ chosenUpn: string; candidatesChecked: string[] }> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      () => this.entraService.resolveAvailableUpn(user, config),
      { correlationId },
    );
  }

  /**
   * Validate UPN availability
   * Returns true if the UPN is available (user does NOT exist).
   *
   * Errors propagate to Temporal for automatic retry.
   * A `false` return means "validated and UPN is taken" — not "we couldn't reach the server."
   */
  async validateUpn(upn: string, tenantId?: string, correlationId?: string): Promise<boolean> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const existingId = await this.entraService.checkUserExists(upn);
        return existingId === null; // true = available, false = taken
      },
      { correlationId },
    );
  }

  /**
   * Bulk UPN validation for Impact Analysis
   */
  async validateBulkUpns(
    upns: string[],
    tenantId?: string,
    correlationId?: string,
  ): Promise<Record<string, boolean>> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const results: Record<string, boolean> = {};
        for (const upn of upns) {
          results[upn] = await this.validateUpn(upn, tenantId, correlationId);
        }
        return results;
      },
      { correlationId },
    );
  }

  /**
   * Disable user (offboarding callers, orphan cleanup, reconciliation, a privileged session's end).
   *
   * Failures are classified (class comment): a client error fails at once, a 5xx or no answer
   * is retried. Returns false only when the user genuinely doesn't exist (not an error).
   * `email` may be the stored object id (Graph takes either). `config`: the canvas config a
   * privileged session reads (privilegedSessionWorkflow); without one the tenant's installed
   * config, else ENTRA_*.
   */
  async disableEntraUser(
    email: string,
    tenantId?: string,
    correlationId?: string,
    config?: EntraConfig,
  ): Promise<boolean> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        try {
          const objectId = await this.entraService.checkUserExists(email, config);
          if (!objectId) {
            this.logger.warn(`User ${maskEmails(email)} not found, cannot disable`);
            return false;
          }

          await this.entraService.disableUser(objectId, config);
          this.logger.log(`Disabled user ${maskEmails(email)}`);
          return true;
        } catch (e: unknown) {
          throw asDeprovisionFailure('entra-id', e);
        }
      },
      { correlationId },
    );
  }

  /**
   * Enable user (reconciliation re-enables a disabled user; a privileged session enables a
   * linked admin account).
   *
   * Failures are classified (class comment): a client error fails at once, a 5xx or no answer
   * is retried. Returns false only when the user genuinely doesn't exist (not an error).
   * `email` may be the stored object id; `config` as for disableEntraUser.
   */
  async enableEntraUser(
    email: string,
    tenantId?: string,
    correlationId?: string,
    config?: EntraConfig,
  ): Promise<boolean> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        try {
          const objectId = await this.entraService.checkUserExists(email, config);
          if (!objectId) {
            this.logger.warn(`User ${maskEmails(email)} not found, cannot enable`);
            return false;
          }

          await this.entraService.enableUser(objectId, config);
          this.logger.log(`Enabled user ${maskEmails(email)}`);
          return true;
        } catch (e: unknown) {
          throw asDeprovisionFailure('entra-id', e);
        }
      },
      { correlationId },
    );
  }

  /**
   * Delete user from Entra ID (for offboarding).
   *
   * This is a destructive operation that permanently removes the user from Entra ID.
   * In production, consider using disableEntraUser() instead for safety.
   *
   * Errors propagate to Temporal for automatic retry.
   * Idempotent: user not found = success (already deleted), reported as outcome already-gone.
   *
   * `byEmail` (offboarding without a stored objectId): `email` is only the email, so a Graph 404
   * on it as UPN is not proof the account is gone. The user is then looked up by mail or
   * userPrincipalName and deleted by its id; no match fails without retry for an admin to
   * check, never "already gone".
   *
   * Offboarding passes `byEmail` (true or false); its failures then go through
   * asDeprovisionFailure like the other connectors' deprovision activities: emails in the
   * message are masked (it reaches workflow history and the Leavers page), a 429 waits the
   * retry-after and other client errors fail at once. Other callers keep the raw error.
   *
   * A deletion emits provisioning.deprovisioned for the audit log, like the other connectors'
   * deprovision activities: under `identityId` when the caller named the identity (offboarding,
   * expiry, access review), else under the connector (orphan cleanup, bulk delete), with the
   * object id when `email` is one. The callers record what they removed themselves (the
   * identity timeline, the orphan's drift, the bulk job). An account already gone emits nothing.
   *
   * @param email - Graph user id (offboarding passes the stored objectId) or UPN/email
   * @param identityId - the identity whose account it is, for the event; none for an orphan
   */
  async deleteUser(
    email: string,
    config?: EntraConfig,
    identityId?: string,
    tenantId?: string,
    correlationId?: string,
    byEmail?: boolean,
  ): Promise<{ success: true; outcome: DeprovisionResult['outcome'] }> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const connector = 'entra-id';
        // `email` is the account's email when no objectId is stored: masked in the logs
        const who = maskEmails(email);
        this.logger.log(`Attempting to delete user: ${who}`);

        let deleted: boolean;
        try {
          deleted =
            (await this.entraService.deleteUser(email, config)) ||
            (byEmail === true && (await this.deleteFoundByEmail(email, config)));
        } catch (error: unknown) {
          throw byEmail === undefined ? error : asDeprovisionFailure(connector, error);
        }

        if (deleted) {
          this.logger.log(`Successfully deleted ${who} from Entra ID`);
          const targetUserId = eventAccountId(email);
          this.eventEmitter.emit(
            DomainEventType.PROVISIONING_DEPROVISIONED,
            identityId ?? connector,
            {
              ...(identityId ? { identityId } : {}),
              connector,
              ...(targetUserId ? { targetUserId } : {}),
              detail: 'deleted',
            },
          );
        } else {
          this.logger.warn(`User ${who} not found in Entra ID (may already be deleted)`);
        }

        // outcome: what offboarding reports (a 404 from Graph is already gone)
        return { success: true as const, outcome: deleted ? 'deprovisioned' : 'already-gone' };
      },
      { correlationId },
    );
  }

  /**
   * Delete the user whose mail or UPN is `email` (false: gone between lookup and delete); no such
   * user is a failure an admin must check.
   */
  private async deleteFoundByEmail(email: string, config?: EntraConfig): Promise<boolean> {
    const found = await this.entraService.getUserByEmail(email, config);
    if (!found) {
      throw asDeprovisionFailure(
        'entra-id',
        new ConnectorException(
          'No Entra ID user has the email as userPrincipalName or mail, and no object id is ' +
            'stored: the account may exist under another UPN. Check Entra ID, delete the user ' +
            'there and mark it removed manually.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        ),
      );
    }
    return this.entraService.deleteUser(found.id, config);
  }
}
