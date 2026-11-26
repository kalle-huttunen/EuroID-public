/**
 * Intelligence Controller
 *
 * REST API for AI access intelligence features:
 *   GET  /api/v1/intelligence/reviewer-quality             — all reviewer scores
 *   GET  /api/v1/intelligence/reviewer-quality/:campaignId — per-campaign scores
 *   GET  /api/v1/intelligence/peer-groups                  — list peer groups
 *   GET  /api/v1/intelligence/peer-groups/:groupKey/outliers — outliers in group
 *   GET  /api/v1/intelligence/recommendations/:identityId  — recommended entitlements
 *   POST /api/v1/intelligence/unusual-check                — check if request is unusual
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { IntelligenceService } from './intelligence.service';
import { z, ZodError } from 'zod';

// ── Zod Schemas ───────────────────────────────────────────────────────

const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const UnusualCheckSchema = z.object({
  identityId: z.string().min(1).max(200),
  entitlementId: z.string().min(1).max(500),
});

// ── Controller ────────────────────────────────────────────────────────

@ApiTags('Intelligence')
@ApiBearerAuth('jwt')
@Controller('intelligence')
export class IntelligenceController {
  private readonly logger = new Logger(IntelligenceController.name);

  constructor(private readonly intelligenceService: IntelligenceService) {}

  // ── F-12: Reviewer Quality ────────────────────────────────────────

  @Get('reviewer-quality')
  @Roles('super-admin')
  @ApiOperation({ summary: 'All reviewer quality scores' })
  @ApiQuery({ name: 'campaignId', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getReviewerScores(
    @Query('campaignId') campaignId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = getCurrentTenantId();
    try {
      const parsed = PaginationSchema.parse({ page, limit });
      return this.intelligenceService.getReviewerScores(
        tenantId,
        campaignId,
        parsed.page,
        parsed.limit,
      );
    } catch (err: unknown) {
      if (err instanceof ZodError) throw new BadRequestException(err.errors);
      throw err;
    }
  }

  @Get('reviewer-quality/:campaignId')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Reviewer quality scores for a campaign' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getReviewerScoresByCampaign(
    @Param('campaignId') campaignId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = getCurrentTenantId();
    try {
      const parsed = PaginationSchema.parse({ page, limit });
      return this.intelligenceService.getReviewerScores(
        tenantId,
        campaignId,
        parsed.page,
        parsed.limit,
      );
    } catch (err: unknown) {
      if (err instanceof ZodError) throw new BadRequestException(err.errors);
      throw err;
    }
  }

  // ── F-13: Peer Groups ─────────────────────────────────────────────

  @Get('peer-groups')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'List peer groups with stats' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getPeerGroups(@Query('page') page?: string, @Query('limit') limit?: string) {
    const tenantId = getCurrentTenantId();
    try {
      const parsed = PaginationSchema.parse({ page, limit });
      return this.intelligenceService.getPeerGroups(tenantId, parsed.page, parsed.limit);
    } catch (err: unknown) {
      if (err instanceof ZodError) throw new BadRequestException(err.errors);
      throw err;
    }
  }

  @Get('peer-groups/:groupKey/outliers')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Outlier identities in a peer group' })
  async getGroupOutliers(@Param('groupKey') groupKey: string) {
    const tenantId = getCurrentTenantId();
    return this.intelligenceService.getGroupOutliers(tenantId, groupKey);
  }

  // ── F-14: Recommendations ─────────────────────────────────────────

  @Get('recommendations/:identityId')
  @Roles('operator')
  @ApiOperation({ summary: 'Recommended entitlements for identity based on peer group' })
  async getRecommendations(@Param('identityId') identityId: string) {
    const tenantId = getCurrentTenantId();
    return this.intelligenceService.getRecommendations(tenantId, identityId);
  }

  @Post('unusual-check')
  @Roles('operator')
  @ApiOperation({ summary: 'Check if access request is unusual for peer group' })
  async checkUnusualRequest(@Body() body: unknown) {
    const tenantId = getCurrentTenantId();
    try {
      const parsed = UnusualCheckSchema.parse(body);
      return this.intelligenceService.getUnusualRequestWarning(
        tenantId,
        parsed.identityId,
        parsed.entitlementId,
      );
    } catch (err: unknown) {
      if (err instanceof ZodError) throw new BadRequestException(err.errors);
      throw err;
    }
  }
}
