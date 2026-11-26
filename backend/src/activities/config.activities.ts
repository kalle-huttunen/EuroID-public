/**
 * Configuration Activities
 *
 * Temporal activities that read blueprint configuration data from MongoDB.
 * These activities allow workflows to:
 * - Discover which target systems are active in the current blueprint
 * - Retrieve system-specific credentials and connection details
 * - Access configuration set up via the ReactFlow canvas UI
 *
 * Used by onboarding workflows to dynamically provision users across
 * all configured spoke systems based on the visual blueprint.
 */
import { Injectable, Logger } from '@nestjs/common';
import { BlueprintsService } from '../modules/blueprints/blueprints.service';
import type { EdgeFlowData } from '../modules/blueprints/edge-condition-evaluator';
import { PluginRegistryService } from '../modules/connectors/plugin/plugin-registry.service';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';

/** The system name callers use for a canvas connector type ('entra-id' -> 'entra'). */
function toSystemName(connectorType: string): string {
  const name = connectorType
    .replace(/-id$/i, '')
    .replace(/-target$/i, '')
    .toLowerCase();
  return name === 'active-directory' ? 'ad' : name;
}

/** Id of a target node the Design studio saved without `data.type`: '<system>-target[-suffix]'. */
const UNTYPED_TARGET_ID = /^(.+?)-target(?:-|$)/i;

@Injectable()
export class ConfigActivities {
  private readonly logger = new Logger(ConfigActivities.name);

  constructor(
    private readonly blueprintsService: BlueprintsService,
    private readonly connectorRegistry: PluginRegistryService,
  ) {}

