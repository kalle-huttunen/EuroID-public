/**
 * Bulk Provisioning Controller
 *
 * REST API endpoints for bulk user provisioning operations.
 *
 * Endpoints:
 * - POST /bulk-provisioning/start - Start a bulk provisioning workflow
 * - GET /bulk-provisioning/status/:workflowId - Get workflow status and progress
 * - GET /bulk-provisioning/results/:workflowId - Get final results
 * - GET /bulk-provisioning/partial-results/:workflowId - Get partial results (while running)
 * - POST /bulk-provisioning/approve-deletes/:workflowId - Approve delete operations
 * - POST /bulk-provisioning/cancel/:workflowId - Cancel a running workflow
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpException,
  HttpStatus,
  Logger,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { BulkProvisioningService } from './bulk-provisioning.service';
import {
  BulkOperationRequest,
  BulkOperation,
  BulkOperationType,
  OperationPriority,
} from '@shared/dtos/bulk-operation.dto';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import { temporalWorkflowUrl } from '@infrastructure/config/temporal.config';
import { AuditService } from '../audit/audit.service';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { z, ZodError } from 'zod';
import { CorrelationConfigUnavailableError } from '../correlation-config/correlation-config.errors';

// ── Zod input schema for @Body() validation ──

const BulkOperationSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.nativeEnum(BulkOperationType),
  // No tenantId: the controller sets each user's tenant from the request context.
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
  priority: z.nativeEnum(OperationPriority),
  requiresApproval: z.boolean().optional(),
  metadata: z.record(z.string().max(100), z.unknown()).optional(),
});

// No tenantId: the batch always runs in the caller's tenant (request context).
const BulkOperationRequestSchema = z.object({
  batchId: z.string().min(1).max(200),
  operations: z.array(BulkOperationSchema).min(1).max(10000),
  dryRun: z.boolean().optional(),
  continueOnError: z.boolean().optional(),
  batchSize: z.number().int().positive().max(1000).optional(),
  // Deletes wait for an approval unless the caller turns it off, as the UI's default does
  requireApprovalForDeletes: z.boolean().default(true),
  initiatedBy: z.string().min(1).max(200),
  notes: z.string().max(2000).optional(),
});

@ApiTags('Bulk Provisioning')
@ApiBearerAuth('jwt')
@Controller('bulk-provisioning')
export class BulkProvisioningController {
  private readonly logger = new Logger(BulkProvisioningController.name);

  constructor(
    private readonly bulkProvisioningService: BulkProvisioningService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Start a bulk provisioning workflow
   *
   * @example
   * POST /bulk-provisioning/start
   * {
   *   "batchId": "batch-001",
   *   "operations": [
   *     {
   *       "id": "op-1",
   *       "type": "CREATE",
   *       "user": { ... },
   *       "targetSystems": ["entra-id", "active-directory"],
   *       "priority": "NORMAL"
   *     }
   *   ],
   *   "dryRun": false,
   *   "continueOnError": true,
   *   "batchSize": 10,
   *   "requireApprovalForDeletes": true,
   *   "initiatedBy": "admin@acme.com"
   * }
   */
  @Post('start')
  @Roles('operator')
  @ApiOperation({ summary: 'Start bulk provisioning workflow' })
  async startBulkProvisioning(@Body() body: unknown, @AuthUser() user?: AuthUserType) {
    try {
      const parsed = BulkOperationRequestSchema.parse(body);

      // Tenant isolation: the batch and every user in it belong to the caller's tenant.
      // The user objects pass unknown keys through, so a body tenantId is overwritten here.
      const tenantId = getCurrentTenantId();
      const request = {
        ...parsed,
        tenantId,
        operations: parsed.operations.map((op) => ({ ...op, user: { ...op.user, tenantId } })),
      } as BulkOperationRequest;

      // SoD: Always use authenticated user for initiatedBy, never from request body: the email,
      // else the principal's id, so the delete approval can tell the initiator from an approver
      const requestWithActor = { ...request, initiatedBy: principalOf(user) };

      // Start workflow
      const workflowId = await this.bulkProvisioningService.startBulkProvisioning(requestWithActor);

      return {
        success: true,
        message: 'Bulk provisioning workflow started',
        workflowId,
        batchId: request.batchId,
        operationCount: request.operations.length,
        dryRun: request.dryRun || false,
        trackingUrl: temporalWorkflowUrl(workflowId),
      };
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        throw new HttpException(
          { message: 'Validation failed', errors: error.errors },
          HttpStatus.BAD_REQUEST,
        );
      }
      // 503: the national IDs could not be removed from the users, nothing started; try again
      if (error instanceof CorrelationConfigUnavailableError) throw error;
      const stack = error instanceof Error ? error.stack : String(error);
      this.logger.error('Failed to start bulk provisioning', stack);
      throw new HttpException('Operation failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Get workflow status and progress
   */
  @Get('status/:workflowId')
  @Roles('operator')
  @ApiOperation({ summary: 'Get workflow status and progress' })
  async getStatus(@Param('workflowId') workflowId: string) {
    try {
      const status = await this.bulkProvisioningService.getWorkflowStatus(workflowId);
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
   * Get final workflow results (only when completed)
   */
  @Get('results/:workflowId')
  @Roles('operator')
  @ApiOperation({ summary: 'Get final workflow results (when completed)' })
  async getResults(@Param('workflowId') workflowId: string, @AuthUser() user?: AuthUserType) {
    try {
      const results = await this.bulkProvisioningService.getWorkflowResults(workflowId);

      // Emit DATA_EXPORTED when bulk results are fetched
      const ctx = getRequestContext();
      this.auditService.logFireAndForget({
        action: 'DATA_EXPORTED',
        actor: user?.email ?? 'unknown',
        resourceType: 'workflow',
        resourceId: workflowId,
        resourceName: 'Bulk Provisioning Results',
        description: `Bulk provisioning results exported for workflow ${workflowId}`,
        payload: { metadata: { workflowId } },
        tenantId: ctx?.tenantId ?? 'unknown',
      });

      return {
        success: true,
        results,
      };
    } catch (error: unknown) {
      const stack = error instanceof Error ? error.stack : String(error);
      this.logger.error('Failed to get workflow results', stack);
      throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    }
  }

  /**
   * Get partial results (while workflow is still running)
   */
  @Get('partial-results/:workflowId')
  @Roles('operator')
  @ApiOperation({ summary: 'Get partial results (while workflow is running)' })
  async getPartialResults(@Param('workflowId') workflowId: string) {
    try {
      const results = await this.bulkProvisioningService.getPartialResults(workflowId);
      return {
        success: true,
        results,
      };
    } catch (error: unknown) {
      const stack = error instanceof Error ? error.stack : String(error);
      this.logger.error('Failed to get partial results', stack);
      throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    }
  }

  /**
   * Approve delete operations (sends signal to workflow)
   * SoD: Rejects if approver is the same person who initiated the batch.
   */
  @Post('approve-deletes/:workflowId')
  @Roles('operator')
  @ApiOperation({ summary: 'Approve delete operations (sends signal to workflow)' })
  async approveDeletes(@Param('workflowId') workflowId: string, @AuthUser() user?: AuthUserType) {
    try {
      await this.bulkProvisioningService.approveDeletes(workflowId, principalOf(user));
      return {
        success: true,
        message: 'Delete operations approved',
        workflowId,
        approvedBy: user?.email,
      };
    } catch (error: unknown) {
      const stack = error instanceof Error ? error.stack : String(error);
      this.logger.error('Failed to approve deletes', stack);
      if (
        error instanceof ForbiddenException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      throw new HttpException('Operation failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Cancel a running batch: it stops before its next operation, rolls back what it changed and
   * ends CANCELLED with its results. 409 for a batch that is not running.
   */
  @Post('cancel/:workflowId')
  @Roles('operator')
  @ApiOperation({ summary: 'Cancel a running workflow' })
  async cancelWorkflow(@Param('workflowId') workflowId: string, @AuthUser() user?: AuthUserType) {
    try {
      await this.bulkProvisioningService.cancelWorkflow(workflowId, user?.email ?? 'unknown');
      return {
        success: true,
        // The run stops before its next operation, rolls back what it changed, ends CANCELLED
        message: 'Cancel requested',
        workflowId,
        cancelledBy: user?.email,
      };
    } catch (error: unknown) {
      const stack = error instanceof Error ? error.stack : String(error);
      this.logger.error('Failed to cancel workflow', stack);
      if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
      throw new HttpException('Operation failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Helper endpoint to test with sample data
   * (Remove in production)
   */
  @Post('test/sample-batch')
  @Roles('operator')
  @ApiOperation({ summary: 'Create sample test batch (dev only)' })
  async createSampleBatch(@AuthUser() user?: AuthUserType) {
    const sampleOperations: BulkOperation[] = [
      {
        id: 'op-1',
        type: BulkOperationType.CREATE,
        user: {
          sourceSystem: 'TestSystem',
          sourceUserId: 'test-001',
          tenantId: 'test-tenant',
          firstName: 'John',
          lastName: 'Doe',
          email: 'john.doe@test.com',
          status: UserStatus.ACTIVE,
          schemaVersion: '2.0.0',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        targetSystems: ['entra-id'],
        priority: OperationPriority.NORMAL,
      },
      {
        id: 'op-2',
        type: BulkOperationType.CREATE,
        user: {
          sourceSystem: 'TestSystem',
          sourceUserId: 'test-002',
          tenantId: 'test-tenant',
          firstName: 'Jane',
          lastName: 'Smith',
          email: 'jane.smith@test.com',
          status: UserStatus.ACTIVE,
          schemaVersion: '2.0.0',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        targetSystems: ['entra-id'],
        priority: OperationPriority.NORMAL,
      },
    ];

    const request: BulkOperationRequest = {
      batchId: `test-batch-${Date.now()}`,
      tenantId: 'test-tenant',
      operations: sampleOperations,
      dryRun: true,
      continueOnError: true,
      batchSize: 5,
      requireApprovalForDeletes: false,
      initiatedBy: 'system-test',
      notes: 'Sample test batch',
    };

    return this.startBulkProvisioning(request, user);
  }
}

/** Who the caller is for the bulk audit and the delete approval: the email, else the id. */
function principalOf(user: AuthUserType | undefined): string {
  return user?.email || user?.sub || 'unknown';
}
