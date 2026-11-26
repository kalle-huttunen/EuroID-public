import { Controller, Get, Post, Patch, Delete, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { PLATFORM_ADMIN_ROLE } from '../auth/platform-admin';
import { SystemOperation } from './system-operation.decorator';
import { AuthUser } from '../auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '../auth/auth-user.decorator';
import { TenantService } from './tenant.service';
import { CreateTenantBodyDto, MigrateTenantBodyDto, UpdateTenantBodyDto } from './tenant.dtos';

/**
 * Tenant management spans every tenant, so it belongs to the platform admin (deployment
 * configuration, see auth/platform-admin.ts), not to any tenant's super-admin. AuthModule's
 * global guards (JwtAuthGuard, RolesGuard) check it; declaring them here ran them twice.
 */
@Controller('tenants')
@ApiTags('Tenant Management')
@ApiBearerAuth('jwt')
@Roles(PLATFORM_ADMIN_ROLE)
@ApiResponse({ status: 403, description: 'Forbidden — requires platform-admin' })
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  @Post()
  @SystemOperation()
  @ApiOperation({ summary: 'Create a new tenant' })
  async create(@Body() dto: CreateTenantBodyDto, @AuthUser() user?: AuthUserType) {
    return this.tenantService.create({
      tenantId: dto.tenantId,
      name: dto.name,
      // The authenticated platform admin, never a body value.
      createdBy: user?.email || user?.sub || 'system',
    });
  }

  @Get()
  @SystemOperation()
  @ApiOperation({ summary: 'List all tenants' })
  async findAll() {
    return this.tenantService.findAll();
  }

  @Post('migrate')
  @SystemOperation()
  @ApiOperation({
    summary: 'Assign documents stored without a tenant to an existing tenant',
    description:
      'Body: { targetTenantId, dryRun? }. dryRun defaults to true and only counts per collection. Audit events and the documents of a live tenant (`default` included) never move.',
  })
  @ApiResponse({
    status: 201,
    description:
      '{ dryRun, targetTenantId, collections }: per collection, the documents it would move (dry run) or moved',
  })
  @ApiResponse({ status: 404, description: 'The target is not a tenant' })
  async migrate(@Body() body: MigrateTenantBodyDto) {
    return this.tenantService.migrateDatabase(body.targetTenantId, body.dryRun);
  }

  @Get(':id')
  @SystemOperation()
  @ApiOperation({ summary: 'Get tenant by ID' })
  async findById(@Param('id') id: string) {
    return this.tenantService.findById(id);
  }

  @Patch(':id')
  @SystemOperation()
  @ApiOperation({ summary: 'Update tenant' })
  async update(@Param('id') id: string, @Body() dto: UpdateTenantBodyDto) {
    return this.tenantService.update(id, dto);
  }

  @Delete(':id')
  @SystemOperation()
  @ApiOperation({ summary: 'Suspend tenant' })
  async suspend(@Param('id') id: string) {
    return this.tenantService.suspend(id);
  }
}
