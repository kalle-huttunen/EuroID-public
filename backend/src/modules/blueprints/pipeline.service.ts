/**
 * Pipeline Service
 *
 * Manages blueprint lifecycle: readiness check, deploy, pause, resume.
 * Validates pre-deploy conditions and transitions pipeline status.
 */
import {
  Injectable,
  BadRequestException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CanvasBlueprint, PipelineStatus, PipelineConfigEmbed } from './schemas/blueprint.schema';
import { ProvisioningMetrics } from './schemas/provisioning-metrics.schema';
import { BlueprintsService } from './blueprints.service';
import { PolicyService } from '../policy/policy.service';
import { ImpactAnalysisService } from './impact-analysis.service';
import { EntraActivities } from '../../activities/entra.activities';
import { AdActivities } from '../../activities/ad.activities';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { CorrelationConfigRegistry } from '../correlation-config/correlation-config.registry';

/**
 * Minimal shape for ReactFlow canvas nodes used in readiness checks. The Design studio saves a
 * label as `{ text, icon }`; canvases saved before that hold the React element as JSON made it.
 */
interface CanvasNode {
  id: string;
  data?: {
    role?: string;
    type?: string;
    label?: string | { text?: string; props?: { children?: unknown } };
  };
}

/** The name a node shows on the canvas, or its id when the label has no text. */
function nodeName(node: CanvasNode): string {
  const label = node.data?.label;
  if (typeof label === 'string') return label;
  if (typeof label?.text === 'string') return label.text;
  const children = label?.props?.children;
  const text = (Array.isArray(children) ? children : [children])
    .filter((child): child is string => typeof child === 'string')
    .join('')
    .trim();
  return text || node.id;
}

export interface ReadinessCheckItem {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  /**
   * The check passes only with the deployer's confirmation (POST /blueprints/deploy
   * `acknowledgeCriticalRisk: true`): a critical-risk impact analysis.
   */
  acknowledgementRequired?: boolean;
}

