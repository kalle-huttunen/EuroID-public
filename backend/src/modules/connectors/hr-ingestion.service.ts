/**
 * HR Ingestion Service
 *
 * Triggers HR connectors (csv-hr, json-api-hr) to fetch users and push them
 * into the Identity Hub. Connectors must be installed (config stored) before ingest.
 *
 * Config keys per connector:
 * - csv-hr: filePath, sourceSystem?
 * - json-api-hr: url, responsePath?, sourceSystem?
 *
 * Rows always land in the caller's tenant (the request or activity tenant context);
 * a `tenantId` key in the connector config is ignored. A row that mints an identity emits
 * identity.created (ids and the source only), the identity timeline's "Created via <source>".
 *
 * After every run that fetched the feed, HR_SYNC_COMPLETED reports the run (counts only, no
 * per-person data). The leavers module answers it with leaver detection for that source
 * (modules/leavers/docs/ARCHITECTURE.md); its summary comes back in `IngestResult.leavers`.
 * Once that has answered, HR_SYNC_MOVERS_REQUESTED (same payload) asks the mover module for HR
 * mover detection (modules/mover/docs/ARCHITECTURE.md), which then sees this run's leavers; its
 * summary comes back in `IngestResult.movers`. Then HR_SYNC_JOINERS_REQUESTED (same payload) asks
 * the joiners module to onboard the identities the run minted (modules/joiners/docs/ARCHITECTURE.md),
 * also after this run's leavers are known; its summary comes back in `IngestResult.joiners`. A
 * failed leaver detection skips both.
 */

import {
  Injectable,
  Inject,
  forwardRef,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConnectorConfigService } from './connector-config.service';
import { IdentityService } from '../identity/identity.service';
import { CsvHrService } from './csv-hr-connector/csv-hr.service';
import { JsonApiHrService } from './json-api-hr-connector/json-api-hr.service';
import { StandardUserDto, StandardUserSchema, UserStatus } from '@shared/dtos/standard-user.dto';
import { IHrConnector, IHrConnectorWriteBack } from './hr/interfaces/hr-connector.interface';
import { PluginRegistryService } from './plugin/plugin-registry.service';
import { BlueprintsService } from '../blueprints/blueprints.service';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { HrSyncCompletedPayload } from '@infrastructure/events/event-payloads';
import { toSourceName } from '@shared/utils/source-name';
import type { HrFetchStats } from './hr/hr-lifecycle-fields';
import { isLeaverSyncSummary, type LeaverSyncSummary } from '@shared/interfaces/leaver-sync';
import { isMoverSyncSummary, type MoverSyncSummary } from '@shared/interfaces/mover-sync';
import { isJoinerSyncSummary, type JoinerSyncSummary } from '@shared/interfaces/joiner-sync';
import { DeletedIdentityRowIgnored } from '../identity/deleted-identity-rows';
import { RowHeldForConflictReview } from '../identity/conflict-held-rows';
import { IdentityLimitReached } from '../identity/identity-limit';
import { CorrelationConfigUnavailableError } from '../correlation-config/correlation-config.errors';
import { maskEmail } from '../identity/identity-pii';
import { maskEmails } from '../../activities/deprovision-failure';

export interface IngestResult {
  ingested: number;
  /**
   * One entry per row that failed validation or saving: "Row 7 (m•••@example.com): <reason>".
   * The row is the source's own numbering (HrFetchStats.sourceRows); emails, the row's and any
   * quoted in the reason, are masked (identity-pii maskEmail). The first three are stored as
   * the connector's lastSyncError, which viewers can read.
   */
  errors: string[];
  /**
   * Active rows of soft-deleted identities that are not a rehire (start date not after the
   * deletion): nothing changed, each is logged with the email masked. Ended rows of deleted
   * identities change nothing and are not counted; neither kind is an error.
   */
  activeRowsOfDeletedIdentities: number;
  /**
   * Rows held on a correlation conflict because a live identity already has their email
   * (conflict-held-rows.ts): a low-confidence match, a row no rule matches, or a rehire whose
   * old address a new hire has now. Nothing was minted or revived. Neither ingested nor errors:
   * each waits for an admin on the conflict, and every sync until then counts it again.
   */
  rowsHeldForConflictReview: number;
  /**
   * Rows of new people held because the tenant's identity limit (`identityLimit`, its
   * settings.maxIdentities) is reached (identity-limit.ts): nothing was minted. Neither ingested
   * nor errors; every sync reads them again, so the first sync after the limit is raised (or
   * identities are deleted) ingests them.
   */
  rowsHeldForIdentityLimit: number;
  /** The limit that held rows, when any were held. */
  identityLimit?: number;
  /** Leaver detection for this run; absent when no leaver handler answered or it failed. */
  leavers?: LeaverSyncSummary;
  /** HR mover detection for this run; absent when it did not run, no handler answered or it failed. */
  movers?: MoverSyncSummary;
  /** HR joiner detection for this run; absent when it did not run, no handler answered or it failed. */
  joiners?: JoinerSyncSummary;
}

