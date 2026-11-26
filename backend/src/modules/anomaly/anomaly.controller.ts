/**
 * Anomaly Detection Controller
 *
 * REST API for the anomaly detection dashboard.
 */

import { Controller, Get, Post, Param, Query, Body, BadRequestException } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiBearerAuth,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { AccessAnomalyService, AnomalyFilter } from './anomaly.service';
import { ParsePublicIdPipe } from '@shared/pipes/parse-public-id.pipe';
import type { AnomalyType, AnomalyStatus } from './schemas/anomaly.schema';
import { z, ZodError } from 'zod';

const AnalyzeBodySchema = z
  .object({
    identityId: z.string().max(100).optional(),
    page: z.number().int().min(1).max(10000).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .optional();

const DismissBodySchema = z
  .object({
    reason: z.string().max(1000).optional(),
  })
  .optional();

const ListQuerySchema = z.object({
  identityId: z.string().max(100).optional(),
  type: z.union([z.string(), z.array(z.string())]).optional(),
  severity: z.union([z.string(), z.array(z.string())]).optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const RiskScoresQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

/**
 * `:id` is the anomaly's `anomalyId` (UUID), the id its events carry. The document `_id`
 * (ObjectId) is still accepted: the Risk dashboard of the previous release sends it.
 */
const ANOMALY_ID = new ParsePublicIdPipe({ acceptObjectId: true });
const ANOMALY_ID_PARAM = {
  name: 'id',
  description: "The anomaly's anomalyId (UUID); its document _id (ObjectId) is also accepted",
};
const STATUS_CONFLICT = {
  status: 409,
  description:
    'The current status does not allow this change (resolved and dismissed are final); the ' +
    'message names the current status. Nothing changes and no event is emitted.',
};

@ApiTags('Anomaly Detection')
@ApiBearerAuth('jwt')
@Controller('anomalies')
export class AnomalyController {
  constructor(private readonly anomalyService: AccessAnomalyService) {}

  @Get()
  @Roles('viewer')
  @ApiOperation({ summary: 'List anomalies with filters and pagination' })
  @ApiQuery({ name: 'identityId', required: false, description: 'Filter by identity ID' })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by anomaly type' })
  @ApiQuery({ name: 'severity', required: false, description: 'Filter by severity' })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by status' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async list(@Query() query: Record<string, unknown>) {
    const parsed = ListQuerySchema.parse(query);
    const filter: AnomalyFilter = {};
    if (parsed.identityId) filter.identityId = parsed.identityId;
    if (parsed.type) {
      filter.type = Array.isArray(parsed.type)
        ? (parsed.type as AnomalyType[])
        : (parsed.type as AnomalyType);
    }
    if (parsed.severity) {
      filter.severity = Array.isArray(parsed.severity) ? parsed.severity : [parsed.severity];
    }
    if (parsed.status) filter.status = parsed.status as AnomalyStatus;

    return this.anomalyService.list(filter, parsed.page, parsed.limit);
  }

  @Get('risk-scores')
  @Roles('viewer')
  @ApiOperation({ summary: 'List identities with risk scores, sorted descending' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getRiskScores(@Query() query: Record<string, unknown>) {
    const parsed = RiskScoresQuerySchema.parse(query);
    return this.anomalyService.getRiskScores(parsed.limit);
  }

  @Post('analyze')
  @Roles('super-admin')
  @ApiOperation({
    summary: 'Trigger anomaly analysis (super-admin only)',
    description:
      'Body `{ identityId?, page?, limit? }`. With `identityId` one identity; without it one ' +
      'page (1-based, default 1) of `limit` identities (default 50).',
  })
  @ApiResponse({
    status: 201,
    description:
      '`{ analyzed, totalIdentities, anomaliesCreated, identityIds, ruleFailures: { rules, ' +
      'identities, byRule } }`: `analyzed` of `totalIdentities` identities ran the rules; ' +
      '`ruleFailures` counts the rules that threw (distinct rules, identities affected, ' +
      'identities per rule). A failed rule is not "nothing found".',
  })
  async analyze(@Body() body?: unknown) {
    let parsed: z.infer<typeof AnalyzeBodySchema>;
    try {
      parsed = AnalyzeBodySchema.parse(body);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException(
          `Validation failed: ${error.errors.map((e) => e.message).join(', ')}`,
        );
      }
      throw error;
    }
    return this.anomalyService.runAnalysis({
      identityId: parsed?.identityId,
      page: parsed?.page,
      limit: parsed?.limit,
    });
  }

  @Get(':id')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get single anomaly detail' })
  @ApiParam(ANOMALY_ID_PARAM)
  @ApiResponse({ status: 404, description: 'No such anomaly in the tenant' })
  async getOne(@Param('id', ANOMALY_ID) id: string) {
    return this.anomalyService.findOne(id);
  }

  @Post(':id/acknowledge')
  @Roles('operator')
  @ApiOperation({ summary: 'Mark an open anomaly as acknowledged' })
  @ApiParam(ANOMALY_ID_PARAM)
  @ApiResponse({ status: 404, description: 'No such anomaly in the tenant' })
  @ApiResponse(STATUS_CONFLICT)
  async acknowledge(@Param('id', ANOMALY_ID) id: string, @AuthUser() authUser?: AuthUserType) {
    return this.anomalyService.acknowledge(id, authUser?.email || 'operator');
  }

  @Post(':id/dismiss')
  @Roles('operator')
  @ApiOperation({ summary: 'Mark an open or acknowledged anomaly as dismissed with reason' })
  @ApiParam(ANOMALY_ID_PARAM)
  @ApiResponse({ status: 404, description: 'No such anomaly in the tenant' })
  @ApiResponse(STATUS_CONFLICT)
  async dismiss(
    @Param('id', ANOMALY_ID) id: string,
    @Body() body?: unknown,
    @AuthUser() authUser?: AuthUserType,
  ) {
    let parsed: z.infer<typeof DismissBodySchema>;
    try {
      parsed = DismissBodySchema.parse(body);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException(
          `Validation failed: ${error.errors.map((e) => e.message).join(', ')}`,
        );
      }
      throw error;
    }
    return this.anomalyService.dismiss(id, parsed?.reason, authUser?.email || authUser?.sub);
  }

  @Post(':id/resolve')
  @Roles('operator')
  @ApiOperation({ summary: 'Mark an open or acknowledged anomaly as resolved' })
  @ApiParam(ANOMALY_ID_PARAM)
  @ApiResponse({ status: 404, description: 'No such anomaly in the tenant' })
  @ApiResponse(STATUS_CONFLICT)
  async resolve(@Param('id', ANOMALY_ID) id: string, @AuthUser() authUser?: AuthUserType) {
    return this.anomalyService.resolve(id, authUser?.email || authUser?.sub);
  }
}
