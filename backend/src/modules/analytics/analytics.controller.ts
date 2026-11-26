/**
 * Predictive Analytics Controller
 *
 * REST API for offboarding blast radius, license forecasting,
 * and seasonal pattern detection.
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { PredictiveAnalyticsService } from './analytics.service';
import { AnalyticsSearchService } from './analytics-search.service';
import { AnalyticsIndexerService } from './analytics-indexer.service';
import { z, ZodError } from 'zod';

const DAYS_AHEAD_MAX = 365;
const SYSTEM_MAX_LEN = 100;
const LICENSE_MAX_LEN = 200;

const UpcomingOffboardingsQuerySchema = z.object({
  daysAhead: z.coerce.number().int().min(1).max(DAYS_AHEAD_MAX).default(30),
  refresh: z.string().optional(),
});

const LicenseForecastQuerySchema = z.object({
  daysAhead: z.coerce.number().int().min(1).max(DAYS_AHEAD_MAX).default(90),
});

const RefreshQuerySchema = z.object({
  daysAhead: z.coerce.number().int().min(1).max(DAYS_AHEAD_MAX).default(30),
});

const AuditSearchQuerySchema = z.object({
  text: z.string().max(500).optional(),
  action: z.string().max(100).optional(),
  actor: z.string().max(200).optional(),
  targetSystem: z.string().max(SYSTEM_MAX_LEN).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(0).max(1000).default(0),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

@ApiTags('Predictive Analytics')
@ApiBearerAuth('jwt')
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analyticsService: PredictiveAnalyticsService,
    private readonly searchService: AnalyticsSearchService,
    private readonly indexerService: AnalyticsIndexerService,
  ) {}

  @Get('upcoming-offboardings')
  @Roles('viewer')
  @ApiOperation({ summary: 'List pre-computed upcoming offboardings' })
  @ApiQuery({
    name: 'daysAhead',
    required: false,
    type: Number,
    description: 'Days ahead to look (default 30, max 365)',
  })
  @ApiQuery({
    name: 'refresh',
    required: false,
    type: Boolean,
    description:
      'Compute every blast radius again (super-admin only, like POST /analytics/refresh; ' +
      'ignored for other roles). Without it the list is still current: entries not cached, ' +
      'stale or with another end date are computed',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async getUpcomingOffboardings(
    @Query() query: Record<string, unknown>,
    @AuthUser() user?: AuthUserType,
  ) {
    const parsed = UpcomingOffboardingsQuerySchema.parse(query);
    // A full recompute is a policy evaluation per leaver: as heavy as POST /refresh
    const doRefresh =
      (parsed.refresh === 'true' || parsed.refresh === '1') &&
      (user?.roles ?? []).includes('super-admin');
    return this.analyticsService.getUpcomingOffboardings(parsed.daysAhead, doRefresh);
  }

  @Get('upcoming-offboardings/:identityId')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get single identity blast radius' })
  @ApiResponse({ status: 404, description: 'Identity not found' })
  async getUpcomingOffboardingByIdentity(@Param('identityId') identityId: string) {
    const result = await this.analyticsService.getUpcomingOffboardingByIdentity(identityId);
    if (!result) {
      throw new NotFoundException('Identity not found or has no endDate');
    }
    return result;
  }

  @Get('license-forecast')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get all license forecasts, sorted by days to capacity' })
  @ApiQuery({
    name: 'daysAhead',
    required: false,
    type: Number,
    description: 'Forecast horizon (default 90, max 365)',
  })
  async getLicenseForecast(@Query() query: Record<string, unknown>) {
    const parsed = LicenseForecastQuerySchema.parse(query);
    return this.analyticsService.getLicenseSummary(parsed.daysAhead);
  }

  @Get('license-forecast/:system/:license')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get specific license forecast' })
  @ApiQuery({
    name: 'daysAhead',
    required: false,
    type: Number,
    description: 'Forecast horizon (default 90, max 365)',
  })
  async getLicenseForecastForLicense(
    @Param('system') system: string,
    @Param('license') license: string,
    @Query() query: Record<string, unknown>,
  ) {
    if (system.length > SYSTEM_MAX_LEN || license.length > LICENSE_MAX_LEN) {
      throw new BadRequestException('system and license must not exceed max length');
    }
    const parsed = LicenseForecastQuerySchema.parse(query);
    return this.analyticsService.forecastLicenseConsumption(system, license, parsed.daysAhead);
  }

  @Get('seasonal-patterns')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get seasonal onboarding patterns' })
  async getSeasonalPatterns() {
    return this.analyticsService.detectSeasonalPatterns();
  }

  @Post('refresh')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Trigger pre-computation refresh (super-admin only)' })
  @ApiQuery({
    name: 'daysAhead',
    required: false,
    type: Number,
    description: 'Days ahead (default 30, max 365)',
  })
  @ApiResponse({ status: 403, description: 'Requires super-admin role' })
  async refresh(@Query() query: Record<string, unknown>) {
    let parsed: z.infer<typeof RefreshQuerySchema>;
    try {
      parsed = RefreshQuerySchema.parse(query);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException(
          `Validation failed: ${error.errors.map((e) => e.message).join(', ')}`,
        );
      }
      throw error;
    }
    return this.analyticsService.preComputeUpcomingOffboardings(parsed.daysAhead);
  }

  // ── v2: Elasticsearch-backed endpoints ──────────────────────────────

  @Get('v2/search')
  @Roles('viewer')
  @ApiOperation({ summary: 'Full-text search across audit events (ES-backed)' })
  @ApiQuery({ name: 'text', required: false, type: String })
  @ApiQuery({ name: 'action', required: false, type: String })
  @ApiQuery({ name: 'actor', required: false, type: String })
  @ApiQuery({ name: 'targetSystem', required: false, type: String })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'ISO date' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'ISO date' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  async searchAuditEvents(@Query() query: Record<string, unknown>) {
    if (!this.searchService.isAvailable()) {
      throw new BadRequestException(
        'Elasticsearch is not available. Use MongoDB-backed endpoints.',
      );
    }
    const parsed = AuditSearchQuerySchema.parse(query);
    return this.searchService.searchAuditEvents(parsed);
  }

  @Get('v2/seasonal-patterns')
  @Roles('viewer')
  @ApiOperation({ summary: 'Seasonal onboarding patterns via ES aggregations' })
  async getSeasonalPatternsV2() {
    if (!this.searchService.isAvailable()) {
      return this.analyticsService.detectSeasonalPatterns();
    }
    return this.searchService.detectSeasonalPatternsES();
  }

  @Get('v2/status')
  @Roles('viewer')
  @ApiOperation({ summary: 'ES analytics status (availability + indexed event count)' })
  async getEsStatus() {
    const available = this.searchService.isAvailable();
    const indexedEvents = available ? await this.searchService.getIndexedEventCount() : 0;
    return { elasticsearch: available, indexedEvents };
  }

  @Post('v2/backfill')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Backfill audit events from MongoDB into Elasticsearch' })
  @ApiResponse({ status: 403, description: 'Requires super-admin role' })
  async backfill() {
    if (!this.searchService.isAvailable()) {
      throw new BadRequestException('Elasticsearch is not available');
    }
    return this.indexerService.backfillFromMongo();
  }
}
