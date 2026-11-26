/**
 * Risk Scoring Controller
 *
 * REST API for risk score dashboard and queries.
 */
import { Controller, Get, Param, Query, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { RiskScoringService } from './risk-scoring.service';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { z } from 'zod';

const TopQuerySchema = z.object({
  top: z.coerce.number().int().min(1).max(500).default(100),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
});

@ApiTags('Risk Scoring')
@ApiBearerAuth('jwt')
@Controller('risk-scores')
export class RiskScoringController {
  constructor(private readonly riskScoringService: RiskScoringService) {}

  @Get('distribution')
  @Roles('viewer')
  @ApiOperation({ summary: 'Risk score distribution histogram' })
  async getDistribution() {
    const tenantId = getCurrentTenantId();
    return this.riskScoringService.getDistribution(tenantId);
  }

  @Get()
  @Roles('viewer')
  @ApiOperation({ summary: 'Top risky users' })
  @ApiQuery({ name: 'top', required: false, type: Number })
  @ApiQuery({ name: 'minScore', required: false, type: Number })
  async getTopRisky(
    @Query('top') top?: string,
    @Query('minScore') minScore?: string,
  ) {
    const parsed = TopQuerySchema.parse({ top, minScore });
    const tenantId = getCurrentTenantId();
    return this.riskScoringService.getTopRisky(
      tenantId,
      parsed.top,
      parsed.minScore,
    );
  }

  @Get(':identityId')
  @Roles('viewer')
  @ApiOperation({ summary: 'Risk score for identity' })
  async getForIdentity(@Param('identityId') identityId: string) {
    const doc = await this.riskScoringService.getForIdentity(identityId);
    if (!doc) throw new NotFoundException(`Risk score for identity ${identityId} not found`);
    return doc;
  }
}
