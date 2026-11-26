/**
 * Reconciliation Controller
 *
 * REST API endpoints for reconciliation and distributed transactions.
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpException,
  HttpStatus,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
  ApiResponse,
} from '@nestjs/swagger';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { ReconciliationService } from './reconciliation.service';
import { DriftService, DriftFilter } from './drift.service';
import { OrphanCleanupService } from './orphan-cleanup.service';
import { orphanDeleteRefusal } from '@shared/utils/orphan-delete-policy';
import {
  ReconciliationConfig,
  DistributedTransactionRequest,
  DriftType,
} from '@shared/dtos/distributed-transaction.dto';
import { TriggerReconciliationDto } from './dtos/trigger-reconciliation.dto';
import { BulkDriftActionDto } from './dtos/bulk-drift-action.dto';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import type {
  DriftSeverity,
  DriftType as DriftSchemaType,
  DriftStatus,
} from './schemas/drift.schema';
import { z, ZodError } from 'zod';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { validatePageLimit } from '@shared/utils/pagination-validator';
import { ConnectorHealthService } from '../connectors/connector-health.service';
import { isExcludedUserEntry } from '@shared/utils/reconciliation-scope';

// ── Zod input schemas for @Body() validation ──

/** EuroID has no Slack sender: a notifySlack in the body is refused with this message (400). */
const SLACK_UNAVAILABLE =
  'Slack delivery is not available: subscribe a webhook to ' +
  'reconciliation.drift_threshold_exceeded instead (Admin > Webhooks)';

/**
 * A run starts on request (this route, the dashboard's button); nothing schedules one. A
 * cronSchedule or enabled: false in the body is refused with this message (400) rather than
 * taken for a schedule.
 */
const SCHEDULE_UNAVAILABLE =
  'Reconciliation runs start on request: scheduled reconciliation is not available, ' +
  'so leave out cronSchedule and enabled: false';

// No tenantId in request bodies: ReconciliationService takes the tenant from the request context.
// What each setting does: docs/ARCHITECTURE.md, Run Settings.
const ReconciliationConfigSchema = z.object({
  enabled: z
    .boolean()
    .optional()
    .refine((value) => value !== false, { message: SCHEDULE_UNAVAILABLE }),
  cronSchedule: z.unknown().refine((value) => value === undefined, {
    message: SCHEDULE_UNAVAILABLE,
  }),
  targetSystems: z.array(z.string().min(1).max(200)).min(1).max(50),
  // The scan scope (shared/utils/reconciliation-scope.ts): exact department, ignoring case
  includedDepartments: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  excludedUsers: z
    .array(
      z.string().trim().max(200).refine(isExcludedUserEntry, {
        message: 'An excludedUsers entry is an identity id (24 hex characters) or an email address',
      }),
    )
    .max(1000)
    .optional(),
  autoCorrect: z.boolean(),
  autoCorrectTypes: z.array(z.nativeEnum(DriftType)).max(20),
  requireApprovalForDeletes: z.boolean(),
  notifyOnDrift: z.boolean(),
  notifyEmail: z.string().email().max(320).optional(),
  notifySlack: z.unknown().refine((value) => value === undefined, { message: SLACK_UNAVAILABLE }),
  maxDriftsBeforeAlert: z.number().int().min(0).max(10000),
  criticalDriftAlertThreshold: z.number().int().min(0).max(10000),
});

const DistributedTransactionRequestSchema = z.object({
  transactionId: z.string().min(1).max(200),
  user: z
    .object({
      sourceSystem: z.string().min(1),
      sourceUserId: z.string().min(1),
      firstName: z.string().min(1).max(200),
      lastName: z.string().min(1).max(200),
      email: z.string().email().max(320),
      status: z.nativeEnum(UserStatus),
    })
    .passthrough(),
  targetSystems: z.array(z.string().min(1).max(200)).min(1).max(50),
  operation: z.enum(['CREATE', 'UPDATE', 'DELETE']),
  timeout: z.number().int().positive().max(600000).optional(),
  autoRollback: z.boolean().optional(),
  // No initiatedBy: the actor is the authenticated user; a body value is dropped.
  notes: z.string().max(2000).optional(),
});

// ── Zod schema for drift query params ──

