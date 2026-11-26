/**
 * Orphan Cleanup Activities
 *
 * Temporal activities for the orphan cleanup workflow lifecycle:
 * emit event, disable/delete in target, adopt (link to identity), update drift.
 */

import { Injectable, Logger } from '@nestjs/common';
import { EntraActivities } from './entra.activities';
import { DriftService } from '../modules/reconciliation/drift.service';
import { IdentityService } from '../modules/identity/identity.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import { orphanEventIdentifier } from '../modules/reconciliation/orphan-event-identifier';
import { maskPersonalData } from './deprovision-failure';
import { OrphanDetectionService } from '../modules/reconciliation/orphan-detection.service';
import { AdService } from '../modules/connectors/ad-connector/ad.service';
import { SCIMService } from '../modules/connectors/scim-connector/scim.service';
import { ConnectorConfigService } from '../modules/connectors/connector-config.service';
import type { TargetAccount } from '@shared/interfaces/provisioning.interface';
import { setTargetAccountEnabled } from './reconciliation-account-state';
import { orphanDeleteRefusal } from '@shared/utils/orphan-delete-policy';
import { loadScimConfig } from '../modules/reconciliation/reconciliation-target-config';

/** An orphan drift in one of these still awaits a decision. */
const UNDECIDED_STATUSES = ['open', 'quarantined'];

@Injectable()
export class OrphanActivities {
  private readonly logger = new Logger(OrphanActivities.name);

  constructor(
    private readonly entraActivities: EntraActivities,
    private readonly driftService: DriftService,
    private readonly identityService: IdentityService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly orphanDetection: OrphanDetectionService,
    private readonly adService: AdService,
    private readonly scimService: SCIMService,
    private readonly connectorConfig: ConnectorConfigService,
  ) {}

