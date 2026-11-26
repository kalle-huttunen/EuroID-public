/**
 * Credential Lifecycle Controller
 *
 * REST API for credential inventory queries and credential policy management.
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { CredentialInventoryService } from './credential-inventory.service';
import { CredentialPolicyService } from './credential-policy.service';
import {
  CreateCredentialPolicySchema,
  UpdateCredentialPolicySchema,
  ExpiringQuerySchema,
  InventoryStatusQuerySchema,
} from './dtos/credential-lifecycle.dto';

@ApiTags('Credential Lifecycle')
@ApiBearerAuth('jwt')
@Controller('credential-lifecycle')
export class CredentialLifecycleController {
  constructor(
    private readonly inventoryService: CredentialInventoryService,
    private readonly policyService: CredentialPolicyService,
  ) {}

  // ── Inventory Endpoints ─────────────────────────────────────────────

  @Get('inventory')
  @Roles('operator')
  @ApiOperation({
    summary: 'List credentials in one password status (e.g. UNKNOWN with the reason)',
    description:
      'Query `status` (COMPLIANT, EXPIRING_SOON, EXPIRED, UNKNOWN), `limit` 1-1000 (default 100). ' +
      'Earliest due date first. UNKNOWN rows carry `password.statusReason`.',
  })
  async listByStatus(@Query('status') status?: string, @Query('limit') limit?: string) {
    const parsed = InventoryStatusQuerySchema.parse({ status, limit });
    const tenantId = getCurrentTenantId();
    return this.inventoryService.findByStatus(tenantId, parsed.status, parsed.limit);
  }

  @Get('inventory/:identityId')
  @Roles('operator')
  @ApiOperation({ summary: 'Get credential state for an identity across all target systems' })
  async getInventoryForIdentity(@Param('identityId') identityId: string) {
    const tenantId = getCurrentTenantId();
    return this.inventoryService.findByIdentity(tenantId, identityId);
  }

  @Get('inventory/:identityId/:targetSystem')
  @Roles('operator')
  @ApiOperation({ summary: 'Get credential state for a specific identity + target system' })
  async getInventoryForIdentityTarget(
    @Param('identityId') identityId: string,
    @Param('targetSystem') targetSystem: string,
  ) {
    const tenantId = getCurrentTenantId();
    const doc = await this.inventoryService.findByIdentityAndTarget(
      tenantId,
      identityId,
      targetSystem,
    );
    if (!doc) {
      throw new NotFoundException(
        `Credential inventory for ${identityId}/${targetSystem} not found`,
      );
    }
    return doc;
  }

  @Get('expiring')
  @Roles('operator')
  @ApiOperation({
    summary: 'List credentials due within N days (overdue included), earliest first',
  })
  async getExpiring(@Query('daysAhead') daysAhead?: string, @Query('limit') limit?: string) {
    const parsed = ExpiringQuerySchema.parse({ daysAhead, limit });
    const tenantId = getCurrentTenantId();
    const beforeDate = new Date(Date.now() + parsed.daysAhead * 86_400_000);
    return this.inventoryService.findExpiring(tenantId, beforeDate, parsed.limit);
  }

  @Get('compliance')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Credential compliance summary (aggregate counts by status)' })
  async getComplianceSummary() {
    const tenantId = getCurrentTenantId();
    return this.inventoryService.getComplianceSummary(tenantId);
  }

  // ── Policy Endpoints ───────────────────────────────────────────────

  @Post('policies')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Create a credential policy' })
  async createPolicy(@Body() body: unknown) {
    const dto = CreateCredentialPolicySchema.parse(body);
    const tenantId = getCurrentTenantId();
    return this.policyService.create(tenantId, dto);
  }

  @Get('policies')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'List all credential policies' })
  async listPolicies() {
    const tenantId = getCurrentTenantId();
    return this.policyService.findAll(tenantId);
  }

  @Get('policies/:id')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Get a credential policy by ID' })
  async getPolicy(@Param('id') id: string) {
    const tenantId = getCurrentTenantId();
    return this.policyService.findOne(tenantId, id);
  }

  @Patch('policies/:id')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Update a credential policy' })
  async updatePolicy(@Param('id') id: string, @Body() body: unknown) {
    const dto = UpdateCredentialPolicySchema.parse(body);
    const tenantId = getCurrentTenantId();
    return this.policyService.update(tenantId, id, dto);
  }

  @Delete('policies/:id')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Delete a credential policy' })
  async deletePolicy(@Param('id') id: string) {
    const tenantId = getCurrentTenantId();
    await this.policyService.delete(tenantId, id);
    return { deleted: true };
  }
}