/**
 * Where a failed row sits in the source, its email masked: "Row 7 (m•••@example.com)". The row
 * number finds it in the file or feed; the clear address would put HR data into logs and into
 * the connector's lastSyncError.
 */
function describeRow(rowNumber: number, email: unknown): string {
  return email ? `Row ${rowNumber} (${maskEmail(String(email))})` : `Row ${rowNumber}`;
}

@Injectable()
export class HrIngestionService {
  private readonly logger = new Logger(HrIngestionService.name);

  constructor(
    private readonly connectorConfig: ConnectorConfigService,
    private readonly identityService: IdentityService,
    private readonly csvHrService: CsvHrService,
    private readonly jsonApiHrService: JsonApiHrService,
    private readonly pluginRegistry: PluginRegistryService,
    @Inject(forwardRef(() => BlueprintsService))
    private readonly blueprintsService: BlueprintsService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /**
   * Resolve HR connector by name. Returns null if not an HR connector.
   */
  private getHrConnector(name: string): IHrConnector | null {
    switch (name) {
      case 'csv-hr':
        return this.csvHrService;
      case 'json-api-hr':
        return this.jsonApiHrService;
      default:
        return null;
    }
  }

  /**
   * Resolve HR connector with write-back support. Returns null if connector doesn't support write-back.
   * csv-hr and json-api-hr are read-only; Workday/BambooHR would implement IHrConnectorWriteBack.
   */
  getHrConnectorWithWriteBack(name: string): IHrConnectorWriteBack | null {
    const connector = this.getHrConnector(name);
    if (!connector) return null;
    const wb = connector as unknown as IHrConnectorWriteBack;
    if (typeof wb.updateUserFields === 'function' && Array.isArray(wb.writeBackCapableFields)) {
      return wb;
    }
    return null;
  }

  /**
   * Ingest users from an HR connector into the Identity Hub.
   * Connector must be installed and have the 'ingest' capability.
   */
  async ingestFromConnector(connectorName: string, tenantId?: string): Promise<IngestResult> {
    const manifest = this.pluginRegistry.getById(connectorName);
    if (!manifest) {
      throw new NotFoundException(`Connector "${connectorName}" not found`);
    }
    if (!manifest.capabilities.includes('ingest')) {
      throw new NotFoundException(`Connector "${connectorName}" does not support ingest`);
    }

    const hrConnector = this.getHrConnector(connectorName);
    if (!hrConnector) {
      throw new NotFoundException(`HR connector implementation not found for "${connectorName}"`);
    }

    const configDoc = await this.connectorConfig.getConfig(connectorName);
    let config: Record<string, unknown>;

    if (configDoc?.config) {
      config = configDoc.config as Record<string, unknown>;
    } else {
      // Fallback: read config from the Design Studio blueprint's connectorConfigs
      const blueprintConfig = await this.getBlueprintConnectorConfig(connectorName);
      if (!blueprintConfig) {
        throw new NotFoundException(
          `Connector "${connectorName}" is not installed and has no config in the Design Studio.`,
        );
      }
      config = blueprintConfig;
      this.logger.log(`[HrIngestion] Using blueprint config for ${connectorName}`);
    }
    // The tenant context decides (HTTP request, or the scheduled-sync activity's context).
    // The explicit argument serves callers without a context; the connector config never does,
    // since a config value would let one tenant's admin ingest rows into another tenant.
    const effectiveTenantId =
      getRequestContext()?.tenantId || tenantId || process.env.DEFAULT_TENANT_ID || 'default';

    this.logger.log(
      `[HrIngestion] Starting ingest from ${connectorName} for tenant ${effectiveTenantId}`,
    );

    const startedAt = new Date();
    const stats: HrFetchStats = { skipped: 0, sourceRows: [] };
    const users = await hrConnector.fetchUsers(config, effectiveTenantId, stats);
    const errors: string[] = [];
    let ingested = 0;
    let activeRowsOfDeletedIdentities = 0;
    let rowsHeldForConflictReview = 0;
    let rowsHeldForIdentityLimit = 0;
    let identityLimit: number | undefined;

    for (const [index, partial] of users.entries()) {
      const rowLabel = describeRow(stats.sourceRows?.[index] ?? index + 1, partial.email);
      try {
        const dto: StandardUserDto = this.buildFullDto(partial, effectiveTenantId);
        const parsed = StandardUserSchema.safeParse(dto);
        if (!parsed.success) {
          const msg = maskEmails(
            parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          );
          errors.push(`${rowLabel}: ${msg}`);
          this.logger.warn(`[HrIngestion] ${rowLabel} failed validation (IV-4): ${msg}`);
          continue;
        }
        // Correlation hands the hub write the identity it writes to, null when it mints one
        let minted = false;
        const saved = await this.identityService.saveOrUpdate(
          parsed.data as StandardUserDto,
          undefined,
          async (before) => {
            minted = before === null;
          },
        );
        ingested++;
        if (minted) this.reportCreated(effectiveTenantId, saved, parsed.data as StandardUserDto);
      } catch (err: unknown) {
        if (err instanceof DeletedIdentityRowIgnored) {
          if (err.row === 'not-rehire') activeRowsOfDeletedIdentities++;
          continue;
        }
        if (err instanceof RowHeldForConflictReview) {
          rowsHeldForConflictReview++;
          continue;
        }
        if (err instanceof IdentityLimitReached) {
          rowsHeldForIdentityLimit++;
          identityLimit = err.limit;
          continue;
        }
        // No row can be stored safely without the correlation settings: the run fails (and is
        // retried) before leaver detection sees it
        if (err instanceof CorrelationConfigUnavailableError) throw err;
        const msg = maskEmails(err instanceof Error ? err.message : String(err));
        errors.push(`${rowLabel}: ${msg}`);
        this.logger.warn(`[HrIngestion] ${rowLabel} could not be saved: ${msg}`);
      }
    }

    this.logger.log(
      `[HrIngestion] Complete. Ingested ${ingested}/${users.length}, errors: ${errors.length}, ` +
        `active rows of deleted identities ignored: ${activeRowsOfDeletedIdentities}, ` +
        `rows held for conflict review: ${rowsHeldForConflictReview}`,
    );
    if (rowsHeldForIdentityLimit > 0) {
      this.logger.warn(
        `[HrIngestion] ${rowsHeldForIdentityLimit} rows of new people held: the tenant's ` +
          `identity limit (${identityLimit}) is reached. They are ingested by the first sync ` +
          'after the limit is raised.',
      );
    }

    const run: HrSyncCompletedPayload = {
      connectorName,
      sourceName: toSourceName(String(config.sourceSystem ?? '') || hrConnector.sourceName),
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      fetched: users.length,
      skipped: stats.skipped,
      ingested,
      errorCount: errors.length,
    };
    const leaverDetection = await this.reportSyncCompleted(effectiveTenantId, run);
    // Movers and joiners only after leaver detection answered: both skip identities that are
    // leaving. Joiners last: a joiner has no target yet, so no mover run concerns it, and mover
    // detection never sees an onboarding this run started.
    const movers = leaverDetection.ok
      ? await this.requestMoverDetection(effectiveTenantId, run)
      : undefined;
    const joiners = leaverDetection.ok
      ? await this.requestJoinerDetection(effectiveTenantId, run)
      : undefined;
    return {
      ingested,
      errors,
      activeRowsOfDeletedIdentities,
      rowsHeldForConflictReview,
      rowsHeldForIdentityLimit,
      ...(identityLimit !== undefined ? { identityLimit } : {}),
      ...(leaverDetection.leavers ? { leavers: leaverDetection.leavers } : {}),
      ...(movers ? { movers } : {}),
      ...(joiners ? { joiners } : {}),
    };
  }

  /**
   * identity.created for an identity a row minted: the identity timeline's first entry ("Created
   * via csv-hr"). Ids and the source only: no email, name or HR id (an HR row without an employee
   * id has its email as sourceUserId).
   */
  private reportCreated(tenantId: string, saved: Record<string, unknown>, dto: StandardUserDto) {
    const identityId = String(saved._id);
    this.eventEmitter.emit(
      DomainEventType.IDENTITY_CREATED,
      identityId,
      { identityId, sourceSystem: dto.sourceSystem, status: String(dto.status) },
      { tenantId },
    );
  }

  /**
   * Emit HR_SYNC_COMPLETED and wait for leaver detection. A detection failure is logged and
   * leaves the ingest result as it is: the rows are saved, and the next sync detects again.
   */
  private async reportSyncCompleted(
    tenantId: string,
    payload: HrSyncCompletedPayload,
  ): Promise<{ ok: boolean; leavers?: LeaverSyncSummary }> {
    try {
      const results = await this.eventEmitter.emitAndWait<HrSyncCompletedPayload, unknown>(
        DomainEventType.HR_SYNC_COMPLETED,
        payload.sourceName,
        payload,
        { tenantId },
      );
      return { ok: true, leavers: results.find(isLeaverSyncSummary) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[HrIngestion] Leaver detection failed for ${payload.sourceName}: ${msg}`);
      return { ok: false };
    }
  }

  /**
   * Emit HR_SYNC_MOVERS_REQUESTED and wait for HR mover detection. A failure is logged and leaves
   * the ingest result as it is: the access baseline is unchanged, so the next sync detects again.
   */
  private async requestMoverDetection(
    tenantId: string,
    payload: HrSyncCompletedPayload,
  ): Promise<MoverSyncSummary | undefined> {
    try {
      const results = await this.eventEmitter.emitAndWait<HrSyncCompletedPayload, unknown>(
        DomainEventType.HR_SYNC_MOVERS_REQUESTED,
        payload.sourceName,
        payload,
        { tenantId },
      );
      return results.find(isMoverSyncSummary);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[HrIngestion] Mover detection failed for ${payload.sourceName}: ${msg}`);
      return undefined;
    }
  }

  /**
   * Emit HR_SYNC_JOINERS_REQUESTED and wait for HR joiner detection. A failure is logged and
   * leaves the ingest result as it is: the next sync of the source records this run's joiners.
   */
  private async requestJoinerDetection(
    tenantId: string,
    payload: HrSyncCompletedPayload,
  ): Promise<JoinerSyncSummary | undefined> {
    try {
      const results = await this.eventEmitter.emitAndWait<HrSyncCompletedPayload, unknown>(
        DomainEventType.HR_SYNC_JOINERS_REQUESTED,
        payload.sourceName,
        payload,
        { tenantId },
      );
      return results.find(isJoinerSyncSummary);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[HrIngestion] Joiner detection failed for ${payload.sourceName}: ${msg}`);
      return undefined;
    }
  }

  private buildFullDto(partial: Partial<StandardUserDto>, tenantId: string): StandardUserDto {
    const sourceSystem = partial.sourceSystem ?? 'HR-FEED';
    const sourceUserId = partial.sourceUserId ?? partial.email;
    if (!sourceUserId || !partial.email) {
      throw new BadRequestException('Missing sourceUserId or email');
    }
    // StandardUserSchema requires firstName/lastName min(1); use placeholder when empty (IV-4)
    const firstName = (partial.firstName ?? '').trim() || 'Unknown';
    const lastName = (partial.lastName ?? '').trim() || 'Unknown';

    return {
      ...partial,
      sourceSystem,
      sourceUserId: String(sourceUserId),
      tenantId,
      firstName,
      lastName,
      email: String(partial.email),
      status: partial.status ?? UserStatus.ACTIVE,
      jobTitle: partial.jobTitle,
      departmentName: partial.departmentName,
      employeeId: partial.employeeId,
    } as StandardUserDto;
  }

  /**
   * Fallback: read connector config from the Design Studio blueprint's connectorConfigs.
   * Searches for matching node config by connector ID pattern.
   */
  private async getBlueprintConnectorConfig(
    connectorName: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const blueprint = await this.blueprintsService.getLatestBlueprint();
      const configs = blueprint?.connectorConfigs as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (!configs) return null;

      // Direct key match (e.g. "csv-hr", "json-api-hr")
      if (configs[connectorName] && Object.keys(configs[connectorName]).length > 0) {
        return configs[connectorName];
      }

      // Search nodes for source nodes matching this connector
      for (const node of blueprint.nodes ?? []) {
        const nodeObj = node as Record<string, unknown>;
        const nodeId =
          typeof node === 'object' && node !== null ? ((nodeObj.id as string) ?? '') : '';
        if (
          typeof nodeId === 'string' &&
          nodeId.toLowerCase().includes(connectorName.toLowerCase())
        ) {
          const nodeData = nodeObj.data as Record<string, unknown> | undefined;
          const nodeConfig = nodeData?.config as Record<string, unknown> | undefined;
          if (nodeConfig && Object.keys(nodeConfig).length > 0) {
            return nodeConfig;
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }
}