  /**
   * Whether the cleanup of `driftId` may still disable or delete its account (orphan cleanup,
   * patch orphan-cleanup:recheck-before-acting): the drift is still undecided and the account
   * still an orphan (OrphanDetectionService.isStillOrphan: no live identity has it by UPN, mail,
   * id or objectGUID, and it is no guest or excluded account). An account that is no longer an
   * orphan has its drift closed (DriftService.closeOrphanDrift); a decided drift is left as it is.
   * `accountIdentifier`: the cleanup's (the account's UPN, else its mail).
   */
  async confirmOrphan(
    driftId: string,
    accountIdentifier: string,
    tenantId: string,
    correlationId?: string,
  ): Promise<{ orphan: boolean; reason?: string }> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        const drift = await this.driftService.getDriftById(driftId);
        if (!drift || drift.type !== 'ORPHAN_ACCOUNT') {
          return { orphan: false, reason: 'its drift no longer exists' };
        }
        if (!UNDECIDED_STATUSES.includes(drift.status)) {
          return { orphan: false, reason: `its drift is ${drift.status}` };
        }
        const externalId = drift.orphanDetails?.externalId ?? drift.userId;
        const account: TargetAccount = {
          id: externalId,
          objectGuid: externalId,
          userPrincipalName: accountIdentifier,
          mail: drift.userEmail ?? undefined,
        };
        if (await this.orphanDetection.isStillOrphan(account)) return { orphan: true };
        await this.driftService.closeOrphanDrift(driftId, 'no_longer_orphan');
        this.logger.log(`[Orphan] Drift ${driftId}: the account is no longer an orphan, closed`);
        return {
          orphan: false,
          reason: 'the account is no longer an orphan (an identity has it, or it is excluded)',
        };
      },
      { correlationId },
    );
  }

  /**
   * Get orphan cleanup config from env (for workflow determinism — workflows cannot read process.env).
   */
  async getOrphanConfig(): Promise<{
    gracePeriodDays: number;
    extendedGraceDays: number;
    autoDeleteAfterExtended: boolean;
  }> {
    const gracePeriodDays = Math.max(1, parseInt(process.env.ORPHAN_GRACE_PERIOD_DAYS ?? '30', 10));
    const extendedGraceDays = Math.max(
      1,
      parseInt(process.env.ORPHAN_EXTENDED_GRACE_DAYS ?? '30', 10),
    );
    const autoDeleteAfterExtended = process.env.ORPHAN_AUTO_DELETE_AFTER_EXTENDED === 'true';
    return { gracePeriodDays, extendedGraceDays, autoDeleteAfterExtended };
  }

  /**
   * orphan.detected from the cleanup workflow: only histories from before the patch
   * orphan-cleanup:detection-emits-orphan-detected call it (detection emits the event now).
   */
  async emitOrphanDetected(
    driftId: string,
    targetSystem: string,
    externalId: string,
    accountIdentifier: string,
    tenantId: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        this.eventEmitter.emit(DomainEventType.ORPHAN_DETECTED, externalId, {
          driftId,
          targetSystem,
          externalId,
          // The opaque account id, else masked: never the UPN or mail in clear
          accountIdentifier: orphanEventIdentifier(externalId, accountIdentifier),
          tenantId,
        });
        this.logger.log(`[Orphan] Emitted ORPHAN_DETECTED for drift ${driftId}`);
      },
      { correlationId },
    );
  }

  async disableOrphanAccount(
    targetSystem: string,
    accountIdentifier: string,
    tenantId: string,
    correlationId?: string,
  ): Promise<boolean> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        // Entra ID by the UPN or mail, AD by the DN it finds, SCIM by userName or email
        const outcome = await setTargetAccountEnabled(
          {
            entraActivities: this.entraActivities,
            adService: this.adService,
            scimService: this.scimService,
            connectorConfig: this.connectorConfig,
          },
          targetSystem,
          accountIdentifier,
          false,
          tenantId,
        );
        this.logger.log(
          `[Orphan] Disabled ${maskPersonalData(accountIdentifier)} in ${targetSystem}: ` +
            (outcome.success ? 'true' : `false (${outcome.error})`),
        );
        return outcome.success;
      },
      { correlationId },
    );
  }

  /**
   * Delete the orphan account. `externalId`: the id detection recorded for it (the drift's
   * externalId), passed by cleanups started after the patch orphan-cleanup:delete-by-external-id;
   * an Entra ID or SCIM account is deleted by it, else found by the identifier.
   */
  async deleteOrphanAccount(
    targetSystem: string,
    accountIdentifier: string,
    tenantId: string,
    correlationId?: string,
    externalId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        if (targetSystem === 'entra-id') {
          // Graph takes the object id where it takes the UPN: by it, a renamed orphan is still
          // found and a UPN another account took over names no one else
          const result = await this.entraActivities.deleteUser(
            externalId ?? accountIdentifier,
            undefined,
            undefined,
            tenantId,
          );
          this.logger.log(
            `[Orphan] Deleted ${maskPersonalData(externalId ?? accountIdentifier)} in ${targetSystem}: ${result.success}`,
          );
          return result;
        }
        const refusal = orphanDeleteRefusal(targetSystem);
        if (refusal) {
          // EuroID never deletes an AD account (orphan-delete-policy.ts)
          this.logger.warn(`[Orphan] Not deleting an account in ${targetSystem}: never deleted`);
          return { success: false, error: refusal };
        }
        if (targetSystem === 'scim') {
          const result = await this.deleteScimAccount(accountIdentifier, externalId);
          this.logger.log(
            `[Orphan] Deleted ${maskPersonalData(accountIdentifier)} in scim: ${result.success}`,
          );
          return result;
        }
        this.logger.warn(`[Orphan] Unknown system ${targetSystem}, cannot delete`);
        return { success: false, error: `Unknown system: ${targetSystem}` };
      },
      { correlationId },
    );
  }

  /**
   * SCIM: DELETE /Users/{id} (whatever the connector's deprovisionStrategy says: an orphan delete
   * removes the account), by the SCIM id the drift holds (`externalId`), else, for a cleanup
   * started before it was passed, of the user whose userName or email the identifier is. A user
   * already gone (404) counts as deleted; none found is a failure, the drift stays quarantined.
   */
  private async deleteScimAccount(
    accountIdentifier: string,
    externalId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const config = await loadScimConfig(this.connectorConfig);
    if (!config) return { success: false, error: 'No scim connector config is installed' };
    const result = await this.scimService.deleteUser(
      config,
      externalId
        ? { id: externalId }
        : { userNames: [accountIdentifier], emails: [accountIdentifier] },
    );
    return result.outcome === 'not-found'
      ? { success: false, error: 'No such account in scim' }
      : { success: true };
  }

  /**
   * An orphan EuroID does not delete (an AD account): the drift stays quarantined, the account
   * as it is (disabled after the first grace period), and `reason` goes on the drift
   * (orphanDetails.keptReason) for the orphan list to show.
   */
  async keepOrphanAccount(
    driftId: string,
    reason: string,
    tenantId: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        await this.driftService.updateOrphanDrift(driftId, { 'orphanDetails.keptReason': reason });
        this.logger.log(`[Orphan] Drift ${driftId}: the account is kept (${reason})`);
      },
      { correlationId },
    );
  }

  async adoptOrphanAccount(
    driftId: string,
    identityId: string,
    targetSystem: string,
    externalId: string,
    decidedBy: string,
    tenantId: string,
    correlationId?: string,
  ): Promise<boolean> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        try {
          const identity = await this.identityService.pushSourceAndReconcile(
            identityId,
            targetSystem,
            externalId,
            {},
            { sourceRole: 'target' },
          );
          if (identity) {
            await this.driftService.updateOrphanDrift(driftId, {
              status: 'corrected',
              correctedAt: new Date(),
              'orphanDetails.decision': 'ADOPT',
              'orphanDetails.decidedBy': decidedBy,
              'orphanDetails.adoptedIdentityId': identityId,
            });
            this.logger.log(`[Orphan] Adopted ${externalId} to identity ${identityId}`);
            return true;
          }
          return false;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          this.logger.error(`[Orphan] Adopt failed: ${msg}`);
          throw e;
        }
      },
      { correlationId },
    );
  }

  async updateOrphanDriftStatus(
    driftId: string,
    status: 'corrected' | 'ignored',
    decision: 'DELETE' | 'ADOPT',
    decidedBy: string,
    tenantId: string,
    adoptedIdentityId?: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        await this.driftService.updateOrphanDrift(driftId, {
          status,
          correctedAt: new Date(),
          'orphanDetails.decision': decision,
          'orphanDetails.decidedBy': decidedBy,
          'orphanDetails.adoptedIdentityId': adoptedIdentityId,
        });
        this.logger.log(`[Orphan] Updated drift ${driftId} to ${status}`);
      },
      { correlationId },
    );
  }

  async setOrphanDisabledAt(
    driftId: string,
    tenantId: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        await this.driftService.updateOrphanDrift(driftId, {
          'orphanDetails.disabledAt': new Date(),
        });
      },
      { correlationId },
    );
  }

  async updateDriftWorkflowId(
    driftId: string,
    workflowId: string,
    tenantId: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        await this.driftService.updateDriftWorkflowId(driftId, workflowId);
      },
      { correlationId },
    );
  }
}
