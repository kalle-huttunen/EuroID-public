import { Controller, Get, Post, Param, Body, Query, Logger, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import {
  AccessReviewService,
  CreateCampaignDto,
  CampaignFilter,
  ItemFilter,
} from './access-review.service';
import { ReviewDecision } from './schemas/review-item.schema';
import type { CampaignScope } from './schemas/review-campaign.schema';
import { CreateCampaignBodyDto } from './dtos/create-campaign.dto';
import { DecideBodyDto } from './dtos/decide.dto';
import { CancelCampaignBodyDto, CancelCampaignBodySchema } from './dtos/cancel-campaign.dto';
import { ListCampaignsQueryDto } from './dtos/list-campaigns-query.dto';
import { ListItemsQueryDto } from './dtos/list-items-query.dto';

/** Campaign ids are UUIDs (randomUUID), not Mongo ObjectIds: campaign routes parse a UUID. */
@ApiTags('Access Reviews')
@ApiBearerAuth('jwt')
@Controller('access-reviews')
export class AccessReviewController {
  private readonly logger = new Logger(AccessReviewController.name);

  constructor(private readonly accessReviewService: AccessReviewService) {}

  @Post('campaigns')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Create campaign (DRAFT)' })
  @ApiResponse({ status: 201, description: 'Campaign created' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — policy-admin required' })
  createCampaign(@Body() body: CreateCampaignBodyDto, @AuthUser() user?: AuthUserType) {
    const deadline = body.deadline
      ? new Date(body.deadline)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const dto: CreateCampaignDto = {
      name: body.name,
      description: body.description,
      scope: body.scope as CampaignScope,
      deadline,
      autoRevokeOnExpiry: body.autoRevokeOnExpiry ?? false,
      allowSelfReview: body.allowSelfReview ?? false,
      selfReviewRiskLevels: body.selfReviewRiskLevels ?? ['LOW'],
      targetEmploymentTypes: body.targetEmploymentTypes,
      recurrence: body.recurrence,
      escalation: body.escalation,
    };
    return this.accessReviewService.createCampaign(dto, user?.email || 'admin');
  }

  @Get('campaigns')
  @Roles('viewer')
  @ApiOperation({ summary: 'List campaigns (paginated)' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  listCampaigns(@Query() query: ListCampaignsQueryDto) {
    const filter: CampaignFilter = {
      status: query.status,
      page: query.page,
      limit: query.limit,
    };
    return this.accessReviewService.findAll(filter);
  }

  @Get('campaigns/:id')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get campaign detail with stats' })
  @ApiResponse({ status: 404, description: 'Campaign not found' })
  getCampaign(@Param('id', ParseUUIDPipe) id: string) {
    return this.accessReviewService.findOne(id);
  }

  @Post('campaigns/:id/activate')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Activate campaign and generate review items' })
  @ApiResponse({ status: 400, description: 'Campaign not in DRAFT' })
  @ApiResponse({ status: 404, description: 'Campaign not found' })
  activateCampaign(@Param('id', ParseUUIDPipe) id: string) {
    return this.accessReviewService.activate(id);
  }

  @Post('campaigns/:id/cancel')
  @Roles('super-admin')
  @ApiOperation({
    summary: 'Cancel campaign (DRAFT or ACTIVE)',
    description:
      'A recurring campaign also ends its recurrence (recurrence.enabled false): no next ' +
      'campaign is created.',
  })
  @ApiBody({
    type: CancelCampaignBodyDto,
    required: false,
    description: 'Optional reason (1 to 500 characters), recorded in the audit log',
  })
  @ApiResponse({
    status: 400,
    description:
      'Campaign cannot be cancelled (COMPLETED or CANCELLED), or a reason that is empty or ' +
      'longer than 500 characters',
  })
  @ApiResponse({ status: 403, description: 'Forbidden: super-admin required' })
  @ApiResponse({ status: 404, description: 'Campaign not found' })
  cancelCampaign(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    // Express 5 leaves the body undefined when the request has none: no reason then
    const { reason } = CancelCampaignBodySchema.parse(body ?? {});
    return this.accessReviewService.cancel(id, reason);
  }

  @Get('campaigns/:id/items')
  @Roles('viewer')
  @ApiOperation({ summary: 'List review items for campaign (paginated)' })
  @ApiResponse({ status: 404, description: 'Campaign not found' })
  listItems(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListItemsQueryDto) {
    const filter: ItemFilter = {
      decision: query.decision as ItemFilter['decision'],
      reviewerId: query.reviewerId as string | undefined,
      page: query.page as number | undefined,
      limit: query.limit as number | undefined,
    };
    return this.accessReviewService.listItems(id, filter);
  }

  @Get('items/:itemId')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get single review item' })
  @ApiResponse({ status: 404, description: 'Item not found' })
  getItem(@Param('itemId') itemId: string) {
    return this.accessReviewService.getItem(itemId);
  }

  @Post('items/:itemId/decide')
  @Roles('operator')
  @ApiOperation({ summary: 'Approve or revoke review item' })
  @ApiResponse({ status: 400, description: 'Item already decided or missing justification' })
  @ApiResponse({ status: 404, description: 'Item not found' })
  @ApiResponse({ status: 409, description: 'The campaign was cancelled: its items are closed' })
  decide(
    @Param('itemId') itemId: string,
    @Body() body: DecideBodyDto,
    @AuthUser() user?: AuthUserType,
  ) {
    return this.accessReviewService.decide(
      itemId,
      body.decision,
      user?.email || 'operator',
      body.justification,
    );
  }

  @Get('my-reviews')
  @Roles('viewer')
  @ApiOperation({
    summary: 'Get review items assigned to current user (not those of cancelled campaigns)',
  })
  getMyReviews(
    @AuthUser() user?: AuthUserType,
    @Query('decision') decision?: ReviewDecision,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const reviewerId = user?.email || 'unknown';
    return this.accessReviewService.getMyReviews(reviewerId, { decision, page, limit });
  }
}