const DriftQuerySchema = z.object({
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  type: z
    .enum([
      'MISSING_USER',
      'ORPHANED_USER',
      'ORPHAN_ACCOUNT',
      'FIELD_MISMATCH',
      'STATUS_MISMATCH',
      'GROUP_MISMATCH',
      'LICENSE_MISMATCH',
    ])
    .optional(),
  targetSystem: z.string().max(200).optional(),
  status: z.enum(['open', 'corrected', 'ignored', 'quarantined']).optional(),
  // The drift's userId: the identity's _id (an orphan drift's is the target account id).
  userId: z.string().min(1).max(200).optional(),
  search: z.string().max(500).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Identity _ids, comma-separated: one identity hub page (at most 100 rows)
const OpenDriftCountsQuerySchema = z.object({
  userIds: z
    .string()
    .transform((ids) => [
      ...new Set(
        ids
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(z.string().max(200)).min(1).max(100)),
});

const OrphanSignalSchema = z.object({
  action: z.enum(['ADOPT', 'DELETE']),
  identityId: z.string().min(1).max(200).optional(),
});

@ApiTags('Reconciliation')
@ApiBearerAuth('jwt')
@Controller('reconciliation')
export class ReconciliationController {
  private readonly logger = new Logger(ReconciliationController.name);

  constructor(
    private readonly reconciliationService: ReconciliationService,
    private readonly driftService: DriftService,
    private readonly orphanCleanup: OrphanCleanupService,
    private readonly connectorHealth: ConnectorHealthService,
  ) {}

  /**
   * Start daily reconciliation
   */
  @Post('start-daily')
  @Roles('operator')
  async startDailyReconciliation(@Body() body: unknown) {
    try {
      const config = ReconciliationConfigSchema.parse(body) as ReconciliationConfig;
      const workflowId = await this.reconciliationService.startDailyReconciliation(config);

      return {
        success: true,
        message: 'Daily reconciliation started',
        workflowId,
        tenantId: getRequestContext()?.tenantId,
        targetSystems: config.targetSystems,
      };
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        throw new HttpException(
          { message: 'Validation failed', errors: error.errors },
          HttpStatus.BAD_REQUEST,
        );
      }
      // One run per tenant (workflow id t-<tenant>-daily-recon): the open one must end first
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        throw new HttpException(
          'A daily reconciliation of this tenant is already running: wait for it to finish',
          HttpStatus.CONFLICT,
        );
      }
      const stack = error instanceof Error ? error.stack : String(error);
      this.logger.error('Failed to start daily reconciliation', stack);
      throw new HttpException('Operation failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Start user-specific reconciliation. `userId` is the identity's _id: it goes into the workflow
   * id, which Temporal stores in clear (no payload codec), so an email is refused with 400.
   */
  @Post('user/:userId')
  @Roles('operator')
  @ApiParam({
    name: 'userId',
    description: "The identity's _id (24 hex characters); anything else, an email too, is 400",
  })
  async startUserReconciliation(
    @Param('userId', ParseObjectIdPipe) userId: string,
    @Body() body: TriggerReconciliationDto,
  ) {
    try {
      const workflowId = await this.reconciliationService.startUserReconciliation(
        userId,
        body.targetSystems,
      );

      return {
        success: true,
        message: 'User reconciliation started',
        workflowId,
        userId,
      };
    } catch (error: unknown) {
      const stack = error instanceof Error ? error.stack : String(error);
      this.logger.error('Failed to start user reconciliation', stack);
      throw new HttpException('Operation failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Start distributed transaction
   */
  @Post('distributed-transaction')
  @Roles('operator')
  async startDistributedTransaction(@Body() body: unknown, @AuthUser() actor?: AuthUserType) {
    try {
      const parsed = DistributedTransactionRequestSchema.parse(body);
      // The user belongs to the caller's tenant; the service scopes the request the same way.
      // The recorded actor (workflow memo, transaction log) is the authenticated caller.
      const request = {
        ...parsed,
        initiatedBy: actor?.email || actor?.sub || 'unknown',
        user: { ...parsed.user, tenantId: getCurrentTenantId() },
      } as DistributedTransactionRequest;
      const workflowId = await this.reconciliationService.startDistributedTransaction(request);

      return {
        success: true,
        message: 'Distributed transaction started',
        workflowId,
        transactionId: request.transactionId,
        targetSystems: request.targetSystems,
      };
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        throw new HttpException(
          { message: 'Validation failed', errors: error.errors },
          HttpStatus.BAD_REQUEST,
        );
      }
      const stack = error instanceof Error ? error.stack : String(error);
      this.logger.error('Failed to start distributed transaction', stack);
      throw new HttpException('Operation failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Get workflow status
   */
  @Get('status/:workflowId')
  @Roles('viewer')
  async getStatus(@Param('workflowId') workflowId: string) {
    try {
      const status = await this.reconciliationService.getWorkflowStatus(workflowId);
      return {
        success: true,
        ...status,
      };
    } catch (error: unknown) {
      const stack = error instanceof Error ? error.stack : String(error);
      this.logger.error('Failed to get workflow status', stack);
      throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    }
  }

  /**
   * Get workflow result
   */
  @Get('result/:workflowId')
  @Roles('viewer')
  async getResult(@Param('workflowId') workflowId: string) {
    try {
      const result = await this.reconciliationService.getWorkflowResult(workflowId);
      return {
        success: true,
        result,
      };
    } catch (error: unknown) {
      const stack = error instanceof Error ? error.stack : String(error);
      this.logger.error('Failed to get workflow result', stack);
      throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    }
  }

  // ========== Drift CRUD Endpoints ==========

  @Get('drifts')
  @Roles('viewer')
  @ApiOperation({ summary: 'List drift records with optional filters and pagination' })
  @ApiQuery({ name: 'severity', required: false })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'targetSystem', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search in userDisplayName or userEmail',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (1-based)' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default 50, at most 100)',
  })
  @ApiQuery({
    name: 'userId',
    required: false,
    description:
      "One identity's drifts: the identity's _id (an orphan drift's userId is the target account id)",
  })
  async getDrifts(
    @Query('severity') severity?: string,
    @Query('type') type?: string,
    @Query('targetSystem') targetSystem?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('userId') userId?: string,
  ) {
    const parsed = DriftQuerySchema.parse({
      severity,
      type,
      targetSystem,
      status,
      userId,
      search,
      page,
      limit,
    });

    const filter: DriftFilter = {};
    if (parsed.severity) filter.severity = parsed.severity as DriftSeverity;
    if (parsed.type) filter.type = parsed.type as DriftSchemaType;
    if (parsed.targetSystem) filter.targetSystem = parsed.targetSystem;
    if (parsed.status) filter.status = parsed.status as DriftStatus;
    if (parsed.userId) filter.userId = parsed.userId;
    if (parsed.search) filter.search = parsed.search;

    validatePageLimit(parsed.page, parsed.limit);
    const result = await this.driftService.getDrifts(filter, parsed.page, parsed.limit);
    return { success: true, ...result };
  }

  @Get('drifts/stats')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get drift summary statistics' })
  async getDriftStats() {
    return this.driftService.getStats();
  }

  @Get('drifts/open-counts')
  @Roles('viewer')
  @ApiOperation({
    summary: 'Open drifts per identity',
    description:
      'Answers { success, counts: { <identity _id>: <open drifts> } } for the identities in ' +
      'userIds; an identity without an open drift is not in counts. The identity hub reads its ' +
      'drift column from this, one request per page.',
  })
  @ApiQuery({
    name: 'userIds',
    required: true,
    description: 'Identity _ids, comma-separated, at most 100',
  })
  async getOpenDriftCounts(@Query('userIds') userIds?: string) {
    const parsed = OpenDriftCountsQuerySchema.parse({ userIds });
    return { success: true, counts: await this.driftService.countOpenByUser(parsed.userIds) };
  }

  @Post('drifts/:id/correct')
  @Roles('operator')
  @ApiOperation({
    summary: 'Auto-correct a single drift',
    description:
      'An open drift, or a quarantined orphan drift (its cleanup is stopped first), is corrected ' +
      'in the target and becomes corrected. A corrected or ignored drift answers 409 and stays ' +
      'as it is; nothing is written to the target.',
  })
  async correctDrift(@Param('id', ParseObjectIdPipe) id: string) {
    const drift = await this.driftService.autoCorrect(id);
    return { success: true, drift };
  }

  @Post('drifts/:id/ignore')
  @Roles('operator')
  @ApiOperation({
    summary: 'Ignore a single drift',
    description:
      'An open drift, or a quarantined orphan drift (its cleanup is stopped first), becomes ' +
      'ignored. A corrected or ignored drift answers 409 and stays as it is.',
  })
  async ignoreDrift(@Param('id', ParseObjectIdPipe) id: string) {
    const drift = await this.driftService.ignoreDrift(id);
    return { success: true, drift };
  }

  @Post('drifts/bulk-correct')
  @Roles('operator')
  @ApiOperation({
    summary: 'Bulk auto-correct multiple drifts',
    description:
      'Answers { success, corrected, failed, failures: [{ driftId, error }] }: how many drifts ' +
      'were corrected, and each one that was not with the reason (not found, not open, or the ' +
      'reason single correct answers with 400). success is false when none was corrected.',
  })
  async bulkCorrect(@Body() body: BulkDriftActionDto) {
    const { corrected, failed } = await this.driftService.bulkAutoCorrect(body.driftIds);
    return {
      success: corrected > 0 || failed.length === 0,
      corrected,
      failed: failed.length,
      failures: failed,
    };
  }

  @Post('drifts/bulk-ignore')
  @Roles('operator')
  @ApiOperation({ summary: 'Bulk ignore multiple drifts' })
  async bulkIgnore(@Body() body: BulkDriftActionDto) {
    const count = await this.driftService.bulkIgnore(body.driftIds);
    return { success: true, ignored: count };
  }

  // ========== Orphan Actions ==========

  @Get('orphans/:driftId/simulate-delete')
  @Roles('viewer')
  @ApiOperation({ summary: 'Simulate orphan delete — returns impact for confirmation modal' })
  async simulateOrphanDelete(@Param('driftId', ParseObjectIdPipe) driftId: string) {
    const drift = await this.driftService.getDriftById(driftId);
    if (!drift || drift.type !== 'ORPHAN_ACCOUNT') {
      throw new HttpException('Orphan drift not found', HttpStatus.NOT_FOUND);
    }
    const accountName =
      drift.userDisplayName || drift.orphanDetails?.accountName || drift.userEmail;
    const targetSystem = drift.targetSystem;
    const systemLabel = targetSystem === 'entra-id' ? 'Microsoft Entra ID' : targetSystem;
    // An AD orphan is never deleted (orphan-delete-policy.ts): POST .../signal refuses it
    const refusal = orphanDeleteRefusal(targetSystem);
    return {
      success: true,
      accountIdentifier: drift.userEmail,
      accountName,
      targetSystem,
      deletable: !refusal,
      impact:
        refusal ??
        `Account "${accountName}" will be permanently removed from ${systemLabel}. This action cannot be undone.`,
    };
  }

  @Post('orphans/:driftId/signal')
  @Roles('operator')
  @ApiOperation({ summary: 'Signal orphan cleanup workflow (ADOPT or DELETE)' })
  @ApiResponse({
    status: 201,
    description: 'The signal was sent to the cleanup, or a fresh cleanup started with it.',
  })
  @ApiResponse({
    status: 422,
    description:
      'DELETE of an Active Directory orphan: EuroID never deletes an AD account (no recycle bin ' +
      "guarantee, and a deleted account's SID is lost). Nothing was signalled.",
  })
  // No running cleanup (ended, never started): OrphanCleanupService starts one with the action
  async signalOrphan(
    @Param('driftId', ParseObjectIdPipe) driftId: string,
    @Body() body: unknown,
    @AuthUser() actor?: AuthUserType,
  ) {
    const parsed = OrphanSignalSchema.parse(body);
    const drift = await this.driftService.getDriftById(driftId);
    if (!drift || drift.type !== 'ORPHAN_ACCOUNT') {
      throw new HttpException('Orphan drift not found', HttpStatus.NOT_FOUND);
    }
    if (parsed.action === 'ADOPT' && !parsed.identityId) {
      throw new HttpException('identityId required for ADOPT', HttpStatus.BAD_REQUEST);
    }
    const refusal =
      parsed.action === 'DELETE' ? orphanDeleteRefusal(drift.targetSystem) : undefined;
    if (refusal) throw new UnprocessableEntityException(refusal);
    // Who decided: the cleanup records it on the drift (orphanDetails.decidedBy)
    const workflowId = await this.orphanCleanup.signal(
      drift,
      parsed.action,
      parsed.identityId,
      actor?.email || actor?.sub,
    );
    if (workflowId !== drift.workflowId) {
      await this.driftService.updateDriftWorkflowId(driftId, workflowId);
    }
    return { success: true, message: `Signal ${parsed.action} sent` };
  }

  @Get('orphans/stats')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get orphan summary statistics' })
  async getOrphanStats() {
    const result = await this.driftService.getDrifts(
      { type: 'ORPHAN_ACCOUNT' } as DriftFilter,
      1,
      10000,
    );
    const list = result.drifts ?? [];
    const bySystem = new Map<string, number>();
    let quarantined = 0;
    let disabled = 0;
    let resolved = 0;
    for (const d of list) {
      bySystem.set(d.targetSystem, (bySystem.get(d.targetSystem) ?? 0) + 1);
      if (d.status === 'quarantined') quarantined++;
      else if (d.orphanDetails?.disabledAt) disabled++;
      else if (d.status === 'corrected' || d.status === 'ignored') resolved++;
    }
    return {
      success: true,
      total: list.length,
      quarantined,
      disabled,
      resolved,
      bySystem: Object.fromEntries(bySystem),
    };
  }

  // ========== Connector Health ==========

  @Get('connector-health')
  @Roles('viewer')
  @ApiOperation({ summary: 'Aggregate health status across all connectors' })
  async getConnectorHealth() {
    // Each installed connector's own health check, for the request's tenant (short cache).
    const tenantId = getRequestContext()?.tenantId ?? 'default';
    const connectors = await this.connectorHealth.getTenantHealth(tenantId);
    return { success: true, connectors };
  }
}
