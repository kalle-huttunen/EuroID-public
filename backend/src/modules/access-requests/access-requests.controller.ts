import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Put,
  Param,
  Query,
  Body,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { AccessRequestsService } from './access-requests.service';
import {
  CreateAccessRequestSchema,
  type CreateAccessRequestDto,
} from './dtos/create-access-request.dto';
import {
  DecideAccessRequestSchema,
  DelegateAccessRequestSchema,
  RemovedManuallySchema,
} from './dtos/decide-access-request.dto';
import { AccessRequestManualRemovalService } from './access-request-manual-removal.service';
import { rolesGrant } from '@infrastructure/auth/roles.guard';
import { PreCheckSodSchema, type PreCheckSodDto } from './dtos/pre-check-sod.dto';
import { IDENTITY_QUERY_PORT, IIdentityQueryPort } from '@shared/interfaces/identity-query.port';
import { validatePageLimit } from '@shared/utils/pagination-validator';

/**
 * REST API for Access Request Portal (self-service access requests).
 */
@ApiTags('Access Requests')
@ApiBearerAuth('jwt')
@Controller('access-requests')
export class AccessRequestsController {
  constructor(
    private readonly accessRequests: AccessRequestsService,
    @Inject(IDENTITY_QUERY_PORT) private readonly identityQuery: IIdentityQueryPort,
    private readonly manualRemoval: AccessRequestManualRemovalService,
  ) {}

  private async resolveRequesterId(
    authUser: AuthUserType,
  ): Promise<{ requesterId: string; requesterEmail: string }> {
    const email = authUser?.email;
    if (!email) throw new BadRequestException('Authentication required');
    const identity = await this.identityQuery.findByEmail(email);
    const requesterId = identity?._id ? String(identity._id) : email;
    return { requesterId, requesterEmail: email };
  }

  @Get('pending-approvals')
  @Roles('viewer')
  @ApiOperation({ summary: 'List pending approvals for current user' })
  async listPendingApprovals(@AuthUser() authUser?: AuthUserType) {
    const { requesterId, requesterEmail } = await this.resolveRequesterId(authUser!);
    return this.accessRequests.listPendingApprovals(requesterId, requesterEmail);
  }

  @Post()
  @Roles('viewer')
  @ApiOperation({ summary: 'Create access request' })
  async create(@Body() body: unknown, @AuthUser() authUser?: AuthUserType) {
    const dto: CreateAccessRequestDto = CreateAccessRequestSchema.parse(body);
    const { requesterId, requesterEmail } = await this.resolveRequesterId(authUser!);
    return this.accessRequests.createRequest(dto, requesterId, requesterEmail);
  }

  @Get()
  @Roles('viewer')
  @ApiOperation({
    summary:
      'List my access requests; with removalFailing=true (policy-admin) the requests of the ' +
      'tenant whose removal keeps failing',
  })
  @ApiQuery({
    name: 'removalFailing',
    required: false,
    enum: ['true', 'false'],
    description:
      'true (policy-admin only, else 403): every ACTIVE request of the tenant whose end date has ' +
      'passed and whose removal failed (statusReason set), oldest end date first; status is ignored',
  })
  @ApiResponse({
    status: 200,
    description: '{ data, total }: the requests of the page, and how many match',
  })
  @ApiResponse({ status: 400, description: 'removalFailing is neither true nor false' })
  @ApiResponse({ status: 403, description: 'removalFailing=true without policy-admin' })
  async list(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('removalFailing') removalFailing?: string,
    @AuthUser() authUser?: AuthUserType,
  ) {
    if (removalFailing !== undefined && removalFailing !== 'true' && removalFailing !== 'false') {
      throw new BadRequestException('removalFailing must be true or false');
    }
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? Math.min(parseInt(limit, 10) || 50, 100) : 50;
    validatePageLimit(pageNum, limitNum);
    if (removalFailing === 'true') {
      // Tenant-wide: the list a policy-admin closes stuck removals from
      if (!rolesGrant(authUser?.roles, 'policy-admin')) {
        throw new ForbiddenException('Requires policy-admin');
      }
      return this.accessRequests.listRemovalFailing({ page: pageNum, limit: limitNum });
    }
    const { requesterId } = await this.resolveRequesterId(authUser!);
    return this.accessRequests.listMyRequests(requesterId, {
      status,
      page: pageNum,
      limit: limitNum,
    });
  }

  @Get('pending-approvals/count')
  @Roles('viewer')
  @ApiOperation({ summary: 'Count pending approvals for sidebar badge' })
  async countPendingApprovals(@AuthUser() authUser?: AuthUserType) {
    const { requesterId, requesterEmail } = await this.resolveRequesterId(authUser!);
    const count = await this.accessRequests.countPendingApprovals(requesterId, requesterEmail);
    return { count };
  }

  @Post('pre-check-sod')
  @Roles('viewer')
  @ApiOperation({ summary: 'Pre-check SoD violations before submitting request' })
  async preCheckSod(@Body() body: unknown, @AuthUser() authUser?: AuthUserType) {
    const dto: PreCheckSodDto = PreCheckSodSchema.parse(body);
    const { requesterId, requesterEmail } = await this.resolveRequesterId(authUser!);
    return this.accessRequests.preCheckSod(dto, requesterId, requesterEmail);
  }

