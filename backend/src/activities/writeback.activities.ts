import { Injectable, Logger } from '@nestjs/common';
import { IdentityService } from '../modules/identity/identity.service';
import { ConnectorConfigService } from '../modules/connectors/connector-config.service';
import { ReconciliationConfigService } from '../modules/identity/reconciliation-config.service';
import { HrIngestionService } from '../modules/connectors/hr-ingestion.service';
import { BlueprintsService } from '../modules/blueprints/blueprints.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';

/** Only these fields may be written back to HR. Never objectId, userPrincipalName, samAccountName, or HR-mastered fields. */
const HR_WRITEBACK_FIELDS = ['email', 'workPhone', 'officeLocation'];

/**
 * Temporal Activity: Attribute writeback from target systems to the Hub.
 * When a connector (Entra ID, AD) provisions a user, it **generates** attributes
 * (email, UPN, samAccountName, objectId). These flow back to the Golden Record.
 *
 * @see docs/tasks/CURRENT_TASK_74.md
 * @see docs/tasks/CURRENT_TASK_80.md — HR write-back
 */
@Injectable()
export class WritebackActivities {
  private readonly logger = new Logger(WritebackActivities.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly connectorConfig: ConnectorConfigService,
    private readonly reconConfigService: ReconciliationConfigService,
    private readonly hrIngestion: HrIngestionService,
    private readonly blueprintsService: BlueprintsService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /**
   * Push target-generated attributes back to the Identity Hub and reconcile.
   * Field mastery controls which fields get promoted to the Golden Record.
   *
   * @param identityId - IdentityUUID (from TASK_72), NOT email
   * @param targetSystem - Connector name (e.g., 'entra-id', 'ad')
   * @param provisionResult - Result from provision activity: { objectId?, generatedAttributes? }
   * @param tenantId - Tenant context
   */
  async writebackToIdentity(
    identityId: string,
    targetSystem: string,
    provisionResult: { objectId?: string; generatedAttributes?: Record<string, unknown> },
    tenantId?: string,
    correlationId?: string,
  ): Promise<{ success: boolean; updatedFields: string[] }> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        try {
          const attrs = provisionResult.generatedAttributes || {};
          const payload: Record<string, unknown> = { ...attrs };
          const objectId = provisionResult.objectId || (attrs.objectId as string);
          if (objectId) payload.objectId = objectId;
          if (attrs.mail || attrs.userPrincipalName) {
            payload.email = attrs.mail || attrs.userPrincipalName;
          }
          if (attrs.userPrincipalName) payload.userPrincipalName = attrs.userPrincipalName;

          const externalId =
            (objectId as string) ||
            (payload.distinguishedName as string) ||
            (payload.targetUserId as string) ||
            '';

          if (!externalId) {
            this.logger.warn(
              `[Writeback] No externalId in provision result for ${targetSystem} — skipping identity ${identityId}`,
            );
            return { success: false, updatedFields: [] };
          }

          const identity = await this.identityService.pushSourceAndReconcile(
            identityId,
            targetSystem,
            externalId,
            payload,
            // A write-back starts no new onboarding for the person (identity.sources_changed)
            { sourceRole: 'target', writeback: true },
          );

          if (!identity) {
            this.logger.warn(`[Writeback] Identity ${identityId} not found — writeback skipped`);
            return { success: false, updatedFields: [] };
          }

          const updatedFields = Object.keys(payload).filter(
            (k) => k !== '_id' && payload[k] != null,
          );

          // Depth 1, as the write-back's identity.sources_changed: the write-back belongs to the
          // run that created the account, so the mover and onboarding handlers start no run for
          // it, also when a connector returns a trigger attribute. No email: GraphSyncService
          // reads the identity's for its access-graph node.
          this.eventEmitter.emit(
            DomainEventType.IDENTITY_UPDATED,
            identityId,
            {
              identityId,
              changedFields: updatedFields,
              source: 'writeback',
              targetSystem,
            },
            { depth: 1 },
          );

          this.logger.log(
            `[Writeback] Successfully wrote back ${updatedFields.length} attributes from ${targetSystem} to identity ${identityId}`,
          );

          return { success: true, updatedFields };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `[Writeback] writebackToIdentity failed for ${identityId}/${targetSystem}: ${message}`,
          );
          throw error;
        }
      },
      { correlationId },
    );
  }

  /**
   * Push Golden Record fields back to the primary HR source.
   * Closes the bootstrap loop: Entra generates email → Brain → HR.
   * Only runs when hrWriteback is enabled and the HR connector supports it.
   *
   * @see docs/tasks/CURRENT_TASK_80.md
   */
  async writebackToHrSource(
    identityId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<{ success: boolean; updatedFields: string[]; skippedFields: string[] }> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const skippedFields: string[] = [];
        try {
          const identity = await this.identityService.findIdentityById(identityId);
          if (!identity) {
            this.logger.warn(`[HR Writeback] Identity ${identityId} not found`);
            return { success: false, updatedFields: [], skippedFields: [] };
          }

          const tid = identity.tenantId || tenantId || '';
          const cfg = await this.getCorrelationConfigFromBlueprint(tid);
          if (!cfg?.hrWriteback) {
            this.logger.debug(
              `[HR Writeback] hrWriteback disabled — skipping identity ${identityId}`,
            );
            return { success: false, updatedFields: [], skippedFields: [] };
          }

          const hrSourceTags = await this.reconConfigService.getHrSourceTags(tid);
          const hrSourceName = await this.connectorConfig.getPrimaryHrSourceName(hrSourceTags);
          if (!hrSourceName) {
            this.logger.debug(`[HR Writeback] No primary HR source configured — skipping`);
            return { success: false, updatedFields: [], skippedFields: [] };
          }

          const hrSource = identity.sources?.find((s) => s.sourceName === hrSourceName);
          const hrExternalId = hrSource?.externalId ?? identity.metadata?.primaryContractExternalId;
          if (!hrExternalId) {
            this.logger.warn(
              `[HR Writeback] No HR externalId for identity ${identityId} (source: ${hrSourceName})`,
            );
            return { success: false, updatedFields: [], skippedFields: [] };
          }

          const writebackConnector = this.hrIngestion.getHrConnectorWithWriteBack(hrSourceName);
          if (!writebackConnector) {
            this.logger.log(
              `[HR Writeback] Connector ${hrSourceName} does not support write-back (read-only) — skipping`,
            );
            return { success: false, updatedFields: [], skippedFields: [] };
          }

          const profile = identity.profile as unknown as Record<string, unknown>;
          const fieldsToWrite: Record<string, unknown> = {};
          for (const field of HR_WRITEBACK_FIELDS) {
            if (!writebackConnector.writeBackCapableFields.includes(field)) {
              skippedFields.push(field);
              continue;
            }
            const value = profile[field];
            if (value != null && value !== '') {
              fieldsToWrite[field] = value;
            }
          }

          if (Object.keys(fieldsToWrite).length === 0) {
            this.logger.debug(
              `[HR Writeback] No eligible fields to write for identity ${identityId}`,
            );
            return { success: false, updatedFields: [], skippedFields: [] };
          }

          const configDoc = await this.connectorConfig.getConfig(hrSourceName);
          const config = (configDoc?.config ?? {}) as Record<string, unknown>;

          const result = await writebackConnector.updateUserFields(
            hrExternalId,
            fieldsToWrite,
            config,
            tid,
          );

          if (!result.success) {
            this.logger.warn(
              `[HR Writeback] Connector ${hrSourceName} returned success=false: ${result.reason ?? 'unknown'}`,
            );
            return {
              success: false,
              updatedFields: [],
              skippedFields: Object.keys(fieldsToWrite),
            };
          }

          this.eventEmitter.emit(DomainEventType.HR_WRITEBACK_COMPLETED, identityId, {
            identityId,
            hrSourceName,
            fieldsWritten: result.updatedFields,
            fieldsSkipped: skippedFields,
            timestamp: new Date().toISOString(),
          });

          this.logger.log(
            `[HR Writeback] Successfully wrote ${result.updatedFields.length} fields to ${hrSourceName} for identity ${identityId}`,
          );

          return {
            success: true,
            updatedFields: result.updatedFields,
            skippedFields,
          };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `[HR Writeback] writebackToHrSource failed for ${identityId}: ${message}`,
          );
          throw error;
        }
      },
      { correlationId },
    );
  }

  private async getCorrelationConfigFromBlueprint(
    _tenantId: string,
  ): Promise<{ hrWriteback?: boolean } | null> {
    try {
      const canvas = await this.blueprintsService.getLatestBlueprint();
      const euroidConfig = canvas?.connectorConfigs?.['euroid-core'] as
        | Record<string, unknown>
        | undefined;
      const cfg = euroidConfig?.correlationConfig as { hrWriteback?: boolean } | undefined;
      return cfg ? { hrWriteback: cfg.hrWriteback } : null;
    } catch {
      return null;
    }
  }
}
