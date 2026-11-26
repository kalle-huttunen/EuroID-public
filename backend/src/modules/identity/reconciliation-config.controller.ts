import { Controller, Get, Put, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { UpsertReconciliationConfigSchema } from './dtos/reconciliation-config.dto';
import { ContractCriticalMasteryService } from './contract-critical-mastery.service';

/**
 * Admin endpoint for per-tenant reconciliation configuration.
 */
@ApiTags('Admin')
@ApiBearerAuth('jwt')
@Controller('admin/reconciliation-config')
export class ReconciliationConfigController {
  constructor(
    private readonly reconConfigService: ReconciliationConfigService,
    private readonly contractCriticalMastery: ContractCriticalMasteryService,
  ) {}

  @Get()
  @Roles('policy-admin', 'super-admin')
  @ApiOperation({ summary: 'Get tenant reconciliation config' })
  async getConfig(@AuthUser() user: AuthUserType) {
    const config = await this.reconConfigService.getConfig(user.tenantId);
    if (!config) return { configured: false, config: null };
    return { configured: true, config };
  }

  @Put()
  @Roles('policy-admin', 'super-admin')
  @ApiOperation({ summary: 'Upsert tenant reconciliation config' })
  @ApiResponse({ status: 200, description: '{ success: true, config }' })
  @ApiResponse({
    status: 400,
    description:
      'Invalid config, nothing saved: one message per invalid field, or a default mastery entry ' +
      'of a contract-critical field that names a source other than the primary HR contract (a ' +
      'secondary HR source or a target), with the hint to choose the primary through Contract ' +
      'Tag and priority.',
  })
  async upsertConfig(@AuthUser() user: AuthUserType, @Body() body: unknown) {
    const parsed = UpsertReconciliationConfigSchema.parse(body);
    await this.contractCriticalMastery.assertReconConfig(parsed);
    const config = await this.reconConfigService.upsertConfig(user.tenantId, parsed);
    return { success: true, config };
  }
}
