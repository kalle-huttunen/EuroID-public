import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { LeaverBatchService } from './leaver-batch.service';
import { LeaverPolicyService } from './leaver-policy.service';
import { LeaverManualRemovalService } from './leaver-manual-removal.service';
import {
  LeaverBatchDecisionSchema,
  ListLeaverBatchesQuerySchema,
  MarkRemovedManuallySchema,
  OffboardingWorkflowIdSchema,
  UpdateLeaverPolicySchema,
} from './dto/leaver.dto';

/** The audited actor of an admin decision: the authenticated user, never the request body. */
function actorOf(user: AuthUserType): string {
  return user.email || user.sub;
}

/**
 * HR leavers: paused mass-leaver batches, offboardings that left a target failed (any trigger:
 * an HR leaver or DELETE /identity/:id) and closing one as removed by hand, and the tenant's
 * leaver policy. Tenant comes from the authenticated user (TenantContextInterceptor);
 * policy-admin and super-admin only.
 */
@ApiTags('Leavers')
@ApiBearerAuth('jwt')
@Controller('leavers')
@Roles('policy-admin')
export class LeaversController {
  constructor(
    private readonly batches: LeaverBatchService,
    private readonly policy: LeaverPolicyService,
    private readonly manualRemoval: LeaverManualRemovalService,
  ) {}

  @Get('batches')
  @ApiOperation({ summary: 'List leaver batches (newest first) with their identities' })
  @ApiResponse({ status: 200, description: 'Leaver batches with members.' })
  @ApiResponse({ status: 403, description: 'Forbidden: requires policy-admin' })
  async listBatches(@Query() query: unknown) {
    const { status } = ListLeaverBatchesQuerySchema.parse(query ?? {});
    return this.batches.list(status);
  }

  @Post('batches/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve a paused leaver batch: starts every member offboarding' })
  @ApiResponse({ status: 200, description: 'Decided batch with started workflows.' })
  @ApiResponse({ status: 404, description: 'Batch not found in this tenant.' })
  @ApiResponse({ status: 409, description: 'Batch was already approved or rejected.' })
  async approve(@Param('id') id: string, @Body() body: unknown, @AuthUser() user: AuthUserType) {
    const { comment } = LeaverBatchDecisionSchema.parse(body ?? {});
    return this.batches.approve(id, actorOf(user), comment);
  }

  @Post('batches/:id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject a paused leaver batch: no offboarding starts' })
  @ApiResponse({ status: 200, description: 'Decided batch.' })
  @ApiResponse({ status: 404, description: 'Batch not found in this tenant.' })
  @ApiResponse({ status: 409, description: 'Batch was already approved or rejected.' })
  async reject(@Param('id') id: string, @Body() body: unknown, @AuthUser() user: AuthUserType) {
    const { comment } = LeaverBatchDecisionSchema.parse(body ?? {});
    return this.batches.reject(id, actorOf(user), comment);
  }

  @Get('open-offboardings')
  @ApiOperation({
    summary: 'List offboardings that left a target failed, leaver or user delete (newest first)',
  })
  @ApiResponse({
    status: 200,
    description: 'Offboardings with their per-system result and the leaver event, if any.',
  })
  @ApiResponse({ status: 403, description: 'Forbidden: requires policy-admin' })
  async listOpenOffboardings() {
    return this.manualRemoval.listOpen();
  }

  @Post('offboardings/:workflowId/removed-manually')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Close a failed offboarding target: an admin removed the account by hand',
  })
  @ApiResponse({ status: 200, description: 'The offboarding with its updated result.' })
  @ApiResponse({ status: 400, description: 'Missing system or reason.' })
  @ApiResponse({ status: 404, description: 'Offboarding not found in this tenant.' })
  @ApiResponse({
    status: 409,
    description:
      'That target is not failed (already closed), or it is the last failed one and a linked ' +
      'admin identity of the person is still live (the message names it).',
  })
  async markRemovedManually(
    @Param('workflowId') workflowId: string,
    @Body() body: unknown,
    @AuthUser() user: AuthUserType,
  ) {
    const id = OffboardingWorkflowIdSchema.parse(workflowId);
    const { system, reason } = MarkRemovedManuallySchema.parse(body ?? {});
    return this.manualRemoval.markRemoved(id, system, actorOf(user), reason);
  }

  @Get('policy')
  @ApiOperation({ summary: 'Get the tenant leaver policy (defaults when none is stored)' })
  async getPolicy() {
    return this.policy.getPolicy();
  }

  @Put('policy')
  @ApiOperation({ summary: 'Replace the tenant leaver policy' })
  @ApiResponse({ status: 400, description: 'Invalid policy.' })
  async updatePolicy(@Body() body: unknown, @AuthUser() user: AuthUserType) {
    const dto = UpdateLeaverPolicySchema.parse(body);
    return this.policy.updatePolicy(dto, actorOf(user));
  }
}
