/**
 * Sync Scheduler Service
 *
 * Runs scheduled syncs for HR ingest and entitlement discovery.
 * Cron checks connectors with syncIntervalHours > 0 and DISPATCHES Temporal workflows.
 * Execution is async — one slow connector no longer blocks others.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConnectorConfigService } from './connector-config.service';
import { PluginRegistryService } from './plugin/plugin-registry.service';
import { HrIngestionService } from './hr-ingestion.service';
import { EntraActivities } from '../../activities/entra.activities';
import { AdActivities } from '../../activities/ad.activities';
import { TenantService } from '@infrastructure/multi-tenancy/tenant.service';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { randomUUID } from 'crypto';
import type { AdConfig } from './ad-connector/ad.interface';
import type { EntraConfig } from './entra-connector/entra.interface';
import { scheduledSyncWorkflow } from '../../workflows/scheduled-sync.workflow';
import { DEFAULT_PROVISIONING_QUEUE } from '@infrastructure/temporal/task-queue.config';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { syncLockHeld } from './sync-lock';

/**
 * What a failed sync stores as lastSyncError, which GET /connectors shows to viewers: a raw
 * error can carry a server path or part of the HR feed, so it goes to the log only, as the
 * manual ingest route does (connector-config.controller.ts).
 */
const SYNC_FAILED_MESSAGE = 'Data synchronization failed';
const DISCOVER_FAILED_MESSAGE = 'Entitlement discovery failed';

@Injectable()
export class SyncSchedulerService {
  private readonly logger = new Logger(SyncSchedulerService.name);

