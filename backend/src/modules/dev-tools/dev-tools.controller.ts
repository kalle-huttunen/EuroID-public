/**
 * Dev Tools Controller
 *
 * REST API for the Developer Tools pages.
 *   GET /api/v1/dev/workflows               -- list recent workflows
 *   GET /api/v1/dev/workflows/:workflowId   -- single workflow detail
 *   GET /api/v1/dev/transactions             -- list recent transactions
 *   GET /api/v1/dev/transactions/:txId       -- single transaction detail
 */

import { Controller, Get, Query, Param, UseGuards, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { DevToolsService } from './dev-tools.service';
import { DevToolsGuard } from './dev-tools.guard';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import type { WorkflowType, WorkflowStatus } from './dev-tools.service';
import { TRANSACTION_PHASES, type TransactionPhase } from './schemas/transaction-log.schema';
import { z } from 'zod';

const WorkflowQuerySchema = z.object({
  type: z.enum(['ONBOARDING', 'OFFBOARDING', 'RECONCILIATION', 'BULK_PROVISIONING', 'DISTRIBUTED_TRANSACTION']).optional(),
  status: z.enum(['RUNNING', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const TransactionQuerySchema = z.object({
  phase: z.enum(TRANSACTION_PHASES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@ApiTags('Dev Tools')
@ApiBearerAuth('jwt')
@Controller('dev')
@UseGuards(DevToolsGuard)
export class DevToolsController {
  constructor(private readonly devToolsService: DevToolsService) {}

  // ── Workflows ──────────────────────────────────────────────────────

  @Get('workflows')
  @Roles('viewer')
  @ApiOperation({ summary: 'List recent workflow executions' })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by workflow type' })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by workflow status' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max results (default 50)' })
  async listWorkflows(
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = WorkflowQuerySchema.parse({ type, status, limit });
    const ctx = getRequestContext();
    const tenantId = ctx?.tenantId;
    return this.devToolsService.listWorkflows({
      type: parsed.type as WorkflowType,
      status: parsed.status as WorkflowStatus,
      tenantId,
      limit: parsed.limit,
    });
  }

  @Get('workflows/:workflowId')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get a single workflow execution detail' })
  @ApiResponse({ status: 200, description: 'The workflow, a workflow of the caller tenant' })
  @ApiResponse({ status: 404, description: 'No such workflow in the caller tenant' })
  async getWorkflowDetail(@Param('workflowId') workflowId: string) {
    const detail = await this.devToolsService.getWorkflowDetail(workflowId);
    // Missing and another tenant's workflow answer the same, so an id reveals nothing.
    if (!detail) throw new NotFoundException('Workflow not found');
    return { found: true, workflow: detail };
  }

  // ── Transactions ───────────────────────────────────────────────────

  @Get('transactions')
  @Roles('viewer')
  @ApiOperation({ summary: 'List recent distributed transactions' })
  @ApiQuery({ name: 'phase', required: false, description: 'Filter by transaction phase' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max results (default 50)' })
  async listTransactions(
    @Query('phase') phase?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = TransactionQuerySchema.parse({ phase, limit });
    return this.devToolsService.listTransactions({
      phase: parsed.phase as TransactionPhase,
      limit: parsed.limit,
    });
  }

  @Get('transactions/:transactionId')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get a single distributed transaction detail' })
  async getTransactionDetail(@Param('transactionId') transactionId: string) {
    const detail = await this.devToolsService.getTransactionDetail(transactionId);
    if (!detail) {
      return { found: false, transaction: null };
    }
    return { found: true, transaction: detail };
  }
}
