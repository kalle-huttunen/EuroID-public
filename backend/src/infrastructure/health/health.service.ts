/**
 * Health Service
 *
 * Counts installed connectors by sync status from ConnectorConfig documents (no live API calls,
 * no config decrypted). The readiness probe is public, so the counts name no connector, tenant or
 * sync time: a tenant admin reads their connectors' state through the authenticated routes
 * (GET /connectors/:name/status, GET /reconciliation/connector-health).
 *
 * One system query over every tenant's connector_configs (skipTenantScope; only tenantId,
 * lastSyncAt and lastSyncStatus are read) and one over tenants, cached for
 * HEALTH_CONNECTOR_CACHE_MS (15 s by default) and shared by probes that arrive while a read runs,
 * so a burst of public probes costs one read. A tenant whose tenants document is not active
 * (suspended, deprovisioned) is left out; a tenant without a tenants document (a single-tenant
 * deployment's DEFAULT_TENANT_ID) counts, as TenantStatusService treats it as active.
 */

import { Injectable, Logger } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ConnectorConfig,
  ConnectorConfigDocument,
} from '../../modules/connectors/schemas/connector-config.schema';
import { TenantService } from '../multi-tenancy/tenant.service';
import type { SecurityStateHealth } from '../cache/security-state.store';
import type { GraphConnectionState } from '../graph/graph.service';

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_CACHE_MS = 15_000;

/** What GET /health/ready answers as components.connectors. */
export interface ConnectorHealthSummary {
  /** Connectors whose last sync succeeded within 24 hours. */
  ok: number;
  /** Connectors whose last sync failed or is older than 24 hours: the probe is degraded. */
  stale: number;
  /** Connectors that never synced. */
  unknown: number;
  /** When the counts were read (cached); null when they were not (MongoDB down, a failed read). */
  checkedAt: string | null;
}

type SyncState = Pick<ConnectorConfig, 'tenantId' | 'lastSyncAt' | 'lastSyncStatus'>;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly cacheMs: number;
  private cached: { summary: ConnectorHealthSummary; expiresAt: number } | null = null;
  private reading: Promise<ConnectorHealthSummary> | null = null;

  constructor(
    @InjectModel(ConnectorConfig.name)
    private readonly configModel: Model<ConnectorConfigDocument>,
    private readonly tenantService: TenantService,
  ) {
    const configured = Number(process.env.HEALTH_CONNECTOR_CACHE_MS);
    this.cacheMs = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_CACHE_MS;
  }

  /** The counts not read: what the probe answers while MongoDB is down. */
  static notChecked(): ConnectorHealthSummary {
    return { ok: 0, stale: 0, unknown: 0, checkedAt: null };
  }

  /** The connector counts, from the cache while it is fresh. A failed read is not cached. */
  async getConnectorSummary(): Promise<ConnectorHealthSummary> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.summary;
    if (!this.reading) {
      this.reading = this.readConnectorSummary().finally(() => {
        this.reading = null;
      });
    }
    return this.reading;
  }

  private async readConnectorSummary(): Promise<ConnectorHealthSummary> {
    let states: SyncState[];
    let inactive: Set<string>;
    try {
      const [rows, tenants] = await Promise.all([
        this.configModel
          .find({}, '-_id tenantId lastSyncAt lastSyncStatus')
          .setOptions({ skipTenantScope: true })
          .lean<SyncState[]>()
          .exec(),
        this.tenantService.findAll(),
      ]);
      states = rows;
      inactive = new Set(tenants.filter((t) => t.status !== 'active').map((t) => t.tenantId));
    } catch (err: unknown) {
      this.logger.warn(
        `Readiness: connector states not read: ${err instanceof Error ? err.message : String(err)}`,
      );
      return HealthService.notChecked();
    }

    const now = Date.now();
    const summary: ConnectorHealthSummary = {
      ok: 0,
      stale: 0,
      unknown: 0,
      checkedAt: new Date(now).toISOString(),
    };
    for (const state of states) {
      if (inactive.has(state.tenantId)) continue;
      summary[statusOf(state, now)]++;
    }
    this.cached = { summary, expiresAt: now + this.cacheMs };
    return summary;
  }

  /**
   * unhealthy (503) without MongoDB. degraded (200) with a stale connector, or while the security
   * state store fails: the lockout, break-glass and SAML checks deny then. Not 503: every
   * instance shares the store, and requests with a valid token still work (the guard reads the
   * database instead). degraded too while a configured access graph is not connected: the
   * access explorer answers 503 and the event sync skips its writes; nothing else needs it.
   */
  computeOverallStatus(
    mongodbStatus: string,
    connectors: ConnectorHealthSummary,
    securityStateStatus: SecurityStateHealth['status'] = 'ok',
    graphState: GraphConnectionState = 'not-configured',
  ): { overallStatus: 'ok' | 'degraded' | 'unhealthy'; httpStatus: number } {
    if (mongodbStatus !== 'ok') {
      return { overallStatus: 'unhealthy', httpStatus: HttpStatus.SERVICE_UNAVAILABLE };
    }
    if (
      connectors.stale > 0 ||
      securityStateStatus === 'failing' ||
      graphState === 'not-connected'
    ) {
      return { overallStatus: 'degraded', httpStatus: HttpStatus.OK };
    }
    return { overallStatus: 'ok', httpStatus: HttpStatus.OK };
  }
}

/** stale: the last sync failed or is older than 24 hours; unknown: never synced. */
function statusOf(state: SyncState, now: number): 'ok' | 'stale' | 'unknown' {
  if (!state.lastSyncAt) return 'unknown';
  if (state.lastSyncStatus === 'failed') return 'stale';
  const syncedAt = state.lastSyncAt instanceof Date ? state.lastSyncAt : new Date(state.lastSyncAt);
  return now - syncedAt.getTime() > STALE_THRESHOLD_MS ? 'stale' : 'ok';
}
