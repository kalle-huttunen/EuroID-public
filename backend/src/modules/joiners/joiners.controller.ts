import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { JoinerBatchService } from './joiner-batch.service';
import { JoinerPolicyService } from './joiner-policy.service';
import {
  JoinerBatchDecisionSchema,
  ListJoinerBatchesQuerySchema,
  UpdateJoinerPolicySchema,
} from './dto/joiner.dto';

/** The audited actor of an admin decision: the authenticated user, never the request body. */
function actorOf(user: AuthUserType): string {
  return user.email || user.sub;
}

/**
 * HR-driven joiners: batches an HR sync paused above the mass-joiner limit, and the tenant's
 * mass-joiner policy. Tenant comes from the authenticated user (TenantContextInterceptor);
 * policy-admin and super-admin only, like the leaver and mover batches.
 */
@ApiTags('Joiners')
@ApiBearerAuth('jwt')
@Controller('joiners')
@Roles('policy-admin')
export class JoinersController {
  constructor(
    private readonly batches: JoinerBatchService,
    private readonly policy: JoinerPolicyService,
  ) {}

  @Get('batches')
  @ApiOperation({ summary: 'List HR joiner batches (newest first) with their identities' })
  @ApiResponse({ status: 200, description: 'Joiner batches with members.' })
  @ApiResponse({ status: 400, description: 'Unknown status filter.' })
  @ApiResponse({ status: 403, description: 'Forbidden: requires policy-admin' })
  async listBatches(@Query() query: unknown) {
    const { status } = ListJoinerBatchesQuerySchema.parse(query ?? {});
    return this.batches.list(status);
  }

  @Post('batches/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve a paused joiner batch: starts each member onboarding' })
  @ApiResponse({ status: 200, description: 'Decided batch with started workflows.' })
  @ApiResponse({ status: 400, description: 'Invalid body.' })
  @ApiResponse({ status: 403, description: 'Forbidden: requires policy-admin' })
  @ApiResponse({ status: 404, description: 'Batch not found in this tenant.' })
  @ApiResponse({
    status: 409,
    description: 'Batch was already decided, or the pipeline is not deployed.',
  })
  async approve(@Param('id') id: string, @Body() body: unknown, @AuthUser() user: AuthUserType) {
    const { comment } = JoinerBatchDecisionSchema.parse(body ?? {});
    return this.batches.approve(id, actorOf(user), comment);
  }

  @Post('batches/:id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject a paused joiner batch: no onboarding starts' })
  @ApiResponse({ status: 200, description: 'Decided batch.' })
  @ApiResponse({ status: 400, description: 'Invalid body.' })
  @ApiResponse({ status: 403, description: 'Forbidden: requires policy-admin' })
  @ApiResponse({ status: 404, description: 'Batch not found in this tenant.' })
  @ApiResponse({ status: 409, description: 'Batch was already approved or rejected.' })
  async reject(@Param('id') id: string, @Body() body: unknown, @AuthUser() user: AuthUserType) {
    const { comment } = JoinerBatchDecisionSchema.parse(body ?? {});
    return this.batches.reject(id, actorOf(user), comment);
  }

  @Get('policy')
  @ApiOperation({ summary: 'Get the tenant mass-joiner policy (defaults when none is stored)' })
  @ApiResponse({ status: 200, description: 'The policy; configured is false on the defaults.' })
  @ApiResponse({ status: 403, description: 'Forbidden: requires policy-admin' })
  async getPolicy() {
    return this.policy.getPolicy();
  }

  @Put('policy')
  @ApiOperation({ summary: 'Replace the tenant mass-joiner policy' })
  @ApiResponse({ status: 200, description: 'The stored policy.' })
  @ApiResponse({ status: 400, description: 'Invalid policy.' })
  @ApiResponse({ status: 403, description: 'Forbidden: requires policy-admin' })
  async updatePolicy(@Body() body: unknown, @AuthUser() user: AuthUserType) {
    const dto = UpdateJoinerPolicySchema.parse(body);
    return this.policy.updatePolicy(dto, actorOf(user));
  }
}
