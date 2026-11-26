/**
 * Reconciliation Activities
 *
 * Detects and corrects drift between the Identity Hub (source of truth)
 * and target systems (Entra ID, Active Directory, etc.).
 *
 * RESPONSIBILITIES:
 * - Fetch current state from all systems
 * - Compare with Hub golden records
 * - Detect discrepancies (drift)
 * - Auto-correct when safe
 * - Report drifts requiring manual review
 */

import { heartbeat, heartbeatEvery } from './activity-heartbeat';
import { Injectable, Logger } from '@nestjs/common';
import { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';
import {
  DriftDetectionResult,
  DriftDetectionResultInput,
  SystemDrift,
  DriftType,
  UserSnapshot,
  ReconciliationReport,
  CorrectionAction,
  CorrectionActionInput,
} from '@shared/dtos/distributed-transaction.dto';
import { IdentityService } from '../modules/identity/identity.service';
import { EntraActivities } from './entra.activities';
import { EntraService } from '../modules/connectors/entra-connector/entra.service';
import { AdService } from '../modules/connectors/ad-connector/ad.service';
import { SCIMService } from '../modules/connectors/scim-connector/scim.service';
import { ConnectorConfigService } from '../modules/connectors/connector-config.service';
import { ConnectorConfigDecryptError } from '../modules/connectors/connector-config.errors';
import { OrphanDetectionService } from '../modules/reconciliation/orphan-detection.service';
import { DriftService, type DetectedDrift } from '../modules/reconciliation/drift.service';
import {
  loadAdConfig,
  loadScimConfig,
} from '../modules/reconciliation/reconciliation-target-config';
import type { DriftSeverity } from '../modules/reconciliation/schemas/drift.schema';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { DriftThresholdExceededPayload } from '@infrastructure/events/event-payloads';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { maskEmails } from './deprovision-failure';
import { EmailNotificationService } from '../modules/notifications/email-notification.service';
import type { DriftThresholdNotice } from '../workflows/workflow-types';
import type { ReconciliationScope } from '@shared/utils/reconciliation-scope';
import { targetAccountEnabled } from '@shared/utils/linked-admin-profile';
import {
  compareAccountState,
  setTargetAccountEnabled,
  type AccountStateDeps,
} from './reconciliation-account-state';

/** A target system in the reconciliation config without an installed connector config. */
function notInstalled(system: string): ConnectorException {
  return new ConnectorException(
    `No ${system} connector config is installed: install the connector, or leave ${system} out ` +
      "of the reconciliation's target systems.",
  );
}

/**
 * How often runOrphanDetection heartbeats while it runs, whatever it is doing: AD and SCIM list
 * the whole directory in one call, with no page to heartbeat after. Well inside the workflow's
 * heartbeat timeout for the activity (2 minutes, reconciliation.workflow.ts).
 */
export const ORPHAN_DETECTION_HEARTBEAT_MS = 30_000;

/** Identities per fetchHubUsersPage result unless RECONCILIATION_PAGE_SIZE says otherwise. */
const DEFAULT_RECONCILIATION_PAGE_SIZE = 200;

/** The page size fetchHubUsersPage keeps to (RECONCILIATION_PAGE_SIZE, 1 to 5000). */
function reconciliationPageSize(): number {
  const configured = parseInt(process.env.RECONCILIATION_PAGE_SIZE ?? '', 10);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(5000, configured)
    : DEFAULT_RECONCILIATION_PAGE_SIZE;
}

/** What drift detection reads of an identity, and all the batch's history carries of it. */
const DETECTION_FIELDS = [
  '_id',
  'email',
  'status',
  'displayName',
  'firstName',
  'lastName',
  'sourceSystem',
  'sourceUserId',
  'employmentType',
  'tenantId',
] as const;

/**
 * The identity's key fields (DETECTION_FIELDS): a page of whole profiles went over Temporal's
 * payload limit, and the report and the batch result carried every drifting user's profile.
 * correctDrift re-reads the stored identity before it changes anything.
 */
function detectionSubject(user: StandardUserDto): StandardUserDto {
  const record = user as unknown as Record<string, unknown>;
  const subject: Record<string, unknown> = {};
  for (const field of DETECTION_FIELDS) {
    if (record[field] !== undefined && record[field] !== null) subject[field] = record[field];
  }
  return subject as unknown as StandardUserDto;
}

/** The identity's id, which drift ids, texts and records carry: never its email. */
function identityIdOf(user: { _id?: unknown }): string | undefined {
  return user._id ? String(user._id) : undefined;
}

/** A detected drift as DriftService stores it. */
function toDetectedDrift(drift: SystemDrift): DetectedDrift {
  return {
    targetSystem: drift.system,
    type: drift.driftType,
    ...(drift.field !== undefined && { field: drift.field }),
    severity: drift.severity.toLowerCase() as DriftSeverity,
    ...(drift.expectedValue !== undefined && { hubValue: String(drift.expectedValue) }),
    ...(drift.actualValue !== undefined && { targetValue: String(drift.actualValue) }),
    autoCorrectEligible: drift.autoCorrect,
  };
}

export interface OrphanDetectionResultItem {
  driftId: string;
  targetSystem: string;
  externalId: string;
  accountIdentifier: string;
  tenantId: string;
}

@Injectable()
export class ReconciliationActivities {
  private readonly logger = new Logger(ReconciliationActivities.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly entraActivities: EntraActivities,
    private readonly entraService: EntraService,
    private readonly adService: AdService,
    private readonly scimService: SCIMService,
    private readonly connectorConfig: ConnectorConfigService,
    private readonly orphanDetection: OrphanDetectionService,
    private readonly driftService: DriftService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly emailNotifications: EmailNotificationService,
  ) {}

  /** The connectors setTargetAccountEnabled changes an account's enabled state through. */
  private get accountStateDeps(): AccountStateDeps {
    return {
      entraActivities: this.entraActivities,
      adService: this.adService,
      scimService: this.scimService,
      connectorConfig: this.connectorConfig,
    };
  }

  /**
   * Fetch a page of users from Identity Hub (streaming/cursor-based).
   * Avoids loading all users into memory. pageToken is skip value as string (e.g. "0", "100").
   * At most RECONCILIATION_PAGE_SIZE (default 200) identities, whatever `pageSize` asks: a full
   * page has a nextPageToken, and the batch fetches the rest of its range page by page. Each
   * identity's key fields only (detectionSubject).
   * `scope`: the run's includedDepartments and excludedUsers, the same that
   * getReconciliationUserCount counted with (the batches' skip/limit ranges are over that count).
   */
  async fetchHubUsersPage(
    tenantId: string,
    pageToken: string,
    pageSize: number,
    scope?: ReconciliationScope,
    correlationId?: string,
  ): Promise<{ users: StandardUserDto[]; nextPageToken: string | null; total?: number }> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const skip = Math.max(0, parseInt(pageToken, 10) || 0);
        const limit = Math.min(reconciliationPageSize(), Math.max(1, pageSize));
        const { users, total } = scope
          ? await this.identityService.findUsersPageForReconciliation(skip, limit, scope)
          : await this.identityService.findUsersPageForReconciliation(skip, limit);
        const nextPageToken = users.length === limit ? String(skip + limit) : null;
        this.logger.debug(
          `[Reconciliation] Page skip=${skip} limit=${limit} got ${users.length} users`,
        );
        return {
          users: (users as unknown as StandardUserDto[]).map(detectionSubject),
          nextPageToken,
          total,
        };
      },
      { correlationId },
    );
  }

  /**
   * Get total user count for reconciliation batch planning.
   * Uses skip=0 to trigger total count in findUsersPageForReconciliation.
   * `scope`: the run's includedDepartments and excludedUsers; every batch fetches with it too.
   */
  async getReconciliationUserCount(
    tenantId: string,
    scope?: ReconciliationScope,
    correlationId?: string,
  ): Promise<number> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const { total } = scope
          ? await this.identityService.findUsersPageForReconciliation(0, 1, scope)
          : await this.identityService.findUsersPageForReconciliation(0, 1);
        return total ?? 0;
      },
      { correlationId },
    );
  }

  /**
   * Return current time for workflow determinism (workflows cannot use Date.now()).
   */
  async getWorkflowStartTime(): Promise<Date> {
    return new Date();
  }

  /**
   * Get batch config from env for scatter-gather reconciliation.
   */
  async getReconciliationBatchConfig(): Promise<{ batchCount: number; batchSize: number }> {
    const batchCount = Math.max(1, parseInt(process.env.RECONCILIATION_BATCH_COUNT ?? '10', 10));
    const batchSize = Math.max(100, parseInt(process.env.RECONCILIATION_BATCH_SIZE ?? '5000', 10));
    return { batchCount, batchSize };
  }

  /**
   * Compute batch plan for scatter-gather. Moves Math out of workflow for determinism.
   */
  async getReconciliationBatchPlan(
    tenantId: string,
    totalUsers: number,
  ): Promise<Array<{ skip: number; limit: number; index: number }>> {
    if (totalUsers <= 0) return [];
    const batchConfig = await this.getReconciliationBatchConfig();
    const batchCount = Math.min(
      batchConfig.batchCount,
      Math.ceil(totalUsers / batchConfig.batchSize) || 1,
    );
    const batchSize = Math.ceil(totalUsers / batchCount);
    const batches: Array<{ skip: number; limit: number; index: number }> = [];
    for (let i = 0; i < batchCount; i++) {
      const skip = i * batchSize;
      const limit = Math.min(batchSize, totalUsers - skip);
      if (limit > 0) {
        batches.push({ skip, limit, index: i });
      }
    }
    return batches;
  }

  /**
   * Fetch a single user by id, email, or sourceUserId for on-demand reconciliation.
   */
  async fetchHubUserForReconciliation(
    tenantId: string,
    userId: string,
    correlationId?: string,
  ): Promise<StandardUserDto | null> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        return this.identityService.findUserForReconciliation(
          userId,
        ) as Promise<StandardUserDto | null>;
      },
      { correlationId },
    );
  }

  /**
   * Detect drift for a single user across all systems, and store it (DriftService.recordDetection).
   * A system whose account cannot be read (connector config missing or incomplete, a failed call)
   * is in `systemErrors`: no drift is raised for it, and its stored drifts stay as they are.
   */
  async detectUserDrift(
    user: StandardUserDto,
    targetSystems: string[],
    tenantId?: string,
    correlationId?: string,
  ): Promise<DriftDetectionResult> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        this.logger.debug(`[Reconciliation] Detecting drift for ${maskEmails(user.email)}`);

        const identityId = identityIdOf(user);
        const systemStates = new Map<string, UserSnapshot>();
        const drifts: SystemDrift[] = [];
        const checkedSystems: string[] = [];
        const systemErrors: Array<{ system: string; error: string }> = [];

        for (const system of targetSystems) {
          try {
            const snapshot = await this.fetchUserFromSystem(
              system,
              user.email,
              tenantId,
              correlationId,
            );
            checkedSystems.push(system);

            if (snapshot) {
              systemStates.set(system, snapshot);

              drifts.push(...compareAccountState(user, snapshot, system));
            } else {
              // User missing from system
              drifts.push({
                system,
                driftType: DriftType.MISSING_USER,
                description: `Identity ${identityId} exists in Hub but not in ${system}`,
                severity: user.status === UserStatus.ACTIVE ? 'HIGH' : 'MEDIUM',
                autoCorrect: user.status === UserStatus.ACTIVE,
              });
            }
          } catch (error: unknown) {
            // A config this process cannot decrypt fails the activity (retried), visibly
            if (error instanceof ConnectorConfigDecryptError) throw error;
            const message = maskEmails(error instanceof Error ? error.message : String(error));
            systemErrors.push({ system, error: message });
            this.logger.error(
              `[Reconciliation] Failed to read identity ${identityId} from ${system}: ${message}`,
            );
          }
        }

        if (identityId) {
          await this.driftService.recordDetection(
            {
              identityId,
              displayName:
                user.displayName ||
                `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() ||
                identityId,
              email: user.email,
              checkedSystems,
            },
            drifts.map(toDetectedDrift),
          );
        }

        // Determine overall severity
        const severity = this.calculateSeverity(drifts);

        const result: DriftDetectionResult = {
          userId: user.sourceUserId || user.email,
          email: user.email,
          hasDrift: drifts.length > 0,
          hubState: detectionSubject(user),
          systemStates,
          drifts,
          ...(systemErrors.length > 0 && { systemErrors }),
          severity,
          detectedAt: new Date(),
        };

        // Emit DRIFT_DETECTED for each system that has drift
        if (result.hasDrift) {
          const driftsBySystem = new Map<string, SystemDrift[]>();
          for (const d of drifts) {
            const list = driftsBySystem.get(d.system) || [];
            list.push(d);
            driftsBySystem.set(d.system, list);
          }
          for (const [system, systemDrifts] of driftsBySystem) {
            const worstSeverity = systemDrifts.reduce<string>((a, d) => {
              const order = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
              return order.indexOf(d.severity) > order.indexOf(a) ? d.severity : a;
            }, 'LOW');
            const identityId = user._id?.toString() || user.sourceUserId || user.email;
            this.eventEmitter.emit(DomainEventType.DRIFT_DETECTED, identityId, {
              identityId,
              system,
              severity: worstSeverity,
              discrepancies: systemDrifts.map((d) => ({
                field: d.field || d.driftType,
                expected: String(d.expectedValue ?? ''),
                actual: String(d.actualValue ?? ''),
                action: d.autoCorrect ? ('REVERT' as const) : ('IGNORE' as const),
              })),
            });
          }
        }

        return result;
      },
      { correlationId },
    );
  }

  /**
   * Auto-correct a drift. A correction that succeeds closes the stored drift it fixed
   * (DriftService.closeCorrectedDrift).
   */
  async correctDrift(
    drift: SystemDrift,
    user: StandardUserDto,
    tenantId?: string,
    correlationId?: string,
  ): Promise<CorrectionAction> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const identityId = identityIdOf(user);
        this.logger.log(
          `[Reconciliation] Auto-correcting ${drift.driftType} for identity ${identityId} in ${drift.system}`,
        );

        const action: CorrectionAction = {
          driftId: `${drift.system}:${identityId}:${drift.driftType}`,
          system: drift.system,
          action: this.determineAction(drift),
          user,
          success: false,
          executedAt: new Date(),
        };

        try {
          // The stored identity, as it is now: the batch carries its key fields only
          const current = identityId
            ? ((await this.identityService.findUserForReconciliation(
                identityId,
              )) as StandardUserDto | null)
            : user;
          if (!current) {
            action.error = `Identity ${identityId} is no longer in the hub`;
            this.logger.warn(`[Reconciliation] ${action.error}: ${drift.driftType} not corrected`);
            return action;
          }
          switch (drift.driftType) {
            case DriftType.MISSING_USER:
              // Create the account
              if (drift.system === 'entra-id') {
                await this.entraActivities.provisionUserToEntra(
                  current,
                  undefined,
                  undefined,
                  tenantId,
                );
                action.success = true;
              }
              break;

            case DriftType.ORPHANED_USER:
              // Disable the account
              if (drift.system === 'entra-id') {
                action.success = await this.entraActivities.disableEntraUser(
                  current.email,
                  tenantId,
                );
              }
              break;

            case DriftType.STATUS_MISMATCH: {
              // The state provisioning writes for the hub status (compareAccountState)
              const outcome = await setTargetAccountEnabled(
                this.accountStateDeps,
                drift.system,
                current.email,
                targetAccountEnabled(current),
                tenantId,
              );
              action.success = outcome.success;
              if (outcome.error) action.error = outcome.error;
              break;
            }

            case DriftType.FIELD_MISMATCH:
              if (drift.system === 'entra-id') {
                await this.entraActivities.provisionUserToEntra(
                  current,
                  undefined,
                  undefined,
                  tenantId,
                );
                action.success = true;
              } else {
                action.success = false;
                action.error = `Field correction not supported for system: ${drift.system}`;
              }
              break;

            default:
              action.success = false;
              action.error = `Unsupported drift type: ${drift.driftType}`;
          }

          if (action.success) {
            this.logger.log(`[Reconciliation] Successfully corrected ${drift.driftType}`);
          } else {
            this.logger.warn(
              `[Reconciliation] Failed to correct: ${maskEmails(action.error ?? '')}`,
            );
          }
        } catch (error: unknown) {
          action.success = false;
          const message = error instanceof Error ? error.message : String(error);
          action.error = message;
          this.logger.error(`[Reconciliation] Correction failed: ${maskEmails(message)}`);
        }

        if (action.success && identityId) {
          // The correction is made; a drift left open here closes at the next run
          await this.driftService
            .closeCorrectedDrift(identityId, drift.system, drift.driftType, drift.field)
            .catch((error: unknown) =>
              this.logger.warn(
                `[Reconciliation] Corrected ${drift.driftType} of identity ${identityId} in ` +
                  `${drift.system}, but its drift record was not closed: ${String(error)}`,
              ),
            );
        }

        return action;
      },
      { correlationId },
    );
  }

  /**
   * Run orphan detection for a target system. Returns list of orphans for workflow spawning.
   * `scope`: only its excludedUsers count here (an excluded user's orphan account is left alone);
   * an orphan account has no live identity, so a department does not apply to it.
   */
  async runOrphanDetection(
    system: string,
    tenantId: string,
    scope?: ReconciliationScope,
    correlationId?: string,
  ): Promise<OrphanDetectionResultItem[]> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        // A heartbeat per page of accounts and one on a timer for the whole activity (a long AD
        // or SCIM listing): the workflow's proxy for this activity has a heartbeat timeout
        // (patch reconciliation:orphan-detection-heartbeat)
        const stopHeartbeats = heartbeatEvery(ORPHAN_DETECTION_HEARTBEAT_MS);
        let driftRecords: Awaited<
          ReturnType<OrphanDetectionService['detectOrphans']>
        >['driftRecords'];
        try {
          ({ driftRecords } = await this.orphanDetection.detectOrphans(
            system,
            tenantId,
            scope?.excludedUsers,
            () => heartbeat(),
          ));
        } finally {
          stopHeartbeats();
        }
        return driftRecords.map((d) => ({
          driftId: d._id.toString(),
          targetSystem: d.targetSystem,
          externalId: d.orphanDetails?.externalId ?? d.userId,
          accountIdentifier: d.userEmail ?? d.orphanDetails?.accountName ?? d.userId,
          tenantId: d.tenantId,
        }));
      },
      { correlationId },
    );
  }

  /**
   * Update drift record with orphan cleanup workflow ID (for signaling).
   */
  async updateDriftWorkflowId(
    driftId: string,
    workflowId: string,
    tenantId: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        await this.driftService.updateDriftWorkflowId(driftId, workflowId);
      },
      { correlationId },
    );
  }

  /**
   * A run reached a drift threshold with notifyOnDrift on (dailyReconciliationWorkflow, patch
   * reconciliation:drift-threshold-alerts): one reconciliation.drift_threshold_exceeded event
   * with the counts and the run's ids, and with notifyEmail one mail to that user of the tenant
   * (EmailNotificationService: none when email is off or the address is nobody in the tenant; a
   * failed send is retried from the dead-letter queue). A mail that cannot be sent is logged,
   * never thrown, so a retry does not emit the event again.
   */
  async notifyDriftThresholdExceeded(
    tenantId: string,
    notice: DriftThresholdNotice,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        const payload: DriftThresholdExceededPayload = {
          workflowId: notice.workflowId,
          runId: notice.runId,
          totalDrifts: notice.totalDrifts,
          criticalDrifts: notice.criticalDrifts,
          alerts: notice.alerts,
        };
        this.eventEmitter.emit(
          DomainEventType.RECONCILIATION_DRIFT_THRESHOLD_EXCEEDED,
          notice.runId,
          payload,
        );
        if (!notice.notifyEmail) return;
        try {
          const outcome = await this.emailNotifications.notifyDriftThreshold(tenantId, {
            runId: notice.runId,
            recipientKey: notice.notifyEmail,
            totalDrifts: notice.totalDrifts,
            criticalDrifts: notice.criticalDrifts,
            alerts: notice.alerts,
          });
          this.logger.log(
            `[Reconciliation] Drift threshold mail of run ${notice.runId}: ${outcome}`,
          );
        } catch (error: unknown) {
          const message = maskEmails(error instanceof Error ? error.message : String(error));
          this.logger.warn(
            `[Reconciliation] Drift threshold mail of run ${notice.runId} failed: ${message}`,
          );
        }
      },
      { correlationId },
    );
  }

  /**
   * Generate reconciliation report summary
   */
  async generateReport(
    tenantId: string,
    drifts: DriftDetectionResultInput[],
    corrections: CorrectionActionInput[],
    startTime: Date,
  ): Promise<ReconciliationReport> {
    const endTime = new Date();

    const usersWithDrift = drifts.filter((d) => d.hasDrift).length;
    const totalDrifts = drifts.reduce((sum, d) => sum + d.drifts.length, 0);

    // Count by severity: drifts, as totalDrifts and the threshold alerts count them (an
    // identity with two CRITICAL drifts adds 2), never identities by their worst drift
    const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const result of drifts) {
      for (const drift of result.drifts) bySeverity[drift.severity] += 1;
    }
    const {
      CRITICAL: criticalDrifts,
      HIGH: highDrifts,
      MEDIUM: mediumDrifts,
      LOW: lowDrifts,
    } = bySeverity;

    // Count by type
    const driftsByType = new Map<DriftType, number>();
    for (const result of drifts) {
      for (const drift of result.drifts) {
        const current = driftsByType.get(drift.driftType) || 0;
        driftsByType.set(drift.driftType, current + 1);
      }
    }

    // Count by system
    const driftsBySystem = new Map<string, number>();
    for (const result of drifts) {
      for (const drift of result.drifts) {
        const current = driftsBySystem.get(drift.system) || 0;
        driftsBySystem.set(drift.system, current + 1);
      }
    }

    const autoCorrected = corrections.filter((c) => c.success).length;
    const requiresManualReview = totalDrifts - autoCorrected;

    return {
      reportId: `recon-${tenantId}-${startTime.getTime()}`,
      tenantId,
      totalUsers: drifts.length,
      scannedUsers: drifts.length,
      usersWithDrift,
      totalDrifts,
      criticalDrifts,
      highDrifts,
      mediumDrifts,
      lowDrifts,
      driftsByType,
      driftsBySystem,
      autoCorrected,
      requiresManualReview,
      startedAt: startTime,
      completedAt: endTime,
      durationMs: endTime.getTime() - startTime.getTime(),
      drifts: drifts as DriftDetectionResult[],
    };
  }

  /**
   * Private helper methods
   */

  /**
   * The user's account in `system`, null when the system has none. A system it cannot read (no
   * or an incomplete connector config, a failed call) throws: "no account" would raise a
   * MISSING_USER drift for every user.
   */
  private async fetchUserFromSystem(
    system: string,
    email: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<UserSnapshot | null> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        this.logger.debug(`[Reconciliation] Fetching ${maskEmails(email)} from ${system}...`);
        switch (system) {
          case 'entra-id': {
            const u = await this.entraService.getUserByEmail(email);
            return u ? this.toUserSnapshot(system, u) : null;
          }
          case 'ad': {
            const adConfig = await loadAdConfig(this.connectorConfig);
            if (!adConfig) throw notInstalled(system);
            const u = await this.adService.getUserByEmail(adConfig, email);
            return u ? this.toUserSnapshot(system, u) : null;
          }
          case 'scim': {
            const scimConfig = await loadScimConfig(this.connectorConfig);
            if (!scimConfig) throw notInstalled(system);
            const u = await this.scimService.getUserByEmail(scimConfig, email);
            return u ? this.toUserSnapshot(system, u) : null;
          }
          default:
            throw new ConnectorException(`Reconciliation cannot read accounts in ${system}`);
        }
      },
      { correlationId },
    );
  }

  private toUserSnapshot(
    system: string,
    account: {
      id: string;
      userPrincipalName?: string;
      mail?: string;
      displayName?: string;
      accountEnabled?: boolean;
    },
  ): UserSnapshot {
    const email = account.mail ?? account.userPrincipalName ?? account.id;
    return {
      system,
      userId: account.id,
      email,
      state: {
        id: account.id,
        userPrincipalName: account.userPrincipalName,
        mail: account.mail,
        displayName: account.displayName,
        accountEnabled: account.accountEnabled,
      },
      capturedAt: new Date(),
    };
  }

  private calculateSeverity(drifts: SystemDrift[]): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    if (drifts.length === 0) return 'LOW';

    const hasCritical = drifts.some((d) => d.severity === 'CRITICAL');
    if (hasCritical) return 'CRITICAL';

    const hasHigh = drifts.some((d) => d.severity === 'HIGH');
    if (hasHigh) return 'HIGH';

    const hasMedium = drifts.some((d) => d.severity === 'MEDIUM');
    if (hasMedium) return 'MEDIUM';

    return 'LOW';
  }

  private determineAction(
    drift: SystemDrift,
  ): 'CREATE' | 'UPDATE' | 'DELETE' | 'DISABLE' | 'ENABLE' {
    switch (drift.driftType) {
      case DriftType.MISSING_USER:
        return 'CREATE';
      case DriftType.ORPHANED_USER:
        return 'DISABLE';
      case DriftType.STATUS_MISMATCH:
        // Drifts stored before the expected state was ENABLED or DISABLED carry a hub status
        if (drift.expectedValue === 'DISABLED') return 'DISABLE';
        if (drift.expectedValue === 'ENABLED') return 'ENABLE';
        return 'UPDATE';
      case DriftType.FIELD_MISMATCH:
        return 'UPDATE';
      default:
        return 'UPDATE';
    }
  }
}
