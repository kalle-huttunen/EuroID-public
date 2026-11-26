import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { HrMoverBatchService } from './hr-mover-batch.service';
import { HrMoverPolicyService } from './hr-mover-policy.service';
import {
  ListMoverBatchesQuerySchema,
  MoverBatchDecisionSchema,
  UpdateMoverPolicySchema,
} from './dto/hr-mover.dto';

/** The audited actor of an admin decision: the authenticated user, never the request body. */
function actorOf(user: AuthUserType): string {
  return user.email || user.sub;
}

/**
 * HR-driven movers: batches an HR sync paused above the mass-mover limit, and the tenant's
 * mass-mover policy. Tenant comes from the authenticated user (TenantContextInterceptor);
 * policy-admin and super-admin only, like the leaver batches.
 */
@ApiTags('Movers')
@ApiBearerAuth('jwt')
@Controller('movers')
@Roles('policy-admin')
export class HrMoversController {
  constructor(
    private readonly batches: HrMoverBatchService,
    private readonly policy: HrMoverPolicyService,
  ) {}

  @Get('batches')
  @ApiOperation({ summary: 'List HR mover batches (newest first) with their identities' })
  @ApiResponse({ status: 200, description: 'Mover batches with members and their changes.' })
  @ApiResponse({ status: 403, description: 'Forbidden: requires policy-admin' })
  async listBatches(@Query() query: unknown) {
    const { status } = ListMoverBatchesQuerySchema.parse(query ?? {});
    return this.batches.list(status);
  }

  @Post('batches/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve a paused mover batch: starts each member mover run' })
  @ApiResponse({ status: 200, description: 'Decided batch with started workflows.' })
  @ApiResponse({ status: 404, description: 'Batch not found in this tenant.' })
  @ApiResponse({ status: 409, description: 'Batch was already approved or rejected.' })
  async approve(@Param('id') id: string, @Body() body: unknown, @AuthUser() user: AuthUserType) {
    const { comment } = MoverBatchDecisionSchema.parse(body ?? {});
    return this.batches.approve(id, actorOf(user), comment);
  }

  @Post('batches/:id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject a paused mover batch: no mover run starts' })
  @ApiResponse({ status: 200, description: 'Decided batch.' })
  @ApiResponse({ status: 404, description: 'Batch not found in this tenant.' })
  @ApiResponse({ status: 409, description: 'Batch was already approved or rejected.' })
  async reject(@Param('id') id: string, @Body() body: unknown, @AuthUser() user: AuthUserType) {
    const { comment } = MoverBatchDecisionSchema.parse(body ?? {});
    return this.batches.reject(id, actorOf(user), comment);
  }

  @Get('policy')
  @ApiOperation({ summary: 'Get the tenant mass-mover policy (defaults when none is stored)' })
  async getPolicy() {
    return this.policy.getPolicy();
  }

  @Put('policy')
  @ApiOperation({ summary: 'Replace the tenant mass-mover policy' })
  @ApiResponse({ status: 400, description: 'Invalid policy.' })
  async updatePolicy(@Body() body: unknown, @AuthUser() user: AuthUserType) {
    const dto = UpdateMoverPolicySchema.parse(body);
    return this.policy.updatePolicy(dto, actorOf(user));
  }
}