  @Get(':id')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get access request detail' })
  @ApiResponse({ status: 200, description: 'The request' })
  @ApiResponse({
    status: 403,
    description: 'Neither the requester nor an approver of the request, nor a policy-admin',
  })
  async getDetail(@Param('id', ParseUUIDPipe) id: string, @AuthUser() authUser?: AuthUserType) {
    const { requesterId, requesterEmail } = await this.resolveRequesterId(authUser!);
    // A policy-admin opens any request of the tenant: they close one as removed by hand
    const anyRequest = rolesGrant(authUser?.roles, 'policy-admin');
    return this.accessRequests.getRequestDetail(id, requesterId, requesterEmail, anyRequest);
  }

  @Post(':id/removed-manually')
  @HttpCode(200)
  // Asserts a removal EuroID cannot verify: policy-admin, as closing a failed identity expiry
  @Roles('policy-admin')
  @ApiOperation({
    summary:
      'Close an ACTIVE request whose removal keeps failing: an admin removed the access by hand',
  })
  @ApiResponse({
    status: 200,
    description: 'The request, now EXPIRED with removedManually; its workflow stops retrying',
  })
  @ApiResponse({ status: 400, description: 'Missing note, or other fields in the body' })
  @ApiResponse({ status: 403, description: 'Forbidden: requires policy-admin' })
  @ApiResponse({ status: 404, description: 'No such request in this tenant' })
  @ApiResponse({
    status: 409,
    description: 'Not ACTIVE, its end date has not passed, or it changed meanwhile',
  })
  @ApiResponse({
    status: 503,
    description: 'The approval workflow could not be reached: nothing changed, try again',
  })
  async markRemovedManually(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @AuthUser() authUser?: AuthUserType,
  ) {
    const { note } = RemovedManuallySchema.parse(body ?? {});
    const admin = authUser?.email || authUser?.sub;
    if (!admin) throw new BadRequestException('Authentication required');
    return this.manualRemoval.markRemovedManually(id, admin, note);
  }

  @Put(':id/approve')
  // Any signed-in user: the service lets only the step's approver decide it
  @Roles('viewer')
  @ApiOperation({ summary: 'Approve current step' })
  @ApiResponse({ status: 200, description: 'Decision recorded and sent to the approval workflow' })
  @ApiResponse({
    status: 409,
    description: 'The approval workflow is no longer running: the request was closed (CANCELLED)',
  })
  @ApiResponse({
    status: 503,
    description: 'The approval workflow could not be reached: nothing recorded, try again',
  })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @AuthUser() authUser?: AuthUserType,
  ) {
    const parsed = DecideAccessRequestSchema.parse(body);
    if (parsed.decision !== 'approve')
      throw new BadRequestException('Use reject endpoint for rejection');
    const { requesterId, requesterEmail } = await this.resolveRequesterId(authUser!);
    await this.accessRequests.approve(
      id,
      parsed.stepIndex,
      requesterId,
      requesterEmail,
      parsed.justification,
    );
    return { success: true };
  }

  @Put(':id/reject')
  // Any signed-in user: the service lets only the step's approver decide it
  @Roles('viewer')
  @ApiOperation({ summary: 'Reject request' })
  @ApiResponse({ status: 200, description: 'Decision recorded and sent to the approval workflow' })
  @ApiResponse({
    status: 409,
    description: 'The approval workflow is no longer running: the request was closed (CANCELLED)',
  })
  @ApiResponse({
    status: 503,
    description: 'The approval workflow could not be reached: nothing recorded, try again',
  })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @AuthUser() authUser?: AuthUserType,
  ) {
    const parsed = DecideAccessRequestSchema.parse(body);
    if (parsed.decision !== 'reject')
      throw new BadRequestException('Use approve endpoint for approval');
    const { requesterId, requesterEmail } = await this.resolveRequesterId(authUser!);
    await this.accessRequests.reject(
      id,
      parsed.stepIndex,
      requesterId,
      requesterEmail,
      parsed.justification,
    );
    return { success: true };
  }

  @Put(':id/cancel')
  @Roles('viewer')
  @ApiOperation({ summary: 'Cancel own request' })
  async cancel(@Param('id', ParseUUIDPipe) id: string, @AuthUser() authUser?: AuthUserType) {
    const { requesterId } = await this.resolveRequesterId(authUser!);
    await this.accessRequests.cancel(id, requesterId);
    return { success: true };
  }

  @Put(':id/delegate')
  // Any signed-in user: the service lets only the step's approver decide it
  @Roles('viewer')
  @ApiOperation({ summary: 'Delegate approval to another user' })
  @ApiResponse({ status: 200, description: 'Step handed over and the approval workflow told' })
  @ApiResponse({ status: 400, description: 'Delegate not found, or the step was decided already' })
  @ApiResponse({
    status: 409,
    description: 'The approval workflow is no longer running: the request was closed (CANCELLED)',
  })
  @ApiResponse({
    status: 503,
    description: 'The approval workflow could not be reached: nothing recorded, try again',
  })
  async delegate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @AuthUser() authUser?: AuthUserType,
  ) {
    const parsed = DelegateAccessRequestSchema.parse(body);
    const { requesterId, requesterEmail } = await this.resolveRequesterId(authUser!);
    await this.accessRequests.delegate(
      id,
      parsed.stepIndex,
      requesterId,
      requesterEmail,
      parsed.delegateTo,
    );
    return { success: true };
  }
}
