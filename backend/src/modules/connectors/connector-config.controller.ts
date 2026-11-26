/**
 * Connector Config Controller
 *
 * REST API for the Connector Marketplace backend.
 *   GET    /api/v1/connectors              -- list installed connectors (secrets redacted)
 *   GET    /api/v1/connectors/available     -- list registered connector plugins
 *   POST   /api/v1/connectors/:name/install -- install with config body
 *   POST   /api/v1/connectors/:name/ingest -- trigger HR ingest (csv-hr, json-api-hr)
 *   DELETE /api/v1/connectors/:name         -- uninstall
 *   PATCH  /api/v1/connectors/:name         -- update config
 *   GET    /api/v1/connectors/:name/status  -- installed check
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Logger,
  BadRequestException,
  NotFoundException,
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { ConnectorConfigService } from './connector-config.service';
import { PluginRegistryService } from './plugin/plugin-registry.service';
import { HrIngestionService } from './hr-ingestion.service';
import { EntraActivities } from '../../activities/entra.activities';
import { AdActivities } from '../../activities/ad.activities';
import { ScimActivities } from '../../activities/scim.activities';
import type { AdConfig } from './ad-connector/ad.interface';
import type { EntraConfig } from './entra-connector/entra.interface';
import { InstallConnectorDto, UpdateConnectorDto } from './connector-config.dto';
import { ConnectorConfigDecryptError } from './connector-config.errors';
import {
  CONNECTOR_HEALTH_CHECKS,
  coerceAdConfig,
  coerceScimConfig,
  type ConnectorHealthCheck,
} from './connector-health-checks';
import { ContractCriticalMasteryService } from '../identity/contract-critical-mastery.service';
import { CsvHrService } from './csv-hr-connector/csv-hr.service';
import { JsonApiHrService } from './json-api-hr-connector/json-api-hr.service';

/** A route that reads the stored config (ConnectorConfigDecryptError). */
const DECRYPT_FAILED_RESPONSE = {
  status: 503,
  description: 'The stored config cannot be decrypted by this process: check its encryption keys',
};

/** The audit actor of a change: the signed-in user's email, else its id. */
function actorOf(user: AuthUserType | undefined): string | undefined {
  return user?.email || user?.sub || undefined;
}

@ApiTags('Connectors')
@ApiBearerAuth('jwt')
@Controller('connectors')
export class ConnectorConfigController {
  private readonly logger = new Logger(ConnectorConfigController.name);

  constructor(
    private readonly configService: ConnectorConfigService,
    private readonly pluginRegistry: PluginRegistryService,
    private readonly hrIngestion: HrIngestionService,
    private readonly entraActivities: EntraActivities,
    private readonly adActivities: AdActivities,
    private readonly scimActivities: ScimActivities,
    private readonly contractCriticalMastery: ContractCriticalMasteryService,
    private readonly csvHr: CsvHrService,
    private readonly jsonApiHr: JsonApiHrService,
    @Inject(CONNECTOR_HEALTH_CHECKS)
    private readonly healthChecks: Record<string, ConnectorHealthCheck>,
  ) {}

