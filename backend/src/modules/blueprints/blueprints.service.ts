import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BlueprintNode, CanvasBlueprint } from './schemas/blueprint.schema';
import { AuditService } from '../audit/audit.service';
import { EncryptionService } from '@infrastructure/secrets/encryption.service';
import {
  encryptConfigIfNeeded,
  decryptConfigIfEncrypted,
} from '@infrastructure/secrets/config-encryption.helper';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import {
  hasMaskedSecret,
  maskSecrets,
  restoreMaskedSecrets,
} from '@infrastructure/secrets/config-secret-mask';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';
import { canvasHrSources } from '@shared/utils/canvas-hr-sources';
import type { UpdateNodeConfigDto } from './dtos/blueprint-validation';
import {
  isPlainObject,
  maskConnectorConfigSecrets,
  maskNodeSecrets,
  restoreConnectorConfigSecrets,
  restoreNodeSecrets,
  secretPredicateFor,
} from './blueprint-secrets';
import { CanvasRevisionConflict } from './canvas-load.errors';
import { changedConnectorSettings } from './canvas-connector-changes';

/** ReactFlow canvas node shape stored in MongoDB. */
interface CanvasNodeRecord {
  id: string;
  type?: string;
  position?: { x: number; y: number };
  data?: {
    role?: string;
    type?: string;
    config?: Record<string, unknown> | string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** ReactFlow canvas edge shape stored in MongoDB. */
interface CanvasEdgeRecord {
  id: string;
  source: string;
  target: string;
  [key: string]: unknown;
}

/** Blueprint cache entry with tenant isolation. */
interface BlueprintCacheEntry {
  data: CanvasBlueprint;
  expiresAt: number;
  tenantId: string;
}

/**
 * Persists canvas nodes and draft blueprints. Supplies ConfigActivities with connector config for the Temporal Worker.
 * Configs containing secrets are encrypted at rest. A secret is a field the connector manifest
 * declares `type: 'password'`; a config of a node that names no registered connector is
 * encrypted whole. Responses carry secrets masked (the *Masked / toMaskedNode methods, see
 * blueprint-secrets.ts), and a save that sends the mask back keeps the stored value.
 */
@Injectable()
export class BlueprintsService {
  private readonly logger = new Logger(BlueprintsService.name);
  private _blueprintCache: BlueprintCacheEntry | null = null;
  private static readonly CACHE_TTL_MS = 5000;

  constructor(
    @InjectModel(BlueprintNode.name) private blueprintModel: Model<BlueprintNode>,
    @InjectModel(CanvasBlueprint.name) private canvasBlueprintModel: Model<CanvasBlueprint>,
    private readonly auditService: AuditService,
    private readonly encryption: EncryptionService,
    private readonly pluginRegistry: PluginRegistryService,
  ) {}

  /**
   * Secret keys of the connector a canvas node or config entry names (node `data.type`,
   * `nodeType`, or the connectorConfigs key). Undefined when it names no registered connector,
   * which makes encryptConfigIfNeeded encrypt the whole config.
   */
  private secretKeysOf(connectorId: unknown): ReadonlySet<string> | undefined {
    return typeof connectorId === 'string'
      ? this.pluginRegistry.getSecretConfigKeys(connectorId)
      : undefined;
  }

  /**
   * [STEP C/D PERSISTENCE]
   * Updates or creates a configuration for a specific node on the canvas.
   * Configs with secrets are encrypted at rest. A masked secret keeps the node's stored value.
   */
  async updateNodeConfig(nodeId: string, updateData: UpdateNodeConfigDto): Promise<BlueprintNode> {
    const tenantId = getRequestContext()?.tenantId || 'default';
    const data: Record<string, unknown> = { ...updateData };
    if (data.config != null) {
      const config = data.config as Record<string, unknown>;
      const isSecret = secretPredicateFor(this.pluginRegistry, updateData.nodeType);
      const stored = hasMaskedSecret(config, isSecret)
        ? ((await this.getNodeConfig(nodeId))?.config as Record<string, unknown> | undefined)
        : undefined;
      data.config = encryptConfigIfNeeded(
        this.encryption,
        restoreMaskedSecrets(config, stored, isSecret),
        this.secretKeysOf(updateData.nodeType),
      );
    }
    const updated = await this.blueprintModel.findOneAndUpdate(
      { nodeId, tenantId },
      { $set: { ...data, tenantId } },
      { upsert: true, new: true },
    );
    this.logger.log(`Updated config for node: ${nodeId}`);
    // Connector settings, secrets included, can redirect provisioning: who saved which keys
    // (never their values)
    this.auditService.logFireAndForget({
      action: 'CONFIG_CHANGED',
      severity: 'info',
      actor: getRequestContext()?.actor || 'unknown',
      resourceType: 'blueprint-node',
      resourceId: nodeId,
      resourceName: updateData.nodeType ?? nodeId,
      description: `Connector settings of node ${nodeId} saved`,
      payload: {
        metadata: {
          nodeType: updateData.nodeType,
          configKeys: Object.keys((updateData.config as Record<string, unknown> | undefined) ?? {}),
        },
      },
      tenantId,
    });
    return this.hydrateNodeConfig(updated);
  }

  /**
   * Used by ConfigActivities to fetch the live settings for the Temporal Worker.
   * Also used by the entitlements endpoint to fetch connector-specific config.
   *
   * This method checks both the individual node config AND the canvas state
   * to find the most recent configuration for a node.
   */
  async getNodeConfig(nodeId: string): Promise<BlueprintNode | null> {
    const tenantId = getRequestContext()?.tenantId || 'default';
    let config = await this.blueprintModel.findOne({ nodeId, tenantId });
    if (!config) {
      const canvas = await this.canvasBlueprintModel.findOne({ version: 'draft', tenantId });
      if (canvas) {
        const node = (canvas.nodes as CanvasNodeRecord[]).find((n) => n.id === nodeId);
        if (node && node.data && node.data.config) {
          const decrypted = decryptConfigIfEncrypted(this.encryption, node.data.config);
          return {
            nodeId,
            nodeType: node.data.type,
            config: decrypted,
          } as unknown as BlueprintNode;
        }
      }
    }

    return config ? this.hydrateNodeConfig(config) : null;
  }

  /**
   * [CANVAS PERSISTENCE]
   * Saves the complete ReactFlow canvas state to MongoDB.
   * Uses singleton pattern - only one draft canvas per system.
   * Configs with secrets are encrypted at rest. A masked secret (the canvas as GET /latest
   * returned it) keeps the stored value of the same node or connectorConfigs entry.
   * `revision`: the canvasRevision the client loaded. The save goes through only while it is
   * still the stored one (checked in the update itself, so of two saves of one revision exactly
   * one wins); otherwise CanvasRevisionConflict (409) and nothing is saved. Without it (a client
   * from before revisions) the save is unchecked and audited as such. Every save adds 1.
   */
  async saveBlueprint(canvasData: {
    nodes: CanvasNodeRecord[];
    edges: CanvasEdgeRecord[];
    viewport?: { x: number; y: number; zoom: number };
    connectorConfigs?: Record<string, unknown>;
    revision?: number;
  }): Promise<CanvasBlueprint> {
    this._blueprintCache = null;
    const { edges, viewport, revision } = canvasData;
    const tenantId = getRequestContext()?.tenantId || 'default';

    const stored = await this.canvasBlueprintModel.findOne({ version: 'draft', tenantId });
    const storedRevision = stored ? (stored.canvasRevision ?? 0) : 0;
    if (revision !== undefined && revision !== storedRevision) {
      throw new CanvasRevisionConflict(revision, storedRevision);
    }
    const storedNodes = new Map(
      ((stored?.nodes as CanvasNodeRecord[] | undefined) ?? []).map((n) => [n.id, n]),
    );
    const storedConfigs = (stored?.connectorConfigs ?? {}) as Record<string, unknown>;
    const decryptStored = (raw: unknown) =>
      raw == null
        ? undefined
        : decryptConfigIfEncrypted(this.encryption, raw as string | Record<string, unknown>);
    const nodes = restoreNodeSecrets(
      canvasData.nodes || [],
      (id) => decryptStored(storedNodes.get(id)?.data?.config),
      this.pluginRegistry,
    );
    const connectorConfigs = restoreConnectorConfigSecrets(
      canvasData.connectorConfigs || {},
      (key) => decryptStored(storedConfigs[key]),
      this.pluginRegistry,
    );

    // For the audit only: a stored config this key cannot read (the error the studio shows on
    // load) must not refuse the save that replaces it; it counts as changed
    const readStored = (raw: unknown) => {
      try {
        return decryptStored(raw);
      } catch {
        return { unreadable: true };
      }
    };
    const connectorConfigChanges = changedConnectorSettings(
      {
        nodes: [...storedNodes.values()].map((n) => ({
          ...n,
          data: { ...n.data, config: readStored(n.data?.config) },
        })),
        connectorConfigs: Object.fromEntries(
          Object.entries(storedConfigs).map(([k, v]) => [k, readStored(v)]),
        ),
      },
      { nodes, connectorConfigs },
      (id) => this.pluginRegistry.getById(id) !== undefined,
    );

    const nodesToSave = nodes.map((node: CanvasNodeRecord) => {
      if (node?.data?.config != null) {
        const enc = encryptConfigIfNeeded(
          this.encryption,
          node.data.config as Record<string, unknown>,
          this.secretKeysOf(node.data.type),
        );
        return { ...node, data: { ...node.data, config: enc } };
      }
      return node;
    });

    const configsToSave: Record<string, string | Record<string, unknown> | undefined> = {};
    for (const [k, v] of Object.entries(connectorConfigs)) {
      configsToSave[k] = encryptConfigIfNeeded(
        this.encryption,
        v as Record<string, unknown>,
        this.secretKeysOf(k),
      );
    }

    // A canvas saved before revisions has none: revision 0 matches it
    const revisionFilter =
      revision === undefined
        ? {}
        : { canvasRevision: revision === 0 ? { $in: [0, null] } : revision };
    const saved = await this.canvasBlueprintModel.findOneAndUpdate(
      { version: 'draft', tenantId, ...revisionFilter },
      {
        $inc: { canvasRevision: 1 },
        $set: {
          nodes: nodesToSave,
          edges,
          viewport: viewport || { x: 0, y: 0, zoom: 1 },
          connectorConfigs: configsToSave,
          tenantId,
          // An impact analysis from before this save no longer describes what Deploy deploys
          'pipelineConfig.canvasSavedAt': new Date(),
        },
      },
      // A checked save creates the canvas only when none is stored (revision 0)
      { upsert: revision === undefined || !stored, new: true },
    );
    if (!saved) {
      // Saved by someone else between the read above and this update
      throw new CanvasRevisionConflict(revision ?? 0, undefined);
    }
    const checked = revision !== undefined;

    this.logger.log(`Saved canvas with ${nodesToSave.length} nodes and ${edges.length} edges`);
    if (!checked) {
      this.logger.warn(
        `Canvas of ${tenantId} saved without a revision (a client from before revisions): unchecked`,
      );
    }

    this.auditService.logFireAndForget({
      action: 'CONFIG_CHANGED',
      severity: 'info',
      actor: getRequestContext()?.actor || 'unknown',
      resourceType: 'blueprint',
      resourceId: saved._id?.toString() || 'draft',
      resourceName: 'Canvas Blueprint',
      description:
        `Canvas saved with ${nodes.length} nodes and ${edges.length} edges` +
        (checked
          ? ''
          : ' (unchecked: the client sent no revision, so a concurrent save may be lost)'),
      payload: {
        metadata: {
          nodeCount: nodesToSave.length,
          edgeCount: edges.length,
          revision: saved.canvasRevision,
          revisionChecked: checked,
          // The connectors whose settings this save changed (the ISO report's connector
          // configuration changes)
          connectorConfigChanges,
        },
      },
      tenantId,
    });

    return saved;
  }

  /**
   * Get HR priority & mastery config for a source from the blueprint (Design Studio config).
   * Source nodes store ingestPriority, contractTag, masteryFields in node.data.config.
   */
  async getHrPriorityFromBlueprint(sourceName: string): Promise<{
    ingestPriority?: number;
    contractTag?: string;
    masteryFields?: string[];
  } | null> {
    const canvas = await this.getLatestBlueprint();
    const node = (canvas.nodes as CanvasNodeRecord[])?.find(
      (n) =>
        n.data?.role === 'source' &&
        (n.data?.type === sourceName ||
          n.id?.toLowerCase().includes(sourceName.toLowerCase().replace(/\s+/g, '-'))),
    );
    const cfg = node?.data?.config as Record<string, unknown> | undefined;
    if (!cfg) return null;
    return {
      ingestPriority: cfg.ingestPriority as number | undefined,
      contractTag: cfg.contractTag as string | undefined,
      masteryFields: cfg.masteryFields as string[] | undefined,
    };
  }

  /**
   * Get all HR source connectors with priority from the blueprint, sorted by ingestPriority.
   */
  async getHrConnectorsWithPriorityFromBlueprint(
    hrSourceTags: string[] = [],
  ): Promise<
    Array<{ name: string; ingestPriority: number; contractTag?: string; masteryFields?: string[] }>
  > {
    if (hrSourceTags.length === 0) return [];
    const canvas = await this.getLatestBlueprint();
    return canvasHrSources(canvas.nodes, hrSourceTags);
  }

  /**
   * Get connector config for Impact Analysis (e.g., Entra domain for UPN resolution).
   * Finds the node in the canvas by type (e.g., 'entra-id').
   */
  async getConnectorConfigForImpact(
    connectorType: string,
  ): Promise<Record<string, unknown> | null> {
    const canvas = await this.getLatestBlueprint();
    const node = (canvas.nodes as CanvasNodeRecord[])?.find(
      (n) =>
        n.data?.type === connectorType || n.id?.toLowerCase().includes(connectorType.toLowerCase()),
    );
    return (node?.data?.config as Record<string, unknown>) ?? null;
  }

  /**
   * [CANVAS PERSISTENCE]
   * Retrieves the latest saved canvas state.
   * Returns empty canvas if none exists.
   * Decrypts configs that were encrypted at rest.
   * Uses 5s TTL in-memory cache; invalidated on saveBlueprint.
   */
  async getLatestBlueprint(explicitTenantId?: string): Promise<CanvasBlueprint> {
    const now = Date.now();
    const tenantId = explicitTenantId || getRequestContext()?.tenantId || 'default';
    const cacheKey = `${tenantId}`;
    if (
      this._blueprintCache &&
      this._blueprintCache.expiresAt > now &&
      this._blueprintCache.tenantId === cacheKey
    ) {
      return this._blueprintCache.data;
    }

    const canvas = await this.canvasBlueprintModel.findOne({ version: 'draft', tenantId });

    if (!canvas) {
      // Return empty canvas structure if none exists
      this.logger.log('No saved canvas found, returning empty state');
      const empty = {
        version: 'draft',
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        connectorConfigs: {},
      } as unknown as CanvasBlueprint;
      this._blueprintCache = {
        data: empty,
        expiresAt: now + BlueprintsService.CACHE_TTL_MS,
        tenantId: cacheKey,
      };
      return empty;
    }

    const nodes = ((canvas.nodes as CanvasNodeRecord[]) || []).map((node: CanvasNodeRecord) => {
      if (node?.data?.config != null) {
        const dec = decryptConfigIfEncrypted(this.encryption, node.data.config);
        return { ...node, data: { ...node.data, config: dec } };
      }
      return node;
    });

    const connectorConfigs: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(canvas.connectorConfigs || {})) {
      connectorConfigs[k] = decryptConfigIfEncrypted(this.encryption, v);
    }

    this.logger.log(`Loaded canvas with ${nodes.length} nodes`);
    const result = { ...canvas.toObject(), nodes, connectorConfigs } as unknown as CanvasBlueprint;
    this._blueprintCache = {
      data: result,
      expiresAt: now + BlueprintsService.CACHE_TTL_MS,
      tenantId: cacheKey,
    };
    return result;
  }

  /** The latest canvas as clients get it: getLatestBlueprint with every connector secret masked. */
  async getLatestBlueprintMasked(): Promise<CanvasBlueprint> {
    const canvas = await this.getLatestBlueprint();
    return {
      ...canvas,
      nodes: maskNodeSecrets((canvas.nodes ?? []) as CanvasNodeRecord[], this.pluginRegistry),
      connectorConfigs: maskConnectorConfigSecrets(
        (canvas.connectorConfigs ?? {}) as Record<string, unknown>,
        this.pluginRegistry,
      ),
    } as CanvasBlueprint;
  }

  /** A node config as clients get it: its connector secrets masked (by the node's nodeType). */
  toMaskedNode(node: BlueprintNode | null): Record<string, unknown> | null {
    if (!node) return null;
    const doc = node as unknown as { toObject?: () => Record<string, unknown> };
    const plain = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
    if (!isPlainObject(plain.config)) return plain;
    return {
      ...plain,
      config: maskSecrets(plain.config, secretPredicateFor(this.pluginRegistry, plain.nodeType)),
    };
  }

  private hydrateNodeConfig(doc: BlueprintNode): BlueprintNode {
    if (doc.config != null && typeof doc.config === 'string') {
      const dec = decryptConfigIfEncrypted(this.encryption, doc.config);
      return { ...doc.toObject(), config: dec } as BlueprintNode;
    }
    return doc;
  }
}
