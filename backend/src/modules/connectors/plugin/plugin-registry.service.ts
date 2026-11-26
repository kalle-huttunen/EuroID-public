import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { createHash } from 'crypto';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import type {
  ConnectorManifest,
  ConnectorCapability,
  ConfigField,
} from './connector-manifest.interface';

const VALID_CONFIG_TYPES = ['text', 'password', 'select', 'boolean', 'number', 'json'];
const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedCapabilities {
  capabilities: ConnectorCapability[];
  expiresAt: number;
}

/**
 * The capability cache key: the tenant (request or activity context), the connector and a
 * SHA-256 of the whole config, secrets included, with its keys sorted. Never the secrets
 * themselves.
 */
function capabilityCacheKey(id: string, config: unknown): string {
  const tenantId = requestContext.getStore()?.tenantId ?? '';
  const entries = Object.entries((config ?? {}) as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return `${tenantId}|${id}|${digest}`;
}

@Injectable()
export class PluginRegistryService {
  private readonly logger = new Logger(PluginRegistryService.name);
  private readonly connectors = new Map<string, ConnectorManifest>();
  private readonly capabilityCache = new Map<string, CachedCapabilities>();

  constructor(private readonly moduleRef: ModuleRef) {}

  /** Register a connector plugin */
  register(manifest: ConnectorManifest): void {
    this.validateManifest(manifest);

    if (this.connectors.has(manifest.id)) {
      this.logger.warn(`Duplicate connector ID "${manifest.id}" — skipping registration`);
      return;
    }

    this.connectors.set(manifest.id, manifest);
    this.logger.log(`Registered connector: ${manifest.name} (${manifest.id})`);
  }

  /** Get all registered connectors */
  getAll(): ConnectorManifest[] {
    return Array.from(this.connectors.values());
  }

  /** Get a single connector by ID */
  getById(id: string): ConnectorManifest | undefined {
    return this.connectors.get(id);
  }

  /** Get connector capabilities */
  getCapabilities(id: string): ConnectorCapability[] {
    const manifest = this.connectors.get(id);
    return manifest?.capabilities ?? [];
  }

  /** Get connectors that support a specific capability */
  getByCapability(cap: ConnectorCapability): ConnectorManifest[] {
    return this.getAll().filter((m) => m.capabilities.includes(cap));
  }

  /**
   * Get runtime-validated capabilities for a connector. Falls back to static manifest
   * when validation fails or is not implemented. Results cached for 5 minutes per tenant,
   * connector and whole config (capabilityCacheKey): a config that differs in a secret is
   * validated on its own.
   */
  async getValidatedCapabilities(id: string, config?: unknown): Promise<ConnectorCapability[]> {
    const cacheKey = capabilityCacheKey(id, config);
    const cached = this.capabilityCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.capabilities;
    }

    const manifest = this.connectors.get(id);
    if (!manifest) return [];

    const staticCaps = manifest.capabilities ?? [];

    if (!manifest.serviceClass) {
      return staticCaps;
    }

    try {
      const service = this.moduleRef.get(manifest.serviceClass, { strict: false });
      if (!service || typeof service.validateCapabilities !== 'function') {
        return staticCaps;
      }
      const capabilities = await service.validateCapabilities(config);
      this.capabilityCache.set(cacheKey, {
        capabilities,
        expiresAt: Date.now() + CAPABILITY_CACHE_TTL_MS,
      });
      return capabilities;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`validateCapabilities failed for ${id}: ${message}`);
      return staticCaps;
    }
  }

  /** Get the config schema for dynamic form rendering */
  getConfigSchema(id: string): ConfigField[] {
    const manifest = this.connectors.get(id);
    return manifest?.configSchema ?? [];
  }

  /**
   * Config keys the connector declares secret (`type: 'password'` in its configSchema).
   * Undefined when no manifest is registered under this id.
   */
  getSecretConfigKeys(id: string): ReadonlySet<string> | undefined {
    const manifest = this.connectors.get(id);
    if (!manifest) return undefined;
    return new Set(
      manifest.configSchema.filter((field) => field.type === 'password').map((f) => f.key),
    );
  }

  /**
   * Every config key that some registered connector declares secret. For a config that names no
   * registered connector, a key in this set may still hold that connector's secret.
   */
  getAllSecretConfigKeys(): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const manifest of this.connectors.values()) {
      for (const field of manifest.configSchema) {
        if (field.type === 'password') keys.add(field.key);
      }
    }
    return keys;
  }

  private validateManifest(manifest: ConnectorManifest): void {
    const required = [
      'id',
      'name',
      'version',
      'description',
      'capabilities',
      'configSchema',
      'module',
    ];
    for (const field of required) {
      if (
        !(field in manifest) ||
        (manifest as unknown as Record<string, unknown>)[field] === undefined
      ) {
        throw new BadRequestException(`ConnectorManifest missing required field: ${field}`);
      }
    }
    if (!Array.isArray(manifest.capabilities)) {
      throw new BadRequestException('ConnectorManifest.capabilities must be an array');
    }
    if (!Array.isArray(manifest.configSchema)) {
      throw new BadRequestException('ConnectorManifest.configSchema must be an array');
    }
    for (const field of manifest.configSchema) {
      if (!field.key || !field.label) {
        throw new BadRequestException('ConfigField must have key and label');
      }
      if (!VALID_CONFIG_TYPES.includes(field.type)) {
        throw new BadRequestException(
          `ConfigField type "${field.type}" is invalid; must be one of: ${VALID_CONFIG_TYPES.join(', ')}`,
        );
      }
    }
  }
}

// ── TASK 107 RECAP ──
// Added: getValidatedCapabilities(id, config?) — resolves service via ModuleRef, calls validateCapabilities.
// 5-minute cache. Falls back to manifest.capabilities on error or when serviceClass absent.
