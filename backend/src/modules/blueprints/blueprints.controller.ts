import {
  Controller,
  Inject,
  Logger,
  Patch,
  Param,
  Body,
  Get,
  Post,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody, ApiResponse } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { BlueprintsService } from './blueprints.service';
import { ImpactAnalysisService } from './impact-analysis.service';
import { PipelineService } from './pipeline.service';
import { IdentityService } from '../identity/identity.service';
import { EntraService } from '../connectors/entra-connector/entra.service';
import {
  UpdateNodeConfigSchema,
  SaveCanvasSchema,
  ImpactAnalysisBodySchema,
  PipelineConfigSchema,
  DeployBodySchema,
} from './dtos/blueprint-validation';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { CorrelationConfig } from '@shared/types/correlation-config';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { zodIssueMessages } from '@shared/filters/zod-error.filter';
import { type AuthConfig, authConfig } from '@infrastructure/config/auth.config';
import { ConfigDecryptionError } from '@infrastructure/secrets/config-encryption.helper';
import { CanvasLoadError } from './canvas-load.errors';
import { impactTargetSystem } from './impact-delta.util';

/**
 * REST API for Canvas Blueprint persistence, connector health checks, impact analysis, and pipeline lifecycle.
 */
@ApiTags('Blueprints')
@ApiBearerAuth('jwt')
@Controller('blueprints')
export class BlueprintsController {
  private readonly logger = new Logger(BlueprintsController.name);

  constructor(
    private readonly blueprintsService: BlueprintsService,
    private readonly impactAnalysisService: ImpactAnalysisService,
    private readonly pipelineService: PipelineService,
    private readonly identityService: IdentityService,
    private readonly entraService: EntraService,
    @Inject(authConfig.KEY) private readonly authConf: AuthConfig,
  ) {}

  private getTenantId(authUser?: AuthUserType): string {
    const tenantId = authUser?.tenantId ?? this.authConf.DEFAULT_TENANT_ID;
    if (!tenantId) throw new UnauthorizedException('Tenant ID required');
    return tenantId;
  }