  /**
   * The target systems on the saved canvas, by system name ('entra', 'ad', 'okta',
   * 'file-outbound', ...). Onboarding health-checks and provisions each of them; admin account
   * provisioning, the mover and access-review target discovery read them too. A connector is a
   * target when its manifest declares 'provision': HR sources (CSV HR, JSON API HR) declare only
   * 'ingest' and are left out. A type without a registered manifest stays in, so onboarding's
   * health check reports it instead of skipping it silently. A target node saved without a type
   * (the old default canvas's `entra-target`) is named by its id, see connectorTypeOf.
   */
  async getActiveTargetSystems(tenantId?: string, correlationId?: string): Promise<string[]> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        try {
          // Fetch from the new Canvas Blueprint schema (same as getConnectorConfig)
          const blueprint = await this.blueprintsService.getLatestBlueprint();

          // Extract unique connector types from nodes
          // Look for nodes with data.type property (e.g., 'entra-id', 'entra-target')
          const systems = new Set<string>();

          for (const node of blueprint.nodes) {
            // Skip hub and other non-connector nodes
            if (node.type === 'hub') continue;
            const connectorType = this.connectorTypeOf(node);
            if (!connectorType) continue;
            const system = toSystemName(connectorType);
            if (this.isTargetSystem(system)) systems.add(system);
          }

          const result = Array.from(systems);
          this.logger.debug(
            `Discovered ${result.length} active target systems: ${result.join(', ')}`,
          );
          return result;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error('Failed to get active target systems:', message);
          return [];
        }
      },
      { correlationId },
    );
  }

  /** The connector whose manifest id names this system provisions accounts (see above). */
  private isTargetSystem(system: string): boolean {
    const manifest = this.connectorRegistry.getAll().find((m) => toSystemName(m.id) === system);
    return manifest ? manifest.capabilities.includes('provision') : true;
  }

  /**
   * The connector type of a canvas node: its `data.type`, which the Design studio sets on every
   * connector it adds. The default canvas's Entra ID node (`entra-target`) had none before 2.0da
   * and canvases saved from it still lack it, so a target node without a type is named by its id,
   * '<system>-target' with an optional suffix, when <system> is the system name of a registered
   * connector ('entra-target' -> 'entra-id'). Undefined when neither names a connector.
   */
  private connectorTypeOf(node: Record<string, unknown>): string | undefined {
    const data = node.data as Record<string, unknown> | undefined;
    if (data?.type) return data.type as string;
    if (data?.role !== 'target' || typeof node.id !== 'string') return undefined;
    const system = UNTYPED_TARGET_ID.exec(node.id)?.[1];
    if (!system) return undefined;
    const named = toSystemName(system);
    return this.connectorRegistry.getAll().find((m) => toSystemName(m.id) === named)?.id;
  }

  /**
   * Fetch connector configuration from the saved Blueprint canvas
   *
   * @param connectorId - The connector node ID (e.g., 'entra-id', 'entra-target')
   * @returns The config object from the node's data.config, or null if not found
   */
  async getConnectorConfig(
    connectorId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<Record<string, unknown> | null> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        try {
          // Fetch the latest canvas blueprint
          const blueprint = await this.blueprintsService.getLatestBlueprint();

          this.logger.debug(
            `🔍 SEARCHING for connector "${connectorId}" in ${blueprint.nodes.length} nodes`,
          );
          this.logger.debug(`Blueprint ID: ${blueprint._id}`);
          this.logger.debug(`📋 ALL NODES IN BLUEPRINT:`);
          blueprint.nodes.forEach((node: Record<string, unknown>, index: number) => {
            const data = node.data as Record<string, unknown> | undefined;
            this.logger.debug(`  [${index}] id="${node.id}"`);
            this.logger.debug(`      type="${node.type}"`);
            this.logger.debug(`      data.type="${data?.type}"`);
            this.logger.debug(`      data.role="${data?.role}"`);
            this.logger.debug(`      data.label="${data?.label}"`);
            this.logger.debug(`      has data.config: ${!!data?.config}`);
            const config = data?.config as Record<string, unknown> | undefined;
            if (config) {
              this.logger.debug(`      config keys: ${Object.keys(config).join(', ')}`);
              if (config.tenantId) {
                this.logger.debug(
                  `      config.tenantId: ${String(config.tenantId).substring(0, 8)}...`,
                );
              }
            }
          });

          // Look for the connector node in the nodes array
          // Try multiple matching strategies:
          // 1. Match by node ID
          // 2. Match by data.type
          // 3. Match by partial ID (e.g., 'entra' matches 'entra-id-target-123')
          const connectorNode =
            blueprint.nodes.find((node: Record<string, unknown>) => {
              const nodeData = node.data as Record<string, unknown> | undefined;
              const nodeId = String(node.id ?? '');
              const nodeType = String(nodeData?.type ?? '');
              return (
                nodeId === connectorId ||
                nodeType === connectorId ||
                nodeId.toLowerCase().includes(connectorId.toLowerCase()) ||
                nodeType.toLowerCase().includes(connectorId.toLowerCase())
              );
            }) ??
            // 4. A target node saved without data.type whose id names the same system (the old
            //    default canvas's 'entra-target' for 'entra-id', see connectorTypeOf)
            blueprint.nodes.find((node: Record<string, unknown>) => {
              if ((node.data as Record<string, unknown> | undefined)?.type) return false;
              const derived = this.connectorTypeOf(node);
              return derived !== undefined && toSystemName(derived) === toSystemName(connectorId);
            });

          if (!connectorNode) {
            this.logger.warn(`❌ Connector "${connectorId}" NOT FOUND in canvas blueprint`);
            return null;
          }

          const nodeData = connectorNode.data as Record<string, unknown> | undefined;
          const config = nodeData?.config as Record<string, unknown> | undefined;

          if (!config) {
            this.logger.warn(`⚠️  Connector ${connectorId} found but has NO CONFIG`);
            return null;
          }

          this.logger.debug(
            `✅ FOUND connector node: id="${connectorNode.id}", has config: ${!!nodeData?.config}`,
          );
          this.logger.debug(
            `✅ Retrieved config for connector ${connectorId} with keys: ${Object.keys(config).join(', ')}`,
          );
          if (config.tenantId) {
            this.logger.debug(
              `   Tenant ID starts with: ${String(config.tenantId).substring(0, 8)}...`,
            );
          }
          return config;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`❌ FAILED to get connector config for ${connectorId}:`, message);
          return null;
        }
      },
      { correlationId },
    );
  }

  /**
   * Fetch edge conditions for a specific target system from the saved canvas.
   * Returns the EdgeFlowData from the Brain-to-Target edge, or null if none.
   *
   * @param targetSystemId - The target connector node ID or type (e.g., 'entra-id')
   */
  async getEdgeConditions(
    targetSystemId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<EdgeFlowData | null> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        try {
          const blueprint = await this.blueprintsService.getLatestBlueprint();
          if (!blueprint.edges?.length) return null;

          // Find the edge from the brain (euroid-core) to the target system
          const edge = blueprint.edges.find((e: Record<string, unknown>) => {
            const source = String(e.source ?? '');
            const target = String(e.target ?? '');
            return (
              source === 'euroid-core' &&
              (target === targetSystemId ||
                target.toLowerCase().includes(targetSystemId.toLowerCase()))
            );
          });

          if (!edge) {
            this.logger.debug(`No edge found from Brain to ${targetSystemId}`);
            return null;
          }

          const edgeData = edge.data as EdgeFlowData | undefined;
          if (!edgeData?.conditionsEnabled || !edgeData?.conditionGroups?.length) {
            return null; // No active conditions
          }

          this.logger.log(
            `Found edge conditions for ${targetSystemId}: ${edgeData.conditionGroups.length} groups`,
          );
          return edgeData;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`Failed to get edge conditions for ${targetSystemId}:`, message);
          return null;
        }
      },
      { correlationId },
    );
  }
}
