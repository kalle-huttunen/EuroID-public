/**
 * Connector Config Service
 *
 * CRUD for connector installation state. Credentials are encrypted at rest
 * using AES-256-GCM. The listInstalled() method masks secret fields (declared
 * per connector manifest, see isSecretKey) in responses sent to the frontend.
 */

import {
  BadRequestException,
  Injectable,
  Inject,
  forwardRef,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConnectorConfig, ConnectorConfigDocument } from './schemas/connector-config.schema';
import { AuditService } from '../audit/audit.service';
import {
  EncryptionKeysNotLoadedError,
  EncryptionService,
} from '@infrastructure/secrets/encryption.service';
import { ConnectorConfigDecryptError } from './connector-config.errors';
import { ReconciliationConfigService } from '../identity/reconciliation-config.service';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { PluginRegistryService } from './plugin/plugin-registry.service';
import { SECRET_PLACEHOLDER } from '@infrastructure/secrets/config-secret-mask';
import { toSourceName } from '@shared/utils/source-name';
import { checkedConnectorConfig } from './connector-config-validation';
import { changedSecretDestinations } from './connector-secret-destinations';
import { SyncLockRenewals, takeableSyncLock } from './sync-lock';

/** HR connector priority & mastery config (stored unencrypted). */
export interface HrPriorityConfig {
  ingestPriority?: number;
  contractTag?: 'PRIMARY' | 'SECONDARY';
  masteryFields?: string[];
}

export type SyncStatusType = 'success' | 'failed' | 'running';

export interface SyncStatusUpdate {
  lastSyncAt: Date;
  lastSyncStatus: SyncStatusType;
  lastSyncCount?: number;
  lastSyncError?: string;
}

@Injectable()
export class ConnectorConfigService {
  private readonly logger = new Logger(ConnectorConfigService.name);

  constructor(
    @InjectModel(ConnectorConfig.name)
    private readonly configModel: Model<ConnectorConfigDocument>,
    private readonly auditService: AuditService,
    private readonly encryption: EncryptionService,
    @Inject(forwardRef(() => ReconciliationConfigService))
    private readonly reconConfigService: ReconciliationConfigService,
    private readonly pluginRegistry: PluginRegistryService,
  ) {}

  /**
   * Secret config keys are the ones the connector's manifest declares `type: 'password'`.
   * A connector without a registered manifest declares nothing, so all its keys count as secret.
   */
  private isSecretKey(connectorName: string, key: string): boolean {
    const secretKeys = this.pluginRegistry.getSecretConfigKeys(connectorName);
    return secretKeys ? secretKeys.has(key) : true;
  }

  /**
   * Install a connector with its configuration.
   * Config is encrypted at rest before storage.
   * For HR connectors, priorityConfig (ingestPriority, contractTag, masteryFields) is stored unencrypted.
   */
  /** Extract tenantId from request context; throws if missing in non-system calls. */
  private getTenantId(overrideTenantId?: string): string {
    const tid = overrideTenantId || getRequestContext()?.tenantId || 'default';
    return tid;
  }

  async install(
    name: string,
    config: Record<string, string>,
    installedBy = 'admin',
    priorityConfig?: HrPriorityConfig,
  ): Promise<ConnectorConfigDocument> {
    this.logger.log(`[ConnectorConfig] Installing connector: ${name}`);
    const tenantId = this.getTenantId();
    config = checkedConnectorConfig(this.pluginRegistry.getById(name), config); // 400 if wrong

    const configEncrypted = this.encryption.encrypt(JSON.stringify(config));

    const update: Record<string, unknown> = {
      configEncrypted,
      installedBy,
      installedAt: new Date(),
      updatedAt: new Date(),
      status: 'active',
      tenantId,
    };
    if (priorityConfig) {
      if (priorityConfig.ingestPriority != null)
        update.ingestPriority = priorityConfig.ingestPriority;
      if (priorityConfig.contractTag) update.contractTag = priorityConfig.contractTag;
      if (priorityConfig.masteryFields) update.masteryFields = priorityConfig.masteryFields;
    }
    const doc = await this.configModel.findOneAndUpdate(
      { connectorName: name, tenantId },
      { $set: update },
      { upsert: true, new: true },
    );

    const ctx = getRequestContext();
    this.auditService.logFireAndForget({
      action: 'CONNECTOR_INSTALLED',
      severity: 'info',
      actor: installedBy,
      resourceType: 'connector',
      resourceId: name,
      resourceName: name,
      description: `Connector "${name}" installed`,
      payload: { metadata: { configKeys: Object.keys(config) } },
      tenantId: ctx?.tenantId ?? 'default',
    });

    return doc;
  }

