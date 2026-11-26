/**
 * Live health of a tenant's installed connectors (GET /reconciliation/connector-health).
 *
 * Each installed connector's own health check (connector-health-checks.ts) runs with the tenant's
 * saved config and may take CONNECTOR_HEALTH_TIMEOUT_MS; past that it counts as down. A result is
 * reused for CONNECTOR_HEALTH_CACHE_TTL_MS (CACHE_MANAGER, keyed by tenant and connector, shared
 * through Redis when configured) and keeps the time its check ran as lastChecked. A connector
 * without a health check is reported as not monitored (status unknown), never as healthy.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { ConnectorConfigService } from './connector-config.service';
import { ConnectorConfigDecryptError } from './connector-config.errors';
import { PluginRegistryService } from './plugin/plugin-registry.service';
import { CONNECTOR_HEALTH_CHECKS, type ConnectorHealthCheck } from './connector-health-checks';
import {
  CONNECTOR_HEALTH_CACHE_TTL_MS,
  CONNECTOR_HEALTH_TIMEOUT_MS,
} from '@infrastructure/config/defaults';

export interface ConnectorHealthStatus {
  connectorId: string;
  connectorName: string;
  /** healthy or down from a check; unknown when the connector is not monitored. */
  status: 'healthy' | 'down' | 'unknown';
  monitored: boolean;
  /** When the check behind this status ran (ISO); null when never checked. */
  lastChecked: string | null;
  responseTimeMs: number | null;
  lastError?: string;
  /** Not tracked: there is no health history or rate-limit reading behind this endpoint. */
  uptime: null;
  rateLimitRemaining: null;
  rateLimitTotal: null;
}

const cacheKey = (tenantId: string, connectorId: string) =>
  `connector-health:${tenantId}:${connectorId}`;

@Injectable()
export class ConnectorHealthService {
  private readonly logger = new Logger(ConnectorHealthService.name);

  constructor(
    private readonly configService: ConnectorConfigService,
    private readonly pluginRegistry: PluginRegistryService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @Inject(CONNECTOR_HEALTH_CHECKS) private readonly checks: Record<string, ConnectorHealthCheck>,
  ) {}

  /** The health of every connector installed for `tenantId` (the request's tenant). */
  async getTenantHealth(tenantId: string): Promise<ConnectorHealthStatus[]> {
    // Names only: a config this process cannot decrypt fails that connector's check, not the list
    const installed = await this.configService.listInstalledNames();
    return Promise.all(installed.map((name) => this.connectorHealth(tenantId, name)));
  }

  private async connectorHealth(
    tenantId: string,
    connectorId: string,
  ): Promise<ConnectorHealthStatus> {
    const connectorName = this.pluginRegistry.getById(connectorId)?.name ?? connectorId;
    const check = this.checks[connectorId];
    if (!check) {
      return {
        ...this.base(connectorId, connectorName),
        status: 'unknown',
        monitored: false,
        lastError: 'Not monitored: this connector has no health check',
      };
    }

    const cached = await this.cache.get<ConnectorHealthStatus>(cacheKey(tenantId, connectorId));
    if (cached) return cached;

    const result = await this.runCheck(tenantId, connectorId, connectorName, check);
    await this.cache.set(cacheKey(tenantId, connectorId), result, CONNECTOR_HEALTH_CACHE_TTL_MS);
    return result;
  }

  private async runCheck(
    tenantId: string,
    connectorId: string,
    connectorName: string,
    check: ConnectorHealthCheck,
  ): Promise<ConnectorHealthStatus> {
    const startedAt = Date.now();
    let healthy = false;
    let lastError: string | undefined;
    try {
      const config = (await this.configService.getConfig(connectorId))?.config ?? {};
      healthy = await withTimeout(check(config, tenantId), CONNECTOR_HEALTH_TIMEOUT_MS);
      if (!healthy) lastError = 'Health check failed';
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // Connector errors can name hosts or URLs: the detail stays in the server log. A config
      // this process cannot decrypt says only which settings to check, so it is shown.
      this.logger.warn(`Health check of ${connectorId} (tenant ${tenantId}) failed: ${message}`);
      lastError =
        error instanceof HealthCheckTimeout
          ? `No answer within ${CONNECTOR_HEALTH_TIMEOUT_MS} ms`
          : error instanceof ConnectorConfigDecryptError
            ? error.message
            : 'Health check failed';
    }
    return {
      ...this.base(connectorId, connectorName),
      status: healthy ? 'healthy' : 'down',
      monitored: true,
      lastChecked: new Date(startedAt).toISOString(),
      responseTimeMs: Date.now() - startedAt,
      ...(lastError ? { lastError } : {}),
    };
  }

  private base(connectorId: string, connectorName: string): ConnectorHealthStatus {
    return {
      connectorId,
      connectorName,
      status: 'unknown',
      monitored: false,
      lastChecked: null,
      responseTimeMs: null,
      uptime: null,
      rateLimitRemaining: null,
      rateLimitTotal: null,
    };
  }
}

class HealthCheckTimeout extends Error {}

/** `promise`, or a HealthCheckTimeout after `ms` (the check itself keeps running). */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HealthCheckTimeout(`timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