  /**
   * Update circuit breaker config (error threshold, min sample size).
   * Declared before PATCH :id: Express matches routes in declaration order, and :id would
   * otherwise answer this path with 400 "Invalid ID format" (src/app-routes.spec.ts).
   */
  @Patch('pipeline-config')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Update circuit breaker config' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async updatePipelineConfig(@Body() body: unknown, @AuthUser() authUser?: AuthUserType) {
    const parsed = PipelineConfigSchema.parse(body);
    const tenantId = this.getTenantId(authUser);
    await this.pipelineService.updateCircuitBreakerConfig(tenantId, parsed);
    return { success: true };
  }

  @Patch(':id')
  @Roles('connector-admin')
  @ApiOperation({ summary: 'Update blueprint node configuration' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  async update(@Param('id', ParseObjectIdPipe) id: string, @Body() data: unknown) {
    const parsed = UpdateNodeConfigSchema.parse(data);
    return this.blueprintsService.toMaskedNode(
      await this.blueprintsService.updateNodeConfig(id, parsed),
    );
  }

  /**
   * [CANVAS PERSISTENCE] Load Latest Canvas Configuration
   *
   * Retrieves the most recent saved canvas state.
   * Returns empty canvas if none exists (no `lastSaved`). Connector secrets come back masked; the
   * Design studio sends the mask back on save, which keeps the stored value. `revision` is the
   * canvas revision to send back with the save (0 when nothing is saved). A canvas that cannot
   * be loaded answers 503 (CanvasLoadError).
   */
  @Get('latest')
  @Roles('viewer')
  @ApiOperation({ summary: 'Load latest canvas configuration' })
  @ApiResponse({
    status: 503,
    description:
      'The saved canvas could not be loaded (for example a stored config this process cannot ' +
      'decrypt: check its encryption keys). Nothing was changed.',
  })
  async getLatestCanvas() {
    try {
      const canvas = await this.blueprintsService.getLatestBlueprintMasked();
      const pipelineConfig = canvas.pipelineConfig ?? {};
      return {
        success: true,
        data: {
          nodes: canvas.nodes,
          edges: canvas.edges,
          viewport: canvas.viewport,
          connectorConfigs: canvas.connectorConfigs,
          pipelineConfig,
        },
        lastSaved: canvas.updatedAt,
        revision: canvas.canvasRevision ?? 0,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to load canvas', message);
      // Never an empty canvas in its place: the studio would show its default layout, and a Save
      // would overwrite the stored canvas with it
      throw new CanvasLoadError(error instanceof ConfigDecryptionError);
    }
  }

  @Get('pipeline-status')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get pipeline status' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getPipelineStatus(@AuthUser() authUser?: AuthUserType) {
    const tenantId = this.getTenantId(authUser);
    const [status, config] = await Promise.all([
      this.pipelineService.getPipelineStatus(tenantId),
      this.pipelineService.getPipelineConfig(tenantId),
    ]);
    return { status, config };
  }

  @Get('health/:nodeId')
  @Roles('viewer')
  @ApiOperation({ summary: 'Check connector health by node ID' })
  async checkHealth(@Param('nodeId') nodeId: string) {
    // Route to the correct activity based on connector type
    const connectorType = this.getConnectorType(nodeId);

    // Fetch the connector's saved configuration
    const config = await this.blueprintsService.getNodeConfig(nodeId);

    let isHealthy = false;
    if (connectorType === 'Microsoft Entra ID') {
      // Pass the connector's config to the health check
      isHealthy = await this.entraService.checkConnection(config?.config);
    }

    return { status: isHealthy ? 'online' : 'offline' };
  }

  @Get(':id')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get blueprint node config by ID (connector secrets masked)' })
  async findOne(@Param('id', ParseObjectIdPipe) id: string) {
    return this.blueprintsService.toMaskedNode(await this.blueprintsService.getNodeConfig(id));
  }

  /**
   * Connector status for the ConnectorManager component (Impact Fleet view): the health check's
   * result and whether the credentials worked. No rate limit or credential expiry: EuroID reads
   * neither from the target.
   */
  @Get('connector-status/:connectorId')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get comprehensive connector status' })
  async getConnectorStatus(@Param('connectorId') connectorId: string) {
    try {
      const connectorType = this.getConnectorType(connectorId);

      // Fetch the connector's saved configuration
      const config = await this.blueprintsService.getNodeConfig(connectorId);

      let isHealthy = false;

      // Route to correct connector based on type
      if (connectorType === 'Microsoft Entra ID') {
        isHealthy = await this.entraService.checkConnection(config?.config);
      }

      // Only what the health check found: EuroID reads no rate limit or credential expiry
      return {
        name: connectorId,
        type: connectorType,
        health: isHealthy ? 'online' : 'offline',
        enabled: true,
        credentials: { valid: isHealthy },
        ...(isHealthy ? {} : { errorMessage: 'Unable to connect to target system' }),
      };
    } catch (error: unknown) {
      const internalMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Connector health check failed for ${connectorId}: ${internalMsg}`);
      return {
        name: connectorId,
        type: 'Unknown',
        health: 'offline',
        enabled: false,
        credentials: { valid: false },
        errorMessage: 'Connection failed',
      };
    }
  }

  /**
   * Get entitlements for a specific connector
   * This fetches groups and licenses using the connector's saved configuration
   */
  @Get('connector-entitlements/:nodeId')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get entitlements for a connector' })
  async getConnectorEntitlements(@Param('nodeId') nodeId: string) {
    try {
      const connectorType = this.getConnectorType(nodeId);

      // Only Entra ID supports entitlements discovery for now
      if (connectorType !== 'Microsoft Entra ID') {
        return {
          success: false,
          error: 'Entitlement discovery not supported for this connector type',
          entitlements: [],
        };
      }

      // Fetch the connector's saved configuration from the blueprint
      const config = await this.blueprintsService.getNodeConfig(nodeId);

      // Call discovery with the connector's config
      const entitlements = await this.entraService.discoverEntitlements(config?.config);

      return {
        success: true,
        entitlements,
        count: entitlements.length,
      };
    } catch (error: unknown) {
      const internalMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to fetch entitlements for ${nodeId}: ${internalMsg}`);
      return {
        success: false,
        error: 'Failed to fetch entitlements',
        entitlements: [],
      };
    }
  }

  /**
   * Impact Analysis Endpoint - The "Pre-Flight Check"
   *
   * This endpoint analyzes what will happen when syncing users to target systems.
   * It returns three datasets:
   * 1. Deltas: CREATE/UPDATE/DELETE operations
   * 2. Entra ID Metadata: UPN validation, the groups and licenses the policy assigns, and what is
   *    not known (if Entra connector is enabled)
   * 3. Warnings: Toxic combinations, conflicts, rate limit issues
   *
   * In Dry Run mode, it simulates without touching live systems.
   */
  @Post('impact-analysis')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Analyze impact of syncing users to target systems' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  async analyzeImpact(@Body() body: unknown, @AuthUser() authUser?: AuthUserType) {
    const parsed = ImpactAnalysisBodySchema.parse(body);
    const { users, connectors, dryRun = true } = parsed;
    const tenantId = this.getTenantId(authUser);

    try {
      const result = await this.impactAnalysisService.computeDeltas(tenantId, {
        users: users as StandardUserDto[] | undefined,
        connectors,
      });

      const apiDeltas = result.deltas.map((d) => this.impactAnalysisService.toApiDelta(d));

      // A connector name standing for Entra ID (an `ad` substring matched "workday" and "adp")
      const hasEntraConnector = (connectors ?? []).some(
        (c) => impactTargetSystem(c) === 'entra-id',
      );

      const hubUsers = users && users.length > 0 ? users : (result.userSample ?? []);
      const entraMetadata = hasEntraConnector
        ? await this.impactAnalysisService.generateEntraMetadata(
            hubUsers,
            dryRun ?? true,
            result.deltas,
          )
        : [];

      // Record simulation for pipeline readiness (enables Deploy when risk is acceptable)
      if (dryRun !== false) {
        this.pipelineService.recordSimulation(tenantId, result.risk.overallRisk).catch((err) => {
          this.logger.error(
            `recordSimulation failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }

      const response: Record<string, unknown> = {
        success: true,
        dryRun: dryRun ?? true,
        deltas: apiDeltas,
        entraMetadata,
        summary: {
          totalUsers: result.summary.totalUsers,
          creates: result.summary.creates,
          updates: result.summary.updates,
          deletes: result.summary.deletes,
          noChange: result.summary.noChange,
          highRisk: result.summary.highRisk,
          warnings: result.summary.warnings,
        },
        risk: result.risk,
      };
      if (result.sodViolationsByUser?.length) {
        response.sodViolationsByUser = result.sodViolationsByUser;
      }
      return response;
    } catch (error: unknown) {
      const internalMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Impact analysis failed: ${internalMsg}`);
      throw new BadRequestException('Impact analysis failed. Check server logs for details.');
    }
  }

  /**
   * [CANVAS PERSISTENCE] Save Canvas Configuration
   *
   * Saves the complete ReactFlow canvas state including nodes, edges,
   * viewport position, and connector configurations.
   */
  @Post('save')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Save canvas configuration' })
  @ApiResponse({
    status: 400,
    description:
      'Bad Request, nothing saved: an invalid canvas (one message per field), or a Field Mastery ' +
      "entry (the Brain's, or an HR source node's mastery fields) that names a secondary HR " +
      'source or a target for a contract-critical field (Recon Config); contract-critical ' +
      'fields always come from the primary HR contract, chosen through Contract Tag and priority. ' +
      'A Hashed National ID correlation rule is refused while the server has no ' +
      'CORRELATION_HMAC_SECRET (at least 16 characters).',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({
    status: 409,
    description:
      "Conflict, nothing saved: the body's `revision` is no longer the stored one (someone saved " +
      'the canvas after it was loaded). Reload GET /blueprints/latest and save again.',
  })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  async saveCanvas(@Body() body: unknown) {
    const parsed = SaveCanvasSchema.safeParse(body);
    if (!parsed.success) {
      // One line per problem, naming the field (e.g. connectorConfigs.euroid-core.correlationConfig.rules.0.strategy).
      throw new BadRequestException(zodIssueMessages(parsed.error));
    }
    const canvasData = parsed.data;
    await this.identityService.assertCanvasMastery(canvasData);
    const previousCorrelation = await this.storedCorrelationSettings();
    try {
      const saved = await this.blueprintsService.saveBlueprint(canvasData);
      this.startNationalIdCleanup(previousCorrelation, canvasData.connectorConfigs);
      return {
        success: true,
        message: 'Canvas saved successfully',
        timestamp: saved.updatedAt,
        revision: saved.canvasRevision,
        nodeCount: canvasData.nodes.length,
        edgeCount: canvasData.edges.length,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to save canvas', message);
      throw error;
    }
  }

  /** The Brain's correlation settings as stored before a save (none when they cannot be read). */
  private async storedCorrelationSettings(): Promise<CorrelationConfig | undefined> {
    try {
      const canvas = await this.blueprintsService.getLatestBlueprint();
      return brainCorrelationSettings(canvas?.connectorConfigs);
    } catch {
      return undefined;
    }
  }

  /**
   * In the background, after a save: values stored under a national ID field the saved rule names
   * anew are removed from the tenant's identities (IdentityService.cleanStoredNationalIds). It
   * may take a while on a large tenant; a failure is logged and never fails the save, and saving
   * again runs it again.
   */
  private startNationalIdCleanup(
    previous: CorrelationConfig | undefined,
    connectorConfigs: Record<string, unknown> | undefined,
  ): void {
    const tenantId = getRequestContext()?.tenantId || 'default';
    const saved = brainCorrelationSettings(connectorConfigs);
    void Promise.resolve()
      .then(() => this.identityService.cleanStoredNationalIds(tenantId, previous, saved))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Stored national ID cleanup failed for tenant ${tenantId}: ${message}`);
      });
  }

  /**
   * Pre-deploy readiness check. Returns pass/fail/warn for each condition.
   */
  @Post('readiness-check')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Run pre-deploy readiness check' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async readinessCheck(@AuthUser() authUser?: AuthUserType) {
    const tenantId = this.getTenantId(authUser);
    return this.pipelineService.runReadinessCheck(tenantId);
  }

  /**
   * Deploy the pipeline. Runs readiness check first; returns 422 if not ready, and when a check
   * needs the deployer's confirmation (a critical-risk impact analysis) without
   * `acknowledgeCriticalRisk: true` in the body.
   */
  @Post('deploy')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Deploy pipeline to production' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        acknowledgeCriticalRisk: {
          type: 'boolean',
          description: 'Confirms a critical-risk impact analysis; Deploy needs it then',
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 422,
    description: 'Readiness check failed, or a critical-risk impact analysis is not confirmed',
  })
  async deploy(@Body() body: unknown, @AuthUser() authUser?: AuthUserType) {
    const { acknowledgeCriticalRisk } = DeployBodySchema.parse(body ?? {});
    const tenantId = this.getTenantId(authUser);
    const deployedBy = authUser?.email ?? authUser?.sub ?? 'admin';
    return this.pipelineService.deploy(
      tenantId,
      deployedBy,
      acknowledgeCriticalRisk ? { acknowledgeCriticalRisk } : {},
    );
  }

  /**
   * Pause the pipeline (manual or circuit breaker).
   */
  @Post('pause')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Pause pipeline' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async pause(@AuthUser() authUser?: AuthUserType) {
    const tenantId = this.getTenantId(authUser);
    return this.pipelineService.pause(tenantId, 'manual');
  }

  /**
   * Resume the pipeline from paused state.
   */
  @Post('resume')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Resume pipeline' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async resume(@AuthUser() authUser?: AuthUserType) {
    const tenantId = this.getTenantId(authUser);
    return this.pipelineService.resume(tenantId);
  }

  /**
   * Stop the pipeline permanently.
   */
  @Post('stop')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Stop pipeline' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async stop(@AuthUser() authUser?: AuthUserType) {
    const tenantId = this.getTenantId(authUser);
    return this.pipelineService.stop(tenantId);
  }

  /**
   * Helper to determine connector type from ID
   */
  private getConnectorType(connectorId: string): string {
    if (connectorId.toLowerCase().includes('entra') || connectorId.toLowerCase().includes('azure'))
      return 'Microsoft Entra ID';
    if (connectorId.toLowerCase().includes('salesforce')) return 'Salesforce';
    if (connectorId.toLowerCase().includes('slack')) return 'Slack';
    return 'Unknown';
  }
}

/** The Brain's correlation settings in a canvas's connectorConfigs (`euroid-core`). */
function brainCorrelationSettings(
  connectorConfigs: Record<string, unknown> | undefined,
): CorrelationConfig | undefined {
  const brain = connectorConfigs?.['euroid-core'] as
    | { correlationConfig?: CorrelationConfig }
    | undefined;
  return brain?.correlationConfig;
}