  constructor(
    private readonly configService: ConnectorConfigService,
    private readonly pluginRegistry: PluginRegistryService,
    private readonly hrIngestion: HrIngestionService,
    private readonly entraActivities: EntraActivities,
    private readonly adActivities: AdActivities,
    private readonly tenantService: TenantService,
    private readonly temporalClientProvider: TemporalClientProvider,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async checkAndRunSyncs() {
    const tenants = await this.tenantService.findAll();
    if (tenants.length === 0) {
      this.logger.warn('[SyncScheduler] No tenants found — skipping sync cycle');
      return;
    }

    for (const tenant of tenants) {
      if (tenant.status !== 'active') continue;

      await requestContext.run(
        {
          correlationId: randomUUID(),
          actor: 'system:scheduler',
          tenantId: tenant.tenantId,
          startTime: Date.now(),
        },
        async () => {
          this.logger.log(`[Scheduler] Checking syncs for Tenant: ${tenant.name}`);
          const names = await this.configService.listInstalledNames();
          for (const name of names) {
            try {
              if (this.temporalClientProvider.isConnected()) {
                await this.dispatchSyncWorkflow(tenant.tenantId, name);
              } else {
                await this.maybeRunSyncForConnector(name);
              }
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              this.logger.warn(
                `[SyncScheduler] Error checking ${name} for tenant ${tenant.tenantId}: ${message}`,
              );
            }
          }
        },
      );
    }
  }

  /**
   * Dispatch a sync workflow for a connector (fire-and-forget).
   * Only dispatches when sync is due; Temporal executes asynchronously.
   */
  private async dispatchSyncWorkflow(tenantId: string, connectorName: string): Promise<void> {
    const configDoc = await this.configService.getConfig(connectorName);
    if (!configDoc?.config) return;

    const config = configDoc.config as Record<string, string>;
    const syncIntervalHours = parseInt(String(config.syncIntervalHours ?? '0'), 10) || 0;
    if (syncIntervalHours <= 0) return;

    // A live sync holds the lock; one whose holder died (not renewed) is dispatched again
    if (syncLockHeld(configDoc)) return;

    const lastSyncAt = configDoc.lastSyncAt ?? new Date(0);
    const nextDue = new Date(lastSyncAt);
    nextDue.setHours(nextDue.getHours() + syncIntervalHours);
    if (new Date() < nextDue) return;

    const manifest = this.pluginRegistry.getById(connectorName);
    if (!manifest) return;
    if (!manifest.capabilities?.includes('ingest') && !manifest.capabilities?.includes('discover'))
      return;

    const workflowId = `sync-${tenantId}-${connectorName}-${Date.now()}`;
    const client = this.temporalClientProvider.getClient();
    await client.workflow.start(scheduledSyncWorkflow, {
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      workflowId,
      args: [{ tenantId, connectorName }],
      searchAttributes: { TenantId: [tenantId] },
      workflowExecutionTimeout: '1 hour',
    });
    this.logger.log(`[SyncScheduler] Dispatched workflow ${workflowId} for ${connectorName}`);
  }

  private async maybeRunSyncForConnector(name: string): Promise<void> {
    const configDoc = await this.configService.getConfig(name);
    if (!configDoc?.config) return;

    const config = configDoc.config as Record<string, string>;
    const syncIntervalHours = parseInt(String(config.syncIntervalHours ?? '0'), 10) || 0;
    if (syncIntervalHours <= 0) return;

    // A live sync holds the lock; one whose holder died (not renewed) is dispatched again
    if (syncLockHeld(configDoc)) return;

    const lastSyncAt = configDoc.lastSyncAt ?? new Date(0);
    const nextDue = new Date(lastSyncAt);
    nextDue.setHours(nextDue.getHours() + syncIntervalHours);
    if (new Date() < nextDue) return;

    const manifest = this.pluginRegistry.getById(name);
    if (!manifest) return;

    const ctx = requestContext.getStore();
    const tenantId = ctx?.tenantId;
    if (!tenantId) {
      this.logger.error(`[SyncScheduler] No tenant context for connector ${name} — aborting sync`);
      return;
    }

    if (manifest.capabilities?.includes('ingest')) {
      await this.runIngest(name, tenantId);
    } else if (manifest.capabilities?.includes('discover')) {
      await this.runDiscover(name, config, tenantId);
    }
  }

  /**
   * Execute sync for a connector (ingest or discover).
   * Called by ScheduledSyncWorkflow — decouples Cron dispatch from execution.
   * Tenant context must be set by caller (e.g. activity with withTenantContext).
   */
  async executeSync(
    tenantId: string,
    connectorName: string,
  ): Promise<{
    success: boolean;
    type: 'ingest' | 'discover';
    count?: number;
    error?: string;
  }> {
    const configDoc = await this.configService.getConfig(connectorName);
    if (!configDoc?.config) {
      return { success: false, type: 'ingest', error: 'Connector not configured' };
    }
    const manifest = this.pluginRegistry.getById(connectorName);
    if (!manifest) {
      return { success: false, type: 'ingest', error: `Connector ${connectorName} not found` };
    }
    const config = configDoc.config as Record<string, string>;
    if (manifest.capabilities?.includes('ingest')) {
      const canRun = await this.configService.setSyncRunning(connectorName);
      if (!canRun) return { success: false, type: 'ingest', error: 'Sync already running' };
      try {
        const result = await this.hrIngestion.ingestFromConnector(connectorName, tenantId);
        await this.configService.updateSyncStatus(connectorName, {
          lastSyncAt: new Date(),
          lastSyncStatus: 'success',
          lastSyncCount: result.ingested,
          lastSyncError:
            result.errors.length > 0 ? result.errors.slice(0, 3).join('; ') : undefined,
        });
        this.logger.log(
          `[SyncScheduler] Ingest ${connectorName}: ${result.ingested} users` +
            (result.leavers
              ? `, leavers detected ${result.leavers.detected}, started ${result.leavers.started}` +
                (result.leavers.pausedBatchId ? ', paused for approval' : '')
              : '') +
            (result.movers
              ? `, movers detected ${result.movers.detected}, started ${result.movers.started}` +
                (result.movers.pausedBatchId ? ', paused for approval' : '')
              : '') +
            (result.joiners
              ? `, joiners detected ${result.joiners.detected}, started ${result.joiners.started}` +
                `, waiting ${result.joiners.waiting}` +
                (result.joiners.pausedBatchId ? ', paused for approval' : '')
              : ''),
        );
        return { success: true, type: 'ingest', count: result.ingested };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.configService.updateSyncStatus(connectorName, {
          lastSyncAt: new Date(),
          lastSyncStatus: 'failed',
          lastSyncError: SYNC_FAILED_MESSAGE,
        });
        this.logger.warn(`[SyncScheduler] Ingest ${connectorName} failed: ${msg}`);
        return { success: false, type: 'ingest', error: msg };
      }
    }
    if (manifest.capabilities?.includes('discover')) {
      const canRun = await this.configService.setSyncRunning(connectorName);
      if (!canRun) return { success: false, type: 'discover', error: 'Sync already running' };
      try {
        let entitlements: { nativeId: string; name: string; type: string }[] = [];
        if (connectorName === 'entra-id') {
          entitlements = await this.entraActivities.discoverEntitlements(
            Object.keys(config).length ? (config as unknown as EntraConfig) : undefined,
            tenantId,
          );
        } else if (connectorName === 'ad') {
          const adConfig = this.coerceAdConfig(config);
          entitlements = await this.adActivities.discoverAdEntitlements(adConfig, tenantId);
        }
        await this.configService.updateSyncStatus(connectorName, {
          lastSyncAt: new Date(),
          lastSyncStatus: 'success',
          lastSyncCount: entitlements.length,
        });
        this.logger.log(
          `[SyncScheduler] Discover ${connectorName}: ${entitlements.length} entitlements`,
        );
        return { success: true, type: 'discover', count: entitlements.length };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.configService.updateSyncStatus(connectorName, {
          lastSyncAt: new Date(),
          lastSyncStatus: 'failed',
          lastSyncError: DISCOVER_FAILED_MESSAGE,
        });
        this.logger.warn(`[SyncScheduler] Discover ${connectorName} failed: ${msg}`);
        return { success: false, type: 'discover', error: msg };
      }
    }
    return {
      success: false,
      type: 'ingest',
      error: `Connector ${connectorName} has no ingest or discover capability`,
    };
  }

  private async runIngest(name: string, tenantId: string): Promise<void> {
    const canRun = await this.configService.setSyncRunning(name);
    if (!canRun) return;

    try {
      const result = await this.hrIngestion.ingestFromConnector(name, tenantId);
      await this.configService.updateSyncStatus(name, {
        lastSyncAt: new Date(),
        lastSyncStatus: 'success',
        lastSyncCount: result.ingested,
        lastSyncError: result.errors.length > 0 ? result.errors.slice(0, 3).join('; ') : undefined,
      });
      this.logger.log(`[SyncScheduler] Ingest ${name}: ${result.ingested} users`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.configService.updateSyncStatus(name, {
        lastSyncAt: new Date(),
        lastSyncStatus: 'failed',
        lastSyncError: SYNC_FAILED_MESSAGE,
      });
      this.logger.warn(`[SyncScheduler] Ingest ${name} failed: ${msg}`);
    }
  }

  private async runDiscover(
    name: string,
    config: Record<string, string>,
    tenantId: string,
  ): Promise<void> {
    const canRun = await this.configService.setSyncRunning(name);
    if (!canRun) return;

    try {
      let entitlements: { nativeId: string; name: string; type: string }[] = [];
      if (name === 'entra-id') {
        entitlements = await this.entraActivities.discoverEntitlements(
          Object.keys(config).length ? (config as unknown as EntraConfig) : undefined,
          tenantId,
        );
      } else if (name === 'ad') {
        const adConfig = this.coerceAdConfig(config);
        entitlements = await this.adActivities.discoverAdEntitlements(adConfig, tenantId);
      }

      await this.configService.updateSyncStatus(name, {
        lastSyncAt: new Date(),
        lastSyncStatus: 'success',
        lastSyncCount: entitlements.length,
      });
      this.logger.log(`[SyncScheduler] Discover ${name}: ${entitlements.length} entitlements`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.configService.updateSyncStatus(name, {
        lastSyncAt: new Date(),
        lastSyncStatus: 'failed',
        lastSyncError: DISCOVER_FAILED_MESSAGE,
      });
      this.logger.warn(`[SyncScheduler] Discover ${name} failed: ${msg}`);
    }
  }

  private coerceAdConfig(raw: Record<string, string>): AdConfig {
    const cfg: AdConfig = {
      host: raw.host ?? '',
      serviceAccount: raw.serviceAccount ?? '',
      password: raw.password ?? '',
    };
    cfg.rootBaseDn = raw.rootBaseDn?.trim() || raw.baseDn?.trim();
    cfg.baseDn = raw.baseDn ?? cfg.rootBaseDn;
    cfg.userSearchBase = raw.userSearchBase?.trim() || undefined;
    if (typeof raw.port === 'string' && raw.port) {
      cfg.port = parseInt(raw.port, 10);
    }
    if (typeof raw.useLdaps === 'string') {
      cfg.useLdaps = raw.useLdaps === 'true' || raw.useLdaps === '1';
    }
    if (raw.defaultDomain) cfg.defaultDomain = raw.defaultDomain;
    if (raw.userOu) cfg.userOu = raw.userOu;
    return cfg;
  }
}
