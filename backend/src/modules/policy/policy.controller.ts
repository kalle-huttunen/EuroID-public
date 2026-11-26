import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Logger,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { PolicyService } from './policy.service';
import { PolicyEngineService, SimulationResult } from './policy-engine.service';
import { Policy } from './schemas/policy.schema';
import { CreatePolicyDto } from './dtos/create-policy.dto';
import { UpdatePolicyDto } from './dtos/update-policy.dto';
import { SimulateRequestDto } from './dtos/simulate-request.dto';
import { ReorderRequestDto } from './dtos/reorder-request.dto';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { IDENTITY_QUERY_PORT, IIdentityQueryPort } from '@shared/interfaces/identity-query.port';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';

/**
 * REST API for policy CRUD, simulation, and impact analysis.
 */
@ApiTags('Policy Engine')
@ApiBearerAuth('jwt')
@Controller('policy')
export class PolicyController {
  private readonly logger = new Logger(PolicyController.name);

  constructor(
    private readonly policyService: PolicyService,
    private readonly policyEngineService: PolicyEngineService,
    @Inject(IDENTITY_QUERY_PORT) private readonly identityQuery: IIdentityQueryPort,
  ) {}

  // ── CRUD ──────────────────────────────────────────────────────────

  @Get()
  @Roles('viewer')
  @ApiOperation({ summary: 'List all policies' })
  findAll() {
    return this.policyService.findAll();
  }

  @Get(':id/impact')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get impact count (matched users) for a policy' })
  async getImpact(@Param('id', ParseObjectIdPipe) id: string): Promise<{ matchedCount: number }> {
    const matchedCount = await this.policyEngineService.getImpactCount(id);
    return { matchedCount };
  }

  @Get('evaluate/:identityId')
  @Roles('viewer')
  @ApiOperation({ summary: 'Evaluate all active policies for a single identity' })
  @ApiResponse({ status: 200, description: 'Policy provisioning intent for the identity' })
  @ApiResponse({ status: 404, description: 'Identity not found' })
  async evaluateForIdentity(@Param('identityId', ParseObjectIdPipe) identityId: string) {
    const user = await this.identityQuery.findById(identityId);
    if (!user) throw new NotFoundException('Identity not found');
    return this.policyEngineService.evaluate(user as unknown as StandardUserDto);
  }

  @Get(':id')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get a single policy' })
  findOne(@Param('id', ParseObjectIdPipe) id: string) {
    return this.policyService.findOne(id);
  }

  @Post()
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Create a new policy' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  create(@Body() dto: CreatePolicyDto, @AuthUser() user?: AuthUserType) {
    return this.policyService.create(dto as Partial<Policy>, user?.email);
  }

  @Patch(':id')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Update a policy' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdatePolicyDto,
    @AuthUser() user?: AuthUserType,
  ) {
    return this.policyService.update(id, dto as Partial<Policy>, user?.email);
  }

  @Delete(':id')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Delete a policy' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  remove(@Param('id', ParseObjectIdPipe) id: string, @AuthUser() user?: AuthUserType) {
    return this.policyService.remove(id, user?.email);
  }

  @Post(':id/activate')
  @Roles('policy-admin')
  @ApiOperation({
    summary:
      'Activate a draft/disabled policy (requires a user other than the last editor of its ' +
      'conditions, actions or role bundle, or for a policy never so edited its creator)',
  })
  @ApiResponse({ status: 400, description: 'Policy is already active or in invalid state' })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden (SoD): the caller last edited what the policy grants, or created it and no one ' +
      'has edited that since',
  })
  activate(@Param('id', ParseObjectIdPipe) id: string, @AuthUser() user?: AuthUserType) {
    return this.policyService.activate(id, user?.email ?? 'unknown');
  }

  // ── Toggle & Reorder ──────────────────────────────────────────────

  @Patch(':id/toggle')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Toggle policy active/disabled' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  toggle(@Param('id', ParseObjectIdPipe) id: string, @AuthUser() user?: AuthUserType) {
    return this.policyService.toggleStatus(id, user?.email);
  }

  @Post('reorder')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Reorder policy priorities' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  reorder(@Body() dto: ReorderRequestDto, @AuthUser() user?: AuthUserType) {
    return this.policyService.reorderPriorities(dto.orderedIds, user?.email);
  }

  // ── Simulation ────────────────────────────────────────────────────

  @Post('simulate')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Simulate a policy against Identity Hub users' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  async simulate(@Body() dto: SimulateRequestDto): Promise<SimulationResult> {
    this.logger.log(
      `Simulation requested: ${dto.policyId ? `policy ${dto.policyId}` : 'draft policy'}`,
    );

    if (dto.policyId) {
      return this.policyEngineService.simulate(dto.policyId);
    }

    if (dto.policy) {
      // PE-6: Validate inline policy regex to prevent ReDoS
      this.policyService.validateRegexConditions(dto.policy);
      return this.policyEngineService.simulate(dto.policy);
    }

    // Fallback: empty result
    return {
      totalUsers: 0,
      matchedCount: 0,
      matchPercentage: 0,
      matchedUsers: [],
      actionsBySystem: {},
      totalOperations: 0,
    };
  }
}