  @Get('available')
  @Roles('viewer', 'connector-admin', 'operator', 'policy-admin', 'super-admin')
  @ApiOperation({ summary: 'List all registered connector plugins with config schemas' })
  @ApiResponse({ status: 200, description: 'List of available connector manifests' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  async listAvailable() {
    const manifests = this.pluginRegistry.getAll();
    return manifests.map((m) => ({
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      icon: m.icon,
      capabilities: m.capabilities,
      configSchema: m.configSchema,
    }));
  }

  @Get()
  @Roles('viewer')
  @ApiOperation({ summary: 'List all installed connectors (secrets redacted)' })
  async listInstalled() {
    return this.configService.listInstalled();
  }

  @Post(':name/ingest')
  @Roles('connector-admin', 'operator', 'super-admin')
  @ApiOperation({ summary: 'Trigger HR ingest from connector (csv-hr, json-api-hr)' })
  @ApiResponse({ status: 200, description: 'Ingest result with ingested count and errors' })
  @ApiResponse({ status: 404, description: 'Connector not found or not installed' })
  @ApiResponse(DECRYPT_FAILED_RESPONSE)
  async ingest(@Param('name') name: string) {
    // setSyncRunning returns false if connector not installed (no doc) or already running.
    // For connectors configured via Design Studio (no installation doc), we skip the running guard.
    const canRun = await this.configService.setSyncRunning(name);
    const isInstalledConnector =
      canRun !== false || (await this.configService.getConfig(name)) !== null;
    if (!canRun && isInstalledConnector) {
      return {
        success: false,
        ingested: 0,
        errors: ['A sync is already running for this connector'],
      };
    }
    try {
      // Rows go to the caller's tenant (request context); the body cannot name another one.
      const result = await this.hrIngestion.ingestFromConnector(name);
      // Only update sync status if the connector is installed (has a config doc)
      if (isInstalledConnector) {
        await this.configService.updateSyncStatus(name, {
          lastSyncAt: new Date(),
          lastSyncStatus: 'success',
          lastSyncCount: result.ingested,
          lastSyncError:
            result.errors.length > 0 ? result.errors.slice(0, 3).join('; ') : undefined,
        });
      }
      return {
        success: true,
        count: result.ingested,
        ingested: result.ingested,
        errors: result.errors,
        activeRowsOfDeletedIdentities: result.activeRowsOfDeletedIdentities,
        rowsHeldForConflictReview: result.rowsHeldForConflictReview,
        rowsHeldForIdentityLimit: result.rowsHeldForIdentityLimit,
        ...(result.identityLimit !== undefined ? { identityLimit: result.identityLimit } : {}),
        ...(result.leavers ? { leavers: result.leavers } : {}),
        ...(result.movers ? { movers: result.movers } : {}),
        ...(result.joiners ? { joiners: result.joiners } : {}),
      };
    } catch (err: unknown) {
      const internalMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Ingest failed for connector "${name}": ${internalMsg}`,
        err instanceof Error ? err.stack : undefined,
      );
      if (isInstalledConnector) {
        await this.configService.updateSyncStatus(name, {
          lastSyncAt: new Date(),
          lastSyncStatus: 'failed',
          lastSyncError: 'Data synchronization failed',
        });
      }
      // Its message says which key settings to check (503), and holds nothing secret
      if (err instanceof ConnectorConfigDecryptError) throw err;
      return {
        success: false,
        count: 0,
        ingested: 0,
        errors: ['Data synchronization failed'],
        error: 'Data synchronization failed',
      };
    }
  }

  @Post(':name/install')
  @Roles('connector-admin')
  @ApiOperation({ summary: 'Install a connector with configuration' })
  @ApiResponse({
    status: 400,
    description:
      'Nothing saved: masteryFields names a contract-critical field (Recon Config) for a ' +
      'connector the Contract Tag and ingest priority do not make the primary HR source (a ' +
      'secondary HR source or a target); contract-critical fields always come from the primary ' +
      'HR contract. Or config.columnMap (CSV HR) or config.fieldMap (JSON API HR) is not a ' +
      'valid HR map: JSON object text, each key a column or key name, each value a field the ' +
      'HR mapping fills or customAttributes.<key>, one of them email. The message names the entry.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  async install(
    @Param('name') name: string,
    @Body() body: InstallConnectorDto,
    @AuthUser() user?: AuthUserType,
  ) {
    const priorityConfig =
      body.ingestPriority != null || body.contractTag || body.masteryFields
        ? {
            ingestPriority: body.ingestPriority,
            contractTag: body.contractTag,
            masteryFields: body.masteryFields,
          }
        : undefined;
    // A contract-critical field's mastery only on the primary HR source (400 otherwise)
    if (priorityConfig) {
      await this.contractCriticalMastery.assertConnectorMastery(name, priorityConfig);
    }
    // The installer is the signed-in user (audit actor); the body cannot name another
    const doc = await this.configService.install(name, body.config, actorOf(user), priorityConfig);
    return { success: true, connector: doc.connectorName, installedAt: doc.installedAt };
  }

  @Delete(':name')
  @Roles('connector-admin')
  @ApiOperation({ summary: 'Uninstall a connector' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  async uninstall(@Param('name') name: string, @AuthUser() user?: AuthUserType) {
    await this.configService.uninstall(name, user?.tenantId, actorOf(user));
    return { success: true, message: `Connector "${name}" uninstalled` };
  }

  @Patch(':name')
  @Roles('connector-admin')
  @ApiOperation({ summary: 'Update connector configuration' })
  @ApiResponse({
    status: 400,
    description:
      'Nothing saved: masteryFields names a contract-critical field (Recon Config) for a ' +
      'connector the Contract Tag and ingest priority do not make the primary HR source (a ' +
      'secondary HR source or a target); contract-critical fields always come from the primary ' +
      'HR contract. Or config.columnMap (CSV HR) or config.fieldMap (JSON API HR) is not a ' +
      'valid HR map: JSON object text, each key a column or key name, each value a field the ' +
      'HR mapping fills or customAttributes.<key>, one of them email. The message names the entry.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  async updateConfig(
    @Param('name') name: string,
    @Body() body: UpdateConnectorDto,
    @AuthUser() user?: AuthUserType,
  ) {
    const config = body.config ?? (await this.configService.getConfig(name))?.config ?? {};
    const priorityConfig =
      body.ingestPriority != null ||
      body.contractTag !== undefined ||
      body.masteryFields !== undefined
        ? {
            ingestPriority: body.ingestPriority,
            contractTag: body.contractTag,
            masteryFields: body.masteryFields,
          }
        : undefined;
    // A contract-critical field's mastery only on the primary HR source (400 otherwise)
    if (priorityConfig) {
      await this.contractCriticalMastery.assertConnectorMastery(name, priorityConfig);
    }
    const doc = await this.configService.updateConfig(
      name,
      config as Record<string, string>,
      priorityConfig,
      actorOf(user),
    );
    return { success: true, connector: doc.connectorName, updatedAt: doc.updatedAt };
  }

  /**
   * Test connector connectivity with the config in the body (unsaved values, masked secrets
   * restored only while the destination fields equal the saved config's, else 400), else the
   * saved config. AD answers an enriched result; the HR sources their
   * detailed check (checkSource: `message` when healthy, `error` when not). A connector whose
   * own health check reads its saved config (Okta, ServiceNow, GitHub, Google Sheets, Discord
   * webhook, File outbound) runs that check, the one GET /reconciliation/connector-health runs.
   */
  @Post(':name/health-check')
  @Roles('connector-admin', 'operator', 'policy-admin', 'super-admin')
  @ApiOperation({ summary: 'Test connector connectivity (health check)' })
  @ApiResponse({ status: 200, description: 'Health check result' })
  @ApiResponse({
    status: 400,
    description:
      'A masked secret with a changed destination (type the secret again to test a new ' +
      'address), a JSON API HR method other than GET, or a connector without a health check',
  })
  @ApiResponse({ status: 404, description: 'Connector not found' })
  @ApiResponse(DECRYPT_FAILED_RESPONSE)
  async healthCheck(
    @Param('name') name: string,
    @Body() body: { config?: Record<string, string> },
    @AuthUser() user?: AuthUserType,
  ) {
    const manifest = this.pluginRegistry.getById(name);
    if (!manifest) {
      throw new NotFoundException(`Connector "${name}" not found`);
    }
    if (!manifest.capabilities?.includes('healthCheck')) {
      throw new BadRequestException(`Connector "${name}" does not support health check`);
    }
    const configSent = Boolean(body?.config && Object.keys(body.config).length > 0);
    const configToUse = configSent
      ? await this.configService.withStoredSecrets(name, body.config as Record<string, string>)
      : ((await this.configService.getConfig(name))?.config ?? {});
    const tenantId = user?.tenantId ?? '';

    const capabilities = await this.pluginRegistry.getValidatedCapabilities(name, configToUse);

    if (name === 'ad') {
      const adConfig = coerceAdConfig(configToUse as Record<string, string>);
      const result = await this.adActivities.checkAdHealthEnriched(adConfig, tenantId);
      return { ...result, capabilities };
    }
    if (name === 'entra-id') {
      const ok = await this.entraActivities.checkEntraHealth(
        Object.keys(configToUse).length ? (configToUse as unknown as EntraConfig) : undefined,
        tenantId,
      );
      return { healthy: ok, connected: ok, capabilities };
    }
    if (name === 'scim') {
      const scimConfig = coerceScimConfig(configToUse as Record<string, string>);
      if (!scimConfig) {
        return { healthy: false, capabilities, error: 'Missing baseUrl or auth config' };
      }
      try {
        const result = await this.scimActivities.checkScimHealth(scimConfig, tenantId);
        return { healthy: result.healthy, capabilities, error: result.error };
      } catch (e: unknown) {
        const internalMsg = e instanceof Error ? e.message : String(e);
        this.logger.error(`SCIM health check failed for "${name}": ${internalMsg}`);
        return { healthy: false, capabilities, error: 'Health check failed' };
      }
    }
    if (name === 'csv-hr' || name === 'json-api-hr') {
      const source = name === 'csv-hr' ? this.csvHr : this.jsonApiHr;
      const result = await source.checkSource(configToUse);
      return { ...result, connected: result.healthy, capabilities };
    }
    const check = this.healthChecks[name];
    if (check) {
      // These checks test the saved config: the form's values are never handed to them
      const saved = configSent
        ? ((await this.configService.getConfig(name))?.config ?? {})
        : configToUse;
      const healthy = await this.runSavedConfigCheck(name, check, saved, tenantId);
      return {
        healthy,
        connected: healthy,
        capabilities,
        ...(healthy ? {} : { error: 'Health check failed' }),
        ...(configSent
          ? {
              message:
                'Checked with the saved config: this connector does not test unsaved settings',
            }
          : {}),
      };
    }
    throw new BadRequestException(`Health check not implemented for connector "${name}"`);
  }

  /** A connector's own health check; a failure is logged, not shown (it can name hosts). */
  private async runSavedConfigCheck(
    name: string,
    check: ConnectorHealthCheck,
    config: Record<string, string>,
    tenantId: string,
  ): Promise<boolean> {
    try {
      return await check(config, tenantId);
    } catch (e: unknown) {
      if (e instanceof ConnectorConfigDecryptError) throw e;
      this.logger.error(
        `Health check failed for "${name}": ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  @Get(':name/status')
  @Roles('viewer')
  @ApiOperation({ summary: 'Check if a connector is installed' })
  async getStatus(@Param('name') name: string) {
    const installed = await this.configService.isInstalled(name);
    const config = installed ? await this.configService.getConfig(name) : null;
    return {
      connectorName: name,
      installed,
      status: config?.status || null,
      installedAt: config?.installedAt || null,
    };
  }

  @Get(':name/sync-status')
  @Roles('viewer', 'connector-admin', 'operator', 'policy-admin', 'super-admin')
  @ApiOperation({ summary: 'Get sync status for a connector (last sync, next sync, interval)' })
  @ApiResponse({
    status: 200,
    description: 'Sync status with lastSyncAt, lastSyncStatus, nextSyncAt',
  })
  @ApiResponse({ status: 404, description: 'Connector not found or not installed' })
  @ApiResponse(DECRYPT_FAILED_RESPONSE)
  async getSyncStatus(@Param('name') name: string) {
    const configDoc = await this.configService.getConfig(name);
    if (!configDoc) {
      throw new NotFoundException(`Connector "${name}" not found or not installed`);
    }
    const config = configDoc.config ?? {};
    const syncIntervalHours = parseInt(String(config.syncIntervalHours ?? '0'), 10) || 0;
    const lastSyncAt = configDoc.lastSyncAt;
    let nextSyncAt: Date | null = null;
    if (syncIntervalHours > 0 && lastSyncAt) {
      const next = new Date(lastSyncAt);
      next.setHours(next.getHours() + syncIntervalHours);
      nextSyncAt = next;
    }
    return {
      lastSyncAt: lastSyncAt ?? null,
      lastSyncStatus: configDoc.lastSyncStatus ?? null,
      lastSyncCount: configDoc.lastSyncCount ?? null,
      lastSyncError: configDoc.lastSyncError ?? null,
      syncIntervalHours,
      nextSyncAt: nextSyncAt?.toISOString() ?? null,
    };
  }

  /**
   * Trigger entitlement discovery for a connector. Updates the Entitlement Catalog.
   * Supports entra-id and ad (Active Directory). Tenant-scoped via JWT.
   */
  @Post(':name/discover')
  @Roles('connector-admin', 'operator', 'policy-admin', 'super-admin')
  @ApiOperation({ summary: 'Run entitlement discovery for a connector' })
  @ApiResponse({
    status: 200,
    description: 'Discovery completed; returns count of discovered entitlements',
  })
  @ApiResponse({ status: 400, description: 'Connector does not support discovery' })
  @ApiResponse({ status: 404, description: 'Connector not installed' })
  @ApiResponse(DECRYPT_FAILED_RESPONSE)
  async discover(@Param('name') name: string, @AuthUser() user?: AuthUserType) {
    const manifest = this.pluginRegistry.getById(name);
    if (!manifest) {
      throw new NotFoundException(`Connector "${name}" not found`);
    }
    if (!manifest.capabilities?.includes('discover')) {
      throw new BadRequestException(`Connector "${name}" does not support entitlement discovery`);
    }
    const installed = await this.configService.isInstalled(name);
    if (!installed) {
      throw new NotFoundException(
        `Connector "${name}" is not installed. Install it first to run discovery.`,
      );
    }

    // Read before taking the sync lock: a config this process cannot decrypt fails here (503)
    // and must not leave the connector 'running' until the stale lock expires
    const configDoc = await this.configService.getConfig(name);
    const config = configDoc?.config ?? {};

    const canRun = await this.configService.setSyncRunning(name);
    if (!canRun) {
      return {
        success: false,
        count: 0,
        entitlements: [],
        error: 'A sync is already running for this connector',
      };
    }
    const tenantId = user?.tenantId ?? '';

    try {
      let entitlements: { nativeId: string; name: string; type: string }[] = [];
      if (name === 'entra-id') {
        entitlements = await this.entraActivities.discoverEntitlements(
          Object.keys(config).length ? (config as unknown as EntraConfig) : undefined,
          tenantId,
        );
      } else if (name === 'ad') {
        const adConfig = coerceAdConfig(config) as AdConfig;
        entitlements = await this.adActivities.discoverAdEntitlements(adConfig, tenantId);
      } else {
        throw new BadRequestException(`Discovery not implemented for connector "${name}"`);
      }

      this.logger.log(`[Discover] ${name}: found ${entitlements.length} entitlements`);
      await this.configService.updateSyncStatus(name, {
        lastSyncAt: new Date(),
        lastSyncStatus: 'success',
        lastSyncCount: entitlements.length,
      });
      return { success: true, count: entitlements.length, entitlements };
    } catch (err: unknown) {
      const internalMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Discovery failed for connector "${name}": ${internalMsg}`,
        err instanceof Error ? err.stack : undefined,
      );
      await this.configService.updateSyncStatus(name, {
        lastSyncAt: new Date(),
        lastSyncStatus: 'failed',
        lastSyncError: 'Entitlement discovery failed',
      });
      return { success: false, count: 0, entitlements: [], error: 'Entitlement discovery failed' };
    }
  }
}

// ── TASK 107 RECAP ──
// Modified: health-check endpoint returns { healthy, capabilities, ... } for entra-id, ad, scim.
// Injected ScimActivities, coerceScimConfig. SCIM health check path added.