export interface ReadinessCheckResult {
  ready: boolean;
  checks: ReadinessCheckItem[];
}

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    @InjectModel(CanvasBlueprint.name)
    private readonly canvasModel: Model<CanvasBlueprint>,
    private readonly blueprintsService: BlueprintsService,
    private readonly policyService: PolicyService,
    private readonly impactAnalysisService: ImpactAnalysisService,
    private readonly entraActivities: EntraActivities,
    private readonly adActivities: AdActivities,
    private readonly eventEmitter: DomainEventEmitterService,
    // The installed connector configs, through the registry: importing ConnectorConfigModule here
    // would be a module cycle (it imports BlueprintsModule)
    private readonly registry: CorrelationConfigRegistry,
    // The circuit breaker's window (CircuitBreakerService): reset on resume
    @InjectModel(ProvisioningMetrics.name)
    private readonly metricsModel: Model<ProvisioningMetrics>,
  ) {}

  /**
   * Run pre-deploy readiness check. Returns pass/fail/warn for each condition.
   */
  async runReadinessCheck(tenantId: string): Promise<ReadinessCheckResult> {
    const checks: ReadinessCheckItem[] = [];
    const blueprint = await this.blueprintsService.getLatestBlueprint(tenantId);
    // Not the cached blueprint's copy: the impact analysis that Deploy requires was recorded
    // moments ago, straight into the stored canvas.
    const pipelineConfig = await this.storedPipelineConfig(tenantId);
    const nodes = blueprint.nodes ?? [];

    const sourceNodes = (nodes as CanvasNode[]).filter((n) => n.data?.role === 'source');
    const targetNodes = (nodes as CanvasNode[]).filter((n) => n.data?.role === 'target');

    // Required: At least one HR source connector configured and healthy
    const hrHealthy = await this.checkSourceConnectorsHealthy(blueprint, sourceNodes);
    if (sourceNodes.length === 0) {
      checks.push({
        name: 'HR Source',
        status: 'fail',
        message: 'No HR source connector configured',
      });
    } else if (!hrHealthy) {
      checks.push({
        name: 'HR Source',
        status: 'fail',
        message: 'HR source connector(s) not healthy',
      });
    } else {
      checks.push({
        name: 'HR Source',
        status: 'pass',
        message: `HR source connected (${sourceNodes.map(nodeName).join(', ')})`,
      });
    }

    // Required: At least one target connector configured and healthy
    const targetHealthy = await this.checkTargetConnectorsHealthy(blueprint, targetNodes);
    if (targetNodes.length === 0) {
      checks.push({
        name: 'Target Connectors',
        status: 'fail',
        message: 'No target connector configured',
      });
    } else if (!targetHealthy.allHealthy) {
      checks.push({ name: 'Target Connectors', status: 'fail', message: targetHealthy.message });
    } else {
      checks.push({ name: 'Target Connectors', status: 'pass', message: targetHealthy.message });
    }

    // Required: At least one active policy
    const activePolicies = await this.policyService.findActive();
    if (activePolicies.length === 0) {
      checks.push({
        name: 'Active Policies',
        status: 'fail',
        message: 'No active policies configured',
      });
    } else {
      checks.push({
        name: 'Active Policies',
        status: 'pass',
        message: `${activePolicies.length} active policies configured`,
      });
    }

    // Required: an impact analysis of the canvas as saved (saveBlueprint stamps canvasSavedAt)
    const lastSimulationAt = pipelineConfig.lastSimulationAt;
    const canvasSavedAt = pipelineConfig.canvasSavedAt;
    if (!lastSimulationAt) {
      checks.push({
        name: 'Impact Analysis',
        status: 'fail',
        message: 'Impact analysis has not been run',
      });
    } else if (
      canvasSavedAt &&
      new Date(canvasSavedAt).getTime() > new Date(lastSimulationAt).getTime()
    ) {
      checks.push({
        name: 'Impact Analysis',
        status: 'fail',
        message: 'The canvas was saved after the last impact analysis: run it again',
      });
    } else {
      const risk = pipelineConfig.lastSimulationRisk ?? 'low';
      if (risk === 'critical') {
        checks.push({
          name: 'Impact Analysis',
          status: 'warn',
          message: 'Impact analysis reviewed (critical risk): confirm it to deploy',
          acknowledgementRequired: true,
        });
      } else if (risk === 'high') {
        checks.push({
          name: 'Impact Analysis',
          status: 'warn',
          message: `Impact analysis reviewed (${risk} risk)`,
        });
      } else {
        checks.push({
          name: 'Impact Analysis',
          status: 'pass',
          message: `Impact analysis reviewed (${risk} risk)`,
        });
      }
    }

    // Warning: no HR source syncs on a schedule
    checks.push(await this.scheduledSyncCheck(sourceNodes));

    const requiredFail = checks.filter((c) => c.status === 'fail').length;
    const ready = requiredFail === 0;

    return { ready, checks };
  }

  /**
   * SyncSchedulerService (hourly cron) syncs an installed connector whose saved syncIntervalHours
   * is above 0, the Sync Interval of the Marketplace and of the source's drawer. Passes when a
   * source of the canvas has one, naming each source's schedule; warns when none has.
   */
  private async scheduledSyncCheck(sourceNodes: CanvasNode[]): Promise<ReadinessCheckItem> {
    const installed = this.registry.getConnectorProvider();
    const schedules: string[] = [];
    let scheduled = 0;
    for (const node of sourceNodes) {
      const type = node.data?.type;
      const saved =
        installed && typeof type === 'string'
          ? await installed.getConfig(type).catch((error: unknown) => {
              // The scheduler cannot read it either: counted as manual only
              this.logger.warn(`Scheduled Sync check: the ${type} config cannot be read: ${error}`);
              return null;
            })
          : null;
      const hours = parseInt(String(saved?.config?.syncIntervalHours ?? '0'), 10) || 0;
      if (hours > 0) scheduled += 1;
      schedules.push(`${nodeName(node)}: ${hours > 0 ? `every ${hours} h` : 'manual only'}`);
    }
    return scheduled > 0
      ? { name: 'Scheduled Sync', status: 'pass', message: schedules.join(', ') }
      : {
          name: 'Scheduled Sync',
          status: 'warn',
          message: 'No scheduled sync (manual only): set a Sync Interval on an HR source',
        };
  }

  private async checkSourceConnectorsHealthy(
    _blueprint: CanvasBlueprint,
    sourceNodes: CanvasNode[],
  ): Promise<boolean> {
    if (sourceNodes.length === 0) return false;
    for (const node of sourceNodes) {
      const nodeId = node.id;
      const config = await this.blueprintsService.getNodeConfig(nodeId);
      if (!config?.config) return false;
    }
    return true;
  }

  private async checkTargetConnectorsHealthy(
    blueprint: CanvasBlueprint,
    targetNodes: CanvasNode[],
  ): Promise<{ allHealthy: boolean; message: string }> {
    if (targetNodes.length === 0) return { allHealthy: false, message: 'No target connectors' };
    const results: string[] = [];
    let allHealthy = true;
    for (const node of targetNodes) {
      const nodeId = node.id;
      const type = (node.data?.type ?? nodeId ?? '').toLowerCase();
      let healthy = false;
      try {
        if (type.includes('entra')) {
          const config = await this.blueprintsService.getNodeConfig(nodeId);
          healthy = await this.entraActivities.checkEntraHealth(
            config?.config,
            blueprint.tenantId ?? 'default',
          );
        } else if (type.includes('ad') || type === 'active-directory') {
          const config = await this.blueprintsService.getNodeConfig(nodeId);
          healthy = await this.adActivities.checkAdHealth(
            config?.config,
            blueprint.tenantId ?? 'default',
          );
        } else {
          healthy = true;
        }
      } catch {
        healthy = false;
      }
      results.push(`${nodeName(node)}: ${healthy ? 'healthy' : 'offline'}`);
      if (!healthy) allHealthy = false;
    }
    return { allHealthy, message: results.join(', ') };
  }

  /**
   * Deploy the pipeline. Runs readiness check first; blocks if not ready with HTTP 422, the
   * readiness result in the body (the Deploy modal shows its checks). A check that needs the
   * deployer's confirmation (a critical-risk impact analysis) blocks the same way unless
   * `acknowledgeCriticalRisk` is set; pipeline.deployed then carries `acknowledgedRisk`.
   */
  async deploy(
    tenantId: string,
    deployedBy: string,
    options: { acknowledgeCriticalRisk?: boolean } = {},
  ): Promise<{ status: PipelineStatus; deployedAt: Date }> {
    const readiness = await this.runReadinessCheck(tenantId);
    if (!readiness.ready) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        message: 'Readiness check failed',
        readiness,
      });
    }
    const needsConfirmation = readiness.checks.some((c) => c.acknowledgementRequired);
    if (needsConfirmation && options.acknowledgeCriticalRisk !== true) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        message: 'Deploying with a critical-risk impact analysis needs its confirmation',
        readiness,
      });
    }

    const canvas = await this.canvasModel.findOne({ version: 'draft', tenantId }).exec();
    if (!canvas) {
      throw new BadRequestException('No blueprint canvas found');
    }

    const pipelineConfig = canvas.pipelineConfig ?? {};
    const currentStatus = pipelineConfig.status ?? PipelineStatus.DRAFT;

    if (currentStatus === PipelineStatus.DEPLOYED) {
      return {
        status: PipelineStatus.DEPLOYED,
        deployedAt: pipelineConfig.deployedAt ?? new Date(),
      };
    }

    if (currentStatus === PipelineStatus.STOPPED) {
      throw new BadRequestException(
        'Pipeline is stopped. Re-run impact analysis and deploy again.',
      );
    }

    const now = new Date();
    await this.canvasModel.updateOne(
      { _id: canvas._id },
      {
        $set: {
          'pipelineConfig.status': PipelineStatus.DEPLOYED,
          'pipelineConfig.deployedAt': now,
          'pipelineConfig.deployedBy': deployedBy,
          'pipelineConfig.pausedAt': null,
          'pipelineConfig.pauseReason': null,
        },
      },
    );

    this.eventEmitter.emit(
      DomainEventType.PIPELINE_DEPLOYED,
      tenantId,
      {
        tenantId,
        deployedBy,
        deployedAt: now.toISOString(),
        ...(needsConfirmation ? { acknowledgedRisk: 'critical' } : {}),
      },
      { tenantId },
    );

    this.logger.log(`Pipeline deployed for tenant ${tenantId} by ${deployedBy}`);
    return { status: PipelineStatus.DEPLOYED, deployedAt: now };
  }

  /**
   * Pause the pipeline.
   */
  async pause(
    tenantId: string,
    reason: 'manual' | 'circuit_breaker' | 'health_failure' = 'manual',
  ): Promise<{ status: PipelineStatus }> {
    const canvas = await this.canvasModel.findOne({ version: 'draft', tenantId }).exec();
    if (!canvas) throw new BadRequestException('No blueprint canvas found');

    const now = new Date();
    await this.canvasModel.updateOne(
      { _id: canvas._id },
      {
        $set: {
          'pipelineConfig.status': PipelineStatus.PAUSED,
          'pipelineConfig.pausedAt': now,
          'pipelineConfig.pauseReason': reason,
        },
      },
    );

    this.logger.log(`Pipeline paused for tenant ${tenantId} (reason: ${reason})`);
    return { status: PipelineStatus.PAUSED };
  }

  /**
   * Resume the pipeline from PAUSED. The circuit breaker's metrics window starts afresh: kept,
   * the next outcome recomputed the error rate that tripped it and paused the pipeline again
   * until the hour rolled over.
   */
  async resume(tenantId: string): Promise<{ status: PipelineStatus }> {
    const canvas = await this.canvasModel.findOne({ version: 'draft', tenantId }).exec();
    if (!canvas) throw new BadRequestException('No blueprint canvas found');

    const pipelineConfig = canvas.pipelineConfig ?? {};
    if (pipelineConfig.status !== PipelineStatus.PAUSED) {
      throw new BadRequestException(`Pipeline is not paused (current: ${pipelineConfig.status})`);
    }

    await this.canvasModel.updateOne(
      { _id: canvas._id },
      {
        $set: {
          'pipelineConfig.status': PipelineStatus.DEPLOYED,
          'pipelineConfig.pausedAt': null,
          'pipelineConfig.pauseReason': null,
        },
      },
    );

    await this.metricsModel.deleteOne({ tenantId }).exec();

    this.logger.log(`Pipeline resumed for tenant ${tenantId}`);
    return { status: PipelineStatus.DEPLOYED };
  }

  /**
   * Stop the pipeline permanently.
   */
  async stop(tenantId: string): Promise<{ status: PipelineStatus }> {
    const canvas = await this.canvasModel.findOne({ version: 'draft', tenantId }).exec();
    if (!canvas) throw new BadRequestException('No blueprint canvas found');

    await this.canvasModel.updateOne(
      { _id: canvas._id },
      { $set: { 'pipelineConfig.status': PipelineStatus.STOPPED } },
    );

    this.logger.log(`Pipeline stopped for tenant ${tenantId}`);
    return { status: PipelineStatus.STOPPED };
  }

  /**
   * The tenant's pipeline config, read from the stored canvas: not through the 5 s blueprint
   * cache, which recordSimulation, deploy, pause, resume and stop do not clear (and which every
   * API replica and the worker hold separately). A reader right after one of them (the Deploy
   * readiness check, HR joiners, the onboarding workflow's pause guard) sees what was written.
   */
  private async storedPipelineConfig(tenantId: string): Promise<Partial<PipelineConfigEmbed>> {
    const canvas = await this.canvasModel
      .findOne({ version: 'draft', tenantId })
      .select('pipelineConfig')
      .lean()
      .exec();
    return (canvas?.pipelineConfig as Partial<PipelineConfigEmbed> | undefined) ?? {};
  }

  /** Current pipeline status for a tenant (stored canvas, see storedPipelineConfig). */
  async getPipelineStatus(tenantId: string): Promise<PipelineStatus> {
    const { status } = await this.storedPipelineConfig(tenantId);
    return (status as PipelineStatus | undefined) ?? PipelineStatus.DRAFT;
  }

  /** Full pipeline config for a tenant (stored canvas, see storedPipelineConfig). */
  async getPipelineConfig(tenantId: string): Promise<Partial<PipelineConfigEmbed>> {
    return this.storedPipelineConfig(tenantId);
  }

  /**
   * Record that impact analysis was run (called after a successful dry-run simulation): when and
   * its risk, always. The status becomes SIMULATED only from DRAFT, SIMULATED or STOPPED (STOPPED
   * to SIMULATED is the way back to Deploy, see deploy()). A DEPLOYED or PAUSED pipeline keeps its
   * status, so a simulation neither stops joiners and the circuit breaker on a live pipeline nor
   * lifts a pause. The status condition is in the update filter, so a pause written meanwhile is
   * not overwritten.
   */
  async recordSimulation(
    tenantId: string,
    risk: 'low' | 'medium' | 'high' | 'critical',
  ): Promise<void> {
    const canvas = await this.canvasModel.findOne({ version: 'draft', tenantId }).exec();
    if (!canvas) return;

    await this.canvasModel.updateOne(
      { _id: canvas._id },
      {
        $set: {
          'pipelineConfig.lastSimulationAt': new Date(),
          'pipelineConfig.lastSimulationRisk': risk,
        },
      },
    );
    await this.canvasModel.updateOne(
      {
        _id: canvas._id,
        'pipelineConfig.status': { $nin: [PipelineStatus.DEPLOYED, PipelineStatus.PAUSED] },
      },
      { $set: { 'pipelineConfig.status': PipelineStatus.SIMULATED } },
    );
  }

  /**
   * Update error threshold and min sample size.
   */
  async updateCircuitBreakerConfig(
    tenantId: string,
    config: { errorThresholdPercent?: number; minSampleSizeForCircuitBreaker?: number },
  ): Promise<void> {
    const canvas = await this.canvasModel.findOne({ version: 'draft', tenantId }).exec();
    if (!canvas) throw new BadRequestException('No blueprint canvas found');

    const updates: Record<string, number> = {};
    if (config.errorThresholdPercent != null)
      updates['pipelineConfig.errorThresholdPercent'] = config.errorThresholdPercent;
    if (config.minSampleSizeForCircuitBreaker != null)
      updates['pipelineConfig.minSampleSizeForCircuitBreaker'] =
        config.minSampleSizeForCircuitBreaker;
    if (Object.keys(updates).length === 0) return;

    await this.canvasModel.updateOne({ _id: canvas._id }, { $set: updates });
  }
}
