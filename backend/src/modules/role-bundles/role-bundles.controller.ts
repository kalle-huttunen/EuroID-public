import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { RoleBundlesService } from './role-bundles.service';
import { CreateRoleBundleSchema, UpdateRoleBundleSchema } from './dtos/role-bundle-validation';
import { ZodError } from 'zod';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';

/**
 * REST API for role bundle CRUD. Used by policy editor for reusable action sets.
 */
@ApiTags('Role Bundles')
@ApiBearerAuth('jwt')
@Controller('role-bundles')
export class RoleBundlesController {
  constructor(private readonly roleBundlesService: RoleBundlesService) {}

  @Get()
  @Roles('viewer')
  @ApiOperation({ summary: 'List all role bundles' })
  @ApiResponse({ status: 200, description: 'List of role bundles.' })
  findAll() {
    return this.roleBundlesService.findAll();
  }

  @Get(':id/resolved')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get resolved actions (with inheritance)' })
  @ApiResponse({ status: 200, description: 'Resolved actions from bundle and parents.' })
  @ApiResponse({ status: 404, description: 'Role bundle not found.' })
  async getResolved(@Param('id', ParseObjectIdPipe) id: string) {
    const bundle = await this.roleBundlesService.findOne(id);
    if (!bundle) throw new NotFoundException('Role bundle not found');
    const actions = await this.roleBundlesService.resolveWithInheritance(id);
    return { actions };
  }

  @Get(':id')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get role bundle by ID' })
  @ApiResponse({ status: 200, description: 'Role bundle found.' })
  @ApiResponse({ status: 404, description: 'Role bundle not found.' })
  async findOne(@Param('id', ParseObjectIdPipe) id: string) {
    const bundle = await this.roleBundlesService.findOne(id);
    if (!bundle) throw new NotFoundException('Role bundle not found');
    return bundle;
  }

  @Post()
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Create a role bundle' })
  @ApiResponse({ status: 201, description: 'Role bundle created.' })
  async create(@Body() body: unknown, @AuthUser() authUser?: AuthUserType) {
    try {
      const validated = CreateRoleBundleSchema.parse(body);
      return this.roleBundlesService.create(validated, authUser?.email);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(err.errors);
      }
      throw err;
    }
  }

  @Patch(':id')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Update a role bundle' })
  @ApiResponse({ status: 200, description: 'Role bundle updated.' })
  @ApiResponse({ status: 404, description: 'Role bundle not found.' })
  async update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() body: unknown,
    @AuthUser() authUser?: AuthUserType,
  ) {
    try {
      const validated = UpdateRoleBundleSchema.parse(body);
      return this.roleBundlesService.update(id, validated, authUser?.email);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(err.errors);
      }
      throw err;
    }
  }

  @Delete(':id')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Delete a role bundle' })
  @ApiResponse({ status: 200, description: 'Role bundle deleted.' })
  @ApiResponse({ status: 404, description: 'Role bundle not found.' })
  delete(@Param('id', ParseObjectIdPipe) id: string, @AuthUser() authUser?: AuthUserType) {
    return this.roleBundlesService.delete(id, authUser?.email);
  }
}
