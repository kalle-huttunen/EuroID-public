/**
 * Dead Letter Queue Controller
 *
 * REST API for inspecting and managing failed events.
 *   GET  /api/v1/dead-letter           — list entries (with filters)
 *   GET  /api/v1/dead-letter/stats     — retry success/failure metrics
 *   GET  /api/v1/dead-letter/:id       — single entry
 *   POST /api/v1/dead-letter/:id/dismiss — mark as dismissed
 *   POST /api/v1/dead-letter/:id/replay  — replay (super-admin only)
 *   POST /api/v1/dead-letter/:id/retry   — retry single entry (super-admin)
 *   POST /api/v1/dead-letter/batch-retry — batch retry (super-admin)
 *
 * Retry and replay wait for the re-run and answer its outcome: `success` is true only when the
 * entry was closed as `replayed`; otherwise `status` is where it went and `error` why. An entry
 * with nothing to re-run is refused with 409 (dismiss it instead), as is one another admin or the
 * automatic retry is re-running right now.
 */

import { Controller, Get, Post, Param, Query, Body, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { DeadLetterService } from './dead-letter.service';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { BatchRetrySchema } from './dtos/batch-retry.dto';
import { DeadLetterListQuerySchema } from './dtos/list-query.dto';

/** The 409 of retry and replay: nothing ran. */
const NOT_RERUN =
  'Nothing ran: the entry carries no domain event (dismiss it instead), or another admin or the automatic retry is re-running it right now (reload it to see where it is).';

@ApiTags('Dead Letter Queue')
@ApiBearerAuth('jwt')
@Controller('dead-letter')
export class DeadLetterController {
  constructor(private readonly deadLetterService: DeadLetterService) {}

  @Get()
  @Roles('operator')
  @ApiOperation({ summary: 'List dead letter entries with optional filters' })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: [
      'event_handler_failure',
      'event_chain_depth_exceeded',
      'event_validation_failure',
      'workflow_terminal',
      'connector_non_retryable',
    ],
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'replayed', 'dismissed', 'retrying', 'failed_permanently'],
  })
  @ApiQuery({
    name: 'source',
    required: false,
    type: String,
    description: 'Source prefix, case-insensitive (e.g. "identity.created" or "webhook:")',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max items (default 50, max 100)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Pagination offset',
  })
  async list(
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('source') source?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const parsed = DeadLetterListQuerySchema.parse({ type, status, source, offset });
    const filter = {
      type: parsed.type,
      status: parsed.status,
      source: parsed.source || undefined,
      limit: limit ? Math.min(parseInt(limit, 10) || 50, 100) : undefined,
      offset: parsed.offset,
    };
    return this.deadLetterService.findAll(filter);
  }

  // stats MUST be before :id to prevent route collision
  @Get('stats')
  @Roles('operator')
  @ApiOperation({ summary: 'Get DLQ statistics by status' })
  async stats() {
    return this.deadLetterService.getStats();
  }

  @Get(':id')
  @Roles('operator')
  @ApiOperation({ summary: 'Get a single dead letter entry by ID' })
  async getOne(@Param('id', ParseObjectIdPipe) id: string) {
    return this.deadLetterService.findOne(id);
  }

  @Post('batch-retry')
  @Roles('super-admin')
  @ApiOperation({
    summary: 'Batch retry dead letter entries matching filter',
  })
  async batchRetry(@Body() body: unknown, @Req() req: Request) {
    const parsed = BatchRetrySchema.parse(body ?? {});
    const actor = (req as Request & { user?: { email?: string } }).user?.email ?? 'system';
    const result = await this.deadLetterService.batchRetry(parsed, actor);
    return { success: true, ...result };
  }

  @Post(':id/dismiss')
  @Roles('operator')
  @ApiOperation({ summary: 'Mark a dead letter entry as dismissed' })
  async dismiss(@Param('id', ParseObjectIdPipe) id: string, @Req() req: Request) {
    const actor = (req as Request & { user?: { email?: string } }).user?.email ?? 'system';
    await this.deadLetterService.dismiss(id, actor);
    return { success: true, id, status: 'dismissed' };
  }

  @Post(':id/replay')
  @Roles('super-admin')
  @ApiOperation({
    summary: 'Replay a dead letter entry (dangerous — requires super-admin)',
  })
  @ApiResponse({ status: 409, description: NOT_RERUN })
  async replay(@Param('id', ParseObjectIdPipe) id: string, @Req() req: Request) {
    const actor = (req as Request & { user?: { email?: string } }).user?.email ?? 'system';
    const outcome = await this.deadLetterService.replay(id, actor);
    return { success: outcome.status === 'replayed', ...outcome };
  }

  @Post(':id/retry')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Retry a dead letter entry' })
  @ApiResponse({ status: 409, description: NOT_RERUN })
  async retry(@Param('id', ParseObjectIdPipe) id: string, @Req() req: Request) {
    const actor = (req as Request & { user?: { email?: string } }).user?.email ?? 'system';
    const outcome = await this.deadLetterService.retryEntry(id, actor);
    return { success: outcome.status === 'replayed', ...outcome };
  }
}
