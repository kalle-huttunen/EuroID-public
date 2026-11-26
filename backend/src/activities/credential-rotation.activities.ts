import { Injectable, Logger } from '@nestjs/common';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type {
  CredentialExpiringSoonPayload,
  CredentialInventoryUpdatedPayload,
} from '@infrastructure/events/event-payloads';
import { TenantService } from '@infrastructure/multi-tenancy/tenant.service';
import { CREDENTIAL_INVENTORY_REFRESH_LIMIT } from '@infrastructure/config/defaults';
import { CredentialInventoryService } from '../modules/credential-lifecycle/credential-inventory.service';
import type { CredentialInventoryDocument } from '../modules/credential-lifecycle/schemas/credential-inventory.schema';
import type { CredentialRotationResult } from '../workflows/credential-rotation.workflow';
import { CredentialInventoryRefresh } from './credential-inventory-refresh';
import { maskPersonalData } from './deprovision-failure';

const DAY_MS = 86_400_000;

/**
 * Why a due credential was not reset, in its credential.expiring_soon event. EuroID has no secret
 * storage to hand a generated password to, so it resets nothing: a password nobody receives locks
 * a person out and breaks a service account's consumers. A person's password (a memorized secret,
 * NIST SP 800-63B) is never to be reset automatically, also once secret storage exists.
 */
export const NO_RESET_REASON =
  'Not reset: automatic reset needs secret storage, which EuroID does not have. ' +
  'Change the password in the target system.';

/**
 * [ACTIVITIES] Credential Rotation Activities
 * -----------------------------------------------
 * The nightly credential rotation CronWorkflow lists the active tenants
 * (listCredentialRotationTenants) and runs runCredentialRotationBatch once per tenant (patch
 * credential-rotation:per-tenant). Per tenant:
 *   1. Refresh credential_inventory from Entra ID and AD (CredentialInventoryRefresh).
 *   2. Move rows not read this run whose due date has passed to EXPIRED.
 *   3. Report: credential.inventory_updated once, with counts only (accounts read, rows whose
 *      status changed, rows UNKNOWN, rows removed); credential.expiring_soon for each EXPIRED
 *      credential (negative daysRemaining and NO_RESET_REASON) and each EXPIRING_SOON one, up to
 *      `batchSize` of each, the ones reported longest ago (or never) first, so with more due than
 *      that every credential is still reported on a later night.
 *
 * It resets no password and leaves the next rotation date as the target's last password change
 * gives it, so a due credential stays due until someone changes the password in the target.
 */
@Injectable()
export class CredentialRotationActivities {
  private readonly logger = new Logger(CredentialRotationActivities.name);

  constructor(
    private readonly inventoryService: CredentialInventoryService,
    private readonly refresh: CredentialInventoryRefresh,
    private readonly tenantService: TenantService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** The tenants the schedule's run covers: every active tenant. */
  async listCredentialRotationTenants(): Promise<string[]> {
    return this.activeTenantIds();
  }

  /**
   * @param tenantId - one tenant; '' for every active tenant in this one call (runs started
   *   before the patch credential-rotation:per-tenant)
   * @param batchSize - at most this many overdue and this many expiring-soon events per tenant
   */
  async runCredentialRotationBatch(
    tenantId: string,
    nowIso: string,
    batchSize: number,
  ): Promise<CredentialRotationResult> {
    const now = new Date(nowIso);
    const tenantIds = tenantId ? [tenantId] : await this.activeTenantIds();
    const total: Required<CredentialRotationResult> = {
      rotated: 0,
      failed: 0,
      notified: 0,
      statusesUpdated: 0,
      observed: 0,
      unknown: 0,
      removed: 0,
      overdue: 0,
    };
    for (const tid of tenantIds) {
      validateActivityContext({ tenantId: tid });
      const result = await withTenantContext(tid, () => this.runTenant(tid, now, batchSize));
      for (const field of Object.keys(total) as Array<keyof typeof total>) {
        total[field] += result[field] ?? 0;
      }
    }
    return total;
  }

  private async activeTenantIds(): Promise<string[]> {
    const tenants = await this.tenantService.findAll();
    return tenants.filter((t) => t.status === 'active').map((t) => t.tenantId);
  }

  private async runTenant(
    tenantId: string,
    now: Date,
    batchSize: number,
  ): Promise<CredentialRotationResult> {
    const refreshed = await this.refresh.refreshTenant(
      tenantId,
      now,
      CREDENTIAL_INVENTORY_REFRESH_LIMIT,
    );
    // Rows read this run have their status from their own policy. For the others only the due
    // date passing is certain (their warning window is their policy's): 0 days moves only those.
    const statuses = await this.inventoryService.recalculateStatuses(tenantId, now, 0);
    const inventoryUpdated: CredentialInventoryUpdatedPayload = {
      refreshed: refreshed.observed,
      changed: refreshed.changed + statuses.updated,
      unknown: refreshed.unknown,
      removed: refreshed.removed,
    };
    this.eventEmitter.emit(
      DomainEventType.CREDENTIAL_INVENTORY_UPDATED,
      tenantId,
      inventoryUpdated,
    );

    const overdue = await this.inventoryService.findDueToReport(tenantId, 'EXPIRED', batchSize);
    for (const cred of overdue) this.emitDue(cred, now, NO_RESET_REASON);
    const soon = await this.inventoryService.findDueToReport(tenantId, 'EXPIRING_SOON', batchSize);
    for (const cred of soon) this.emitDue(cred, now);
    await this.inventoryService.markDueReported(
      tenantId,
      [...overdue, ...soon].map((cred) => cred._id),
      now,
    );

    this.logger.log(
      `[CredentialRotation] Tenant ${tenantId}: read ${refreshed.observed} account(s) ` +
        `(${refreshed.unknown} unknown, ${refreshed.removed} removed), ${overdue.length} overdue ` +
        `reported and not reset, ${soon.length} expiring soon`,
    );
    return {
      rotated: 0,
      failed: 0,
      notified: soon.length,
      statusesUpdated: statuses.updated,
      observed: refreshed.observed,
      unknown: refreshed.unknown,
      removed: refreshed.removed,
      overdue: overdue.length,
    };
  }

  /** credential.expiring_soon: daysRemaining <= 0 when due. No password, the AD DN's name masked. */
  private emitDue(cred: CredentialInventoryDocument, now: Date, reason?: string): void {
    const due = cred.password?.nextRotation;
    if (!due) return;
    const expiresAt = new Date(due);
    const payload: CredentialExpiringSoonPayload = {
      identityId: cred.identityId,
      targetSystem: cred.targetSystem,
      externalId: maskPersonalData(cred.externalId ?? ''),
      expiresAt: expiresAt.toISOString(),
      daysRemaining: Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS),
      ...(reason ? { reason } : {}),
    };
    this.eventEmitter.emit(DomainEventType.CREDENTIAL_EXPIRING_SOON, cred.identityId, payload);
  }
}
