import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { CreateSodPolicySchema } from './dtos/create-sod-policy.dto';
import { UpdateSodPolicySchema } from './dtos/update-sod-policy.dto';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { SodService } from './sod.service';

/**
 * REST API for SoD policy CRUD.
 * Manages toxic entitlement combinations for Segregation of Duties.
 */
@ApiTags('SoD Policies')
@ApiBearerAuth('jwt')
@Controller('sod-policies')
export class SodPolicyController {
  constructor(private readonly sodService: SodService) {}

  private getTenantId(authUser?: AuthUserType): string {
    const tenantId = authUser?.tenantId;
    if (!tenantId) throw new UnauthorizedException('Tenant ID required');
    return tenantId;
  }

  @Get()
  @Roles('viewer')
  @ApiOperation({ summary: 'List all SoD policies for tenant' })
  async findAll(@AuthUser() authUser?: AuthUserType) {
    return this.sodService.findAll(this.getTenantId(authUser));
  }

  @Post()
  @Roles('super-admin', 'policy-admin')
  @ApiOperation({ summary: 'Create a new SoD policy' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — policy-admin or super-admin required' })
  async create(@Body() body: unknown, @AuthUser() authUser?: AuthUserType) {
    const parsed = CreateSodPolicySchema.parse(body);
    return this.sodService.create(this.getTenantId(authUser), parsed);
  }

  @Patch(':id')
  @Roles('super-admin', 'policy-admin')
  @ApiOperation({ summary: 'Update SoD policy (severity, action, isActive)' })
  @ApiResponse({ status: 404, description: 'SoD policy not found' })
  async update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() body: unknown,
    @AuthUser() authUser?: AuthUserType,
  ) {
    const parsed = UpdateSodPolicySchema.parse(body);
    return this.sodService.update(id, this.getTenantId(authUser), parsed);
  }

  @Delete(':id')
  @Roles('super-admin', 'policy-admin')
  @ApiOperation({ summary: 'Soft-delete SoD policy (set isActive: false)' })
  @ApiResponse({ status: 404, description: 'SoD policy not found' })
  async remove(@Param('id', ParseObjectIdPipe) id: string, @AuthUser() authUser?: AuthUserType) {
    return this.sodService.remove(id, this.getTenantId(authUser));
  }
}