  /**
   * Uninstall a connector. Also removes it from the tenant's ReconciliationConfig
   * (hrSourceTags, sourcePriorityOrder, defaultMastery values).
   */
  async uninstall(name: string, overrideTenantId?: string, actor = 'admin'): Promise<void> {
    this.logger.log(`[ConnectorConfig] Uninstalling connector: ${name}`);
    const tenantId = this.getTenantId(overrideTenantId);
    const result = await this.configModel.findOneAndDelete({ connectorName: name, tenantId });
    if (!result) throw new NotFoundException(`Connector "${name}" not found`);

    // Scrub connector from ReconciliationConfig
    const tid = tenantId || result.tenantId || 'default';
    try {
      const reconConfig = await this.reconConfigService.getConfig(tid);
      if (reconConfig) {
        const lower = name.toLowerCase();
        const updated: Record<string, unknown> = {};
        const hrTags = reconConfig.hrSourceTags.filter((t) => t.toLowerCase() !== lower);
        if (hrTags.length !== reconConfig.hrSourceTags.length) updated.hrSourceTags = hrTags;
        const priority = reconConfig.sourcePriorityOrder.filter((t) => t.toLowerCase() !== lower);
        if (priority.length !== reconConfig.sourcePriorityOrder.length)
          updated.sourcePriorityOrder = priority;
        const mastery = { ...reconConfig.defaultMastery };
        let masteryChanged = false;
        for (const [field, sources] of Object.entries(mastery)) {
          const filtered = sources.filter((s) => s.toLowerCase() !== lower);
          if (filtered.length !== sources.length) {
            mastery[field] = filtered;
            masteryChanged = true;
          }
          if (filtered.length === 0) {
            delete mastery[field];
            masteryChanged = true;
          }
        }
        if (masteryChanged) updated.defaultMastery = mastery;
        if (Object.keys(updated).length > 0) {
          await this.reconConfigService.upsertConfig(tid, {
            hrSourceTags: (updated.hrSourceTags as string[]) ?? reconConfig.hrSourceTags,
            sourcePriorityOrder:
              (updated.sourcePriorityOrder as string[]) ?? reconConfig.sourcePriorityOrder,
            contractCriticalFields: reconConfig.contractCriticalFields,
            defaultMastery:
              (updated.defaultMastery as Record<string, string[]>) ?? reconConfig.defaultMastery,
            targetIdKeys: reconConfig.targetIdKeys,
          });
          this.logger.log(
            `[ConnectorConfig] Scrubbed "${name}" from ReconciliationConfig for tenant ${tid}`,
          );
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[ConnectorConfig] Failed to scrub "${name}" from ReconciliationConfig: ${message}`,
      );
    }

    this.auditService.logFireAndForget({
      action: 'CONNECTOR_REMOVED',
      severity: 'warning',
      actor,
      resourceType: 'connector',
      resourceId: name,
      resourceName: name,
      description: `Connector "${name}" uninstalled`,
      tenantId: tid,
    });
  }

  /**
   * Get the full config for a connector (internal use -- includes secrets).
   * Decrypts configEncrypted if present; migrates legacy plaintext on first read.
   * Throws ConnectorConfigDecryptError when this process cannot decrypt it (resolveConfig).
   */
  async getConfig(name: string): Promise<ConnectorConfigDocument | null> {
    const tenantId = this.getTenantId();
    const doc = await this.configModel.findOne({ connectorName: name, tenantId }).exec();
    if (!doc) return null;

    const obj = doc.toObject() as ConnectorConfigDocument & {
      configEncrypted?: string;
      config?: Record<string, string>;
    };
    const config = await this.resolveConfig(obj);
    return { ...obj, config } as ConnectorConfigDocument;
  }

  /**
   * A config sent from a form for a health check: a secret the user did not retype still holds
   * SECRET_PLACEHOLDER (GET /connectors and the blueprint API return secrets masked), so the
   * stored value takes its place. Other values are used as sent. A stored secret is only sent to
   * the saved destination (connector-secret-destinations.ts): when a destination field differs
   * from the saved config, 400 asks for the secret to be typed again.
   */
  async withStoredSecrets(
    name: string,
    config: Record<string, string>,
  ): Promise<Record<string, string>> {
    const masked = Object.entries(config).filter(
      ([key, value]) => value === SECRET_PLACEHOLDER && this.isSecretKey(name, key),
    );
    if (masked.length === 0) return config;
    const stored = (await this.getConfig(name))?.config as Record<string, string> | undefined;
    const restorable = masked.map(([key]) => key).filter((key) => stored?.[key]);
    if (restorable.length > 0) {
      const changed = changedSecretDestinations(name, config, stored ?? {}, (key) =>
        this.isSecretKey(name, key),
      );
      if (changed.length > 0) {
        throw new BadRequestException(
          `Type ${restorable.join(', ')} again to test a changed ${changed.join(', ')}: ` +
            'a stored secret is only sent to the saved destination',
        );
      }
    }
    const resolved = { ...config };
    for (const [key] of masked) {
      if (stored?.[key]) resolved[key] = stored[key];
      else delete resolved[key];
    }
    return resolved;
  }

  /**
   * List all installed connectors. Strips secret fields from the response.
   * A config this process cannot decrypt fails the list with ConnectorConfigDecryptError.
   */
  async listInstalled(): Promise<
    Array<Record<string, unknown> & { config: Record<string, string> }>
  > {
    const tenantId = this.getTenantId();
    const docs = await this.configModel.find({ tenantId }).lean().exec();
    const result: Array<Record<string, unknown> & { config: Record<string, string> }> = [];
    for (const doc of docs) {
      const obj = doc as unknown as ConnectorConfigDocument & {
        configEncrypted?: string;
        config?: Record<string, string>;
      };
      const config = await this.resolveConfig(obj);
      const safeConfig: Record<string, string> = {};
      for (const [key, value] of Object.entries(config)) {
        safeConfig[key] = this.isSecretKey(obj.connectorName, key)
          ? SECRET_PLACEHOLDER
          : (value as string);
      }
      // The ciphertext of every secret stays server-side: only the masked config goes out.
      const { configEncrypted: _ciphertext, ...publicFields } = obj;
      result.push({ ...publicFields, config: safeConfig });
    }
    return result;
  }

  /**
   * Update an existing connector's configuration.
   * Config is encrypted at rest before storage.
   * Merges with existing config when incoming omits secret fields (frontend sends redacted placeholders).
   * The merge needs the stored values, so a stored config this process cannot decrypt fails it
   * (ConnectorConfigDecryptError); install() replaces such a config without reading it.
   * For HR connectors, priorityConfig (ingestPriority, contractTag, masteryFields) is stored unencrypted.
   */
  async updateConfig(
    name: string,
    config: Record<string, string>,
    priorityConfig?: HrPriorityConfig,
    actor = 'admin',
  ): Promise<ConnectorConfigDocument> {
    const tenantId = this.getTenantId();
    config = checkedConnectorConfig(this.pluginRegistry.getById(name), config); // 400 if wrong
    const existing = await this.configModel.findOne({ connectorName: name, tenantId }).exec();
    let merged = config;
    if (existing) {
      const obj = existing.toObject() as ConnectorConfigDocument & {
        configEncrypted?: string;
        config?: Record<string, string>;
      };
      const existingConfig = (await this.resolveConfig(obj)) as Record<string, string>;
      merged = { ...existingConfig };
      for (const [key, value] of Object.entries(config)) {
        const isSecret = this.isSecretKey(name, key);
        if (!isSecret || (value !== SECRET_PLACEHOLDER && value !== '')) {
          merged[key] = value;
        }
      }
    }
    const configEncrypted = this.encryption.encrypt(JSON.stringify(merged));
    const update: Record<string, unknown> = { configEncrypted, updatedAt: new Date() };
    if (priorityConfig) {
      if (priorityConfig.ingestPriority != null)
        update.ingestPriority = priorityConfig.ingestPriority;
      if (priorityConfig.contractTag !== undefined) update.contractTag = priorityConfig.contractTag;
      if (priorityConfig.masteryFields !== undefined)
        update.masteryFields = priorityConfig.masteryFields;
    }
    const doc = await this.configModel.findOneAndUpdate(
      { connectorName: name, tenantId },
      { $set: update },
      { new: true },
    );
    if (!doc) throw new NotFoundException(`Connector "${name}" not found`);

    const reqCtx = getRequestContext();
    this.auditService.logFireAndForget({
      action: 'CONFIG_CHANGED',
      severity: 'info',
      actor,
      resourceType: 'connector',
      resourceId: name,
      resourceName: name,
      description: `Connector "${name}" configuration updated`,
      tenantId: reqCtx?.tenantId ?? 'default',
    });

    return doc;
  }

  /**
   * Check if a connector is installed.
   */
  async isInstalled(name: string): Promise<boolean> {
    const tenantId = this.getTenantId();
    const count = await this.configModel.countDocuments({ connectorName: name, tenantId }).exec();
    return count > 0;
  }

  /**
   * Get HR priority & mastery config for a connector (unencrypted fields).
   */
  async getHrPriorityConfig(name: string): Promise<HrPriorityConfig | null> {
    const tenantId = this.getTenantId();
    const doc = await this.configModel
      .findOne({ connectorName: name, tenantId })
      .select('ingestPriority contractTag masteryFields')
      .exec();
    if (!doc) return null;
    const obj = doc.toObject() as ConnectorConfigDocument;
    return {
      ingestPriority: obj.ingestPriority,
      contractTag: obj.contractTag,
      masteryFields: obj.masteryFields,
    };
  }

  /**
   * Get all installed HR connectors with their priority config, sorted by ingestPriority (asc).
   * Used by ReconciliationService for dynamic source priority order.
   */
  async getInstalledHrConnectorsWithPriority(
    hrSourceTags: string[] = [],
  ): Promise<
    Array<{ name: string; ingestPriority: number; contractTag?: string; masteryFields?: string[] }>
  > {
    if (hrSourceTags.length === 0) return [];
    const tenantId = this.getTenantId();
    const docs = await this.configModel
      .find({ connectorName: { $in: hrSourceTags }, tenantId })
      .select('connectorName ingestPriority contractTag masteryFields')
      .exec();
    return docs
      .map((d) => ({
        name: d.connectorName,
        ingestPriority: d.ingestPriority ?? 999,
        contractTag: d.contractTag,
        masteryFields: d.masteryFields,
      }))
      .sort((a, b) => a.ingestPriority - b.ingestPriority);
  }

  /**
   * Get the connector name for the primary HR source (multi-HR).
   * Returns connector config where config.hrRole === 'primary' or contractTag === 'PRIMARY'. First match wins.
   */
  async getPrimaryHrSourceName(hrSourceTags: string[] = []): Promise<string | null> {
    // Fast path: check contractTag index first
    const tenantId = this.getTenantId();
    const primary = await this.configModel
      .findOne({ contractTag: 'PRIMARY', tenantId })
      .select('connectorName')
      .lean()
      .exec();
    if (primary) return primary.connectorName;

    // Legacy fallback: check hrRole in decrypted config
    const docs = await this.configModel
      .find({ tenantId })
      .select('connectorName configEncrypted config')
      .lean()
      .exec();
    // A config this process cannot decrypt fails the lookup: skipping it could make another HR
    // source primary and let its values master the golden record
    for (const doc of docs) {
      const config = await this.resolveConfig(
        doc as ConnectorConfigDocument & {
          configEncrypted?: string;
          config?: Record<string, string>;
        },
      );
      if (config?.hrRole === 'primary') return doc.connectorName;
    }
    const byPriority = await this.getInstalledHrConnectorsWithPriority(hrSourceTags);
    return byPriority[0]?.name ?? null;
  }

  /**
   * Whether identity sources named `sourceName` come from an HR connector (manifest capability
   * `ingest`): its own source name (the connector id, e.g. `csv-hr`) or the `sourceSystem` the
   * tenant's installed config of it sets, both as toSourceName() writes them.
   */
  async isHrSourceName(sourceName: string): Promise<boolean> {
    const hrConnectors = this.pluginRegistry.getByCapability('ingest').map((m) => m.id);
    if (hrConnectors.some((id) => toSourceName(id) === sourceName)) return true;
    const docs = await this.configModel
      .find(
        { connectorName: { $in: hrConnectors }, tenantId: this.getTenantId() },
        'connectorName tenantId configEncrypted config',
      )
      .lean()
      .exec();
    for (const doc of docs) {
      const config = await this.resolveConfig(
        doc as ConnectorConfigDocument & {
          configEncrypted?: string;
          config?: Record<string, string>;
        },
      );
      const configured = config?.sourceSystem;
      if (typeof configured === 'string' && configured && toSourceName(configured) === sourceName) {
        return true;
      }
    }
    return false;
  }

  /**
   * Update sync status after an ingest or discovery run. The stored status is that run's alone:
   * a count or error the run did not report is removed (Mongoose drops an undefined value from
   * $set, which would keep an earlier run's), so a clean sync clears an earlier error.
   */
  async updateSyncStatus(name: string, update: SyncStatusUpdate): Promise<void> {
    const tenantId = this.getTenantId();
    this.lockRenewals.stop(tenantId, name); // the sync ended: its lock is no longer renewed
    const set: Record<string, unknown> = {
      lastSyncAt: update.lastSyncAt,
      lastSyncStatus: update.lastSyncStatus,
    };
    const unset: Record<string, ''> = {};
    for (const key of ['lastSyncCount', 'lastSyncError'] as const) {
      if (update[key] === undefined) unset[key] = '';
      else set[key] = update[key];
    }
    await this.configModel.updateOne(
      { connectorName: name, tenantId },
      Object.keys(unset).length > 0 ? { $set: set, $unset: unset } : { $set: set },
    );
  }

  /**
   * Take the connector's sync lock (atomic findOneAndUpdate): a free lock, or one not renewed for
   * SYNC_LOCK_STALE_MS. The lock taken is renewed until updateSyncStatus (sync-lock.ts).
   */
  async setSyncRunning(name: string): Promise<boolean> {
    const tenantId = this.getTenantId();
    const result = await this.configModel.findOneAndUpdate(
      { connectorName: name, tenantId, $or: takeableSyncLock(new Date()) },
      { $set: { lastSyncStatus: 'running' as SyncStatusType, lastSyncStartedAt: new Date() } },
      { new: true },
    );
    if (result !== null) this.lockRenewals.start(tenantId, name);
    return result !== null;
  }

  /** The renewals of the sync locks this process holds (see setSyncRunning). */
  private readonly lockRenewals = new SyncLockRenewals(
    (tenantId, name) =>
      this.configModel
        .updateOne(
          { connectorName: name, tenantId, lastSyncStatus: 'running' },
          { $set: { lastSyncStartedAt: new Date() } },
        )
        .exec(),
    (name, err) =>
      this.logger.warn(`[ConnectorConfig] Could not renew the sync lock of ${name}: ${err}`),
  );

  /**
   * List all installed connector names (for scheduler to iterate).
   */
  async listInstalledNames(): Promise<string[]> {
    const tenantId = this.getTenantId();
    const docs = await this.configModel.find({ tenantId }).select('connectorName').exec();
    return docs.map((d) => d.connectorName);
  }

  /**
   * Installed connectors' names and last sync, without decrypting any config (the readiness
   * probe): a config this process cannot decrypt must not fail it.
   */
  async listSyncStates(): Promise<
    Array<Pick<ConnectorConfig, 'connectorName' | 'lastSyncAt' | 'lastSyncStatus'>>
  > {
    return this.configModel
      .find({ tenantId: this.getTenantId() })
      .select('-_id connectorName lastSyncAt lastSyncStatus')
      .lean()
      .exec();
  }

  /**
   * Resolve decrypted config from a doc. Migrates legacy plaintext on first read.
   * A config this process cannot decrypt throws ConnectorConfigDecryptError and is left as it is:
   * the key may be missing only in this process, so only an admin's install or uninstall
   * replaces the stored config.
   */
  private async resolveConfig(
    doc: ConnectorConfigDocument & { configEncrypted?: string; config?: Record<string, string> },
  ): Promise<Record<string, string>> {
    if (doc.configEncrypted) {
      try {
        return JSON.parse(this.encryption.decrypt(doc.configEncrypted)) as Record<string, string>;
      } catch (err: unknown) {
        throw this.decryptFailure(doc.connectorName, err);
      }
    }
    if (doc.config) {
      const config = doc.config;
      const configEncrypted = this.encryption.encrypt(JSON.stringify(config));
      await this.configModel.updateOne(
        { connectorName: doc.connectorName, tenantId: (doc as ConnectorConfigDocument).tenantId },
        { $set: { configEncrypted }, $unset: { config: '' } },
      );
      this.logger.log(
        `[ConnectorConfig] Migrated legacy plaintext config for ${doc.connectorName}`,
      );
      return config;
    }
    return {};
  }

  /** Logs why a stored config could not be decrypted and returns the error to throw. */
  private decryptFailure(connectorName: string, err: unknown): ConnectorConfigDecryptError {
    const where = `${connectorName} (tenant ${this.getTenantId()})`;
    if (err instanceof EncryptionKeysNotLoadedError) {
      this.logger.warn(`[ConnectorConfig] Config of ${where} read before the keys were loaded`);
      return new ConnectorConfigDecryptError(connectorName, false);
    }
    // A JSON.parse error quotes the text it parsed, here the decrypted config: never logged
    const reason =
      err instanceof SyntaxError ? 'not JSON' : err instanceof Error ? err.message : String(err);
    this.logger.error(
      `[ConnectorConfig] Stored config of ${where} could not be decrypted (${reason}); left unchanged`,
    );
    return new ConnectorConfigDecryptError(connectorName);
  }
}
