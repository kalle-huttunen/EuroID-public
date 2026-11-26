import { BadRequestException, Injectable } from '@nestjs/common';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { canvasHrSources } from '@shared/utils/canvas-hr-sources';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import type { HrConnectorWithPriority } from '../correlation-config/correlation-config.interface';
import { ReconciliationConfigService } from './reconciliation-config.service';
import type { UpsertReconciliationConfigDto } from './dtos/reconciliation-config.dto';
import { DEFAULT_TENANT } from './identity.constants';
import {
  configuredPrimaryHrSource,
  contractCriticalMasteryMessage,
  contractCriticalMasteryProblems,
  sourceMasterySetting,
  type HrConnectorRank,
  type MasterySetting,
} from './contract-critical-mastery';

/** The canvas POST /blueprints/save stores, as far as the check reads it. */
export interface CanvasMastery {
  nodes: readonly unknown[];
  connectorConfigs?: Record<string, unknown>;
}

/**
 * The saves that store mastery refuse (400) an entry that names a secondary HR source or a target
 * for a contract-critical field (contract-critical-mastery.ts): the Recon Config, the Design studio
 * canvas and an installed connector's priority config. Each save checks the settings it stores, so
 * a setting saved before this rule never blocks the save that corrects another one.
 */
@Injectable()
export class ContractCriticalMasteryService {
  constructor(
    private readonly reconConfigService: ReconciliationConfigService,
    private readonly correlationConfigService: CorrelationConfigService,
  ) {}

  /**
   * PUT /admin/reconciliation-config: its default mastery, against its contract-critical fields;
   * the primary from the HR connectors reconcile reads (the Design studio's source nodes, else the
   * installed connectors) with the HR source tags and source priority being saved.
   */
  async assertReconConfig(config: UpsertReconciliationConfigDto): Promise<void> {
    const fromCanvas = await this.correlationConfigService.getHrConnectorsWithPriorityFromBlueprint(
      config.hrSourceTags,
    );
    const connectors = fromCanvas.length > 0 ? fromCanvas : await this.installed(config);
    const primary = configuredPrimaryHrSource(
      connectors,
      config.hrSourceTags,
      config.sourcePriorityOrder,
    );
    this.assert(
      [{ label: 'Default mastery', entries: config.defaultMastery }],
      config.contractCriticalFields,
      primary,
    );
  }

  /**
   * POST /blueprints/save: the Brain's Field Mastery (correlationConfig.fieldMasteryOverrides)
   * and the HR source nodes' mastery fields of the canvas being saved, against the tenant's Recon
   * Config; the primary from that canvas's HR source nodes (their Contract Tag and ingest
   * priority), else the installed connectors. Without a Recon Config no field is contract-critical.
   */
  async assertCanvas(canvas: CanvasMastery): Promise<void> {
    const tenantId = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const config = await this.reconConfigService.getConfig(tenantId);
    if (!config || (config.contractCriticalFields ?? []).length === 0) return;
    const sources = canvasHrSources(canvas.nodes, config.hrSourceTags ?? []);
    const connectors = sources.length > 0 ? sources : await this.installed(config);
    const primary = configuredPrimaryHrSource(
      connectors,
      config.hrSourceTags ?? [],
      config.sourcePriorityOrder ?? [],
    );
    const brain = canvas.connectorConfigs?.['euroid-core'] as
      | { correlationConfig?: { fieldMasteryOverrides?: Record<string, string[]> } }
      | undefined;
    this.assert(
      [
        { label: 'Field Mastery', entries: brain?.correlationConfig?.fieldMasteryOverrides ?? {} },
        ...sources.map(sourceMasterySetting),
      ],
      config.contractCriticalFields,
      primary,
    );
  }

  /**
   * POST /connectors/:name/install and PATCH /connectors/:name: the mastery fields the request
   * stores for the connector, against the tenant's Recon Config. The primary comes from the
   * Design studio's source nodes, else from the installed HR connectors with this request's
   * Contract Tag and ingest priority for this connector. A connector that is no HR source (a
   * target) may master no contract-critical field.
   */
  async assertConnectorMastery(
    name: string,
    priority: { ingestPriority?: number; contractTag?: string; masteryFields?: string[] },
  ): Promise<void> {
    if (!priority.masteryFields?.length) return;
    const tenantId = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const config = await this.reconConfigService.getConfig(tenantId);
    if (!config || (config.contractCriticalFields ?? []).length === 0) return;
    const tags = config.hrSourceTags ?? [];
    let connectors: HrConnectorRank[] =
      await this.correlationConfigService.getHrConnectorsWithPriorityFromBlueprint(tags);
    if (connectors.length === 0) {
      const installed = await this.installed(config);
      const stored = installed.find((c) => c.name === name);
      connectors = installed.filter((c) => c.name !== name);
      // An installed connector is an HR source when the Recon Config lists its name
      if (tags.includes(name)) {
        connectors.push({
          name,
          ingestPriority: priority.ingestPriority ?? stored?.ingestPriority ?? 999,
          contractTag: priority.contractTag ?? stored?.contractTag,
        });
      }
    }
    const primary = configuredPrimaryHrSource(connectors, tags, config.sourcePriorityOrder ?? []);
    this.assert(
      [sourceMasterySetting({ name, masteryFields: priority.masteryFields })],
      config.contractCriticalFields,
      primary,
    );
  }

  private installed(config: { hrSourceTags?: string[] }): Promise<HrConnectorWithPriority[]> {
    return this.correlationConfigService.getInstalledHrConnectorsWithPriority(
      config.hrSourceTags ?? [],
    );
  }

  private assert(
    settings: MasterySetting[],
    contractCriticalFields: string[],
    primary: string | undefined,
  ): void {
    const problems = contractCriticalMasteryProblems(settings, contractCriticalFields, primary);
    if (problems.length > 0) {
      throw new BadRequestException(contractCriticalMasteryMessage(problems, primary));
    }
  }
}
