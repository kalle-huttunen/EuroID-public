import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { EntitlementCatalogService } from './entitlement-catalog.service';
import { EntitlementOrigin } from './schemas/entitlement-catalog.schema';
import { UpdateGovernanceTagsSchema } from './dtos/update-tags.dto';
import { z, ZodError } from 'zod';

const RequestableQuerySchema = z.object({
  category: z.string().max(200).optional(),
  search: z.string().max(500).optional(),
  system: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const ListQuerySchema = z.object({
  system: z.string().max(200),
  origin: z.enum(['POLICY', 'EXTERNAL']).optional(),
  type: z.enum(['Group', 'License', 'DirectoryRole']).optional(),
});

/**
 * REST API for entitlement catalog listing (Policy vs External origin).
 */
@ApiTags('Entitlement Catalog')
@ApiBearerAuth('jwt')
@Controller('entitlement-catalog')
export class EntitlementCatalogController {
  constructor(private readonly catalog: EntitlementCatalogService) {}

  @Get('requestable')
  @Roles('viewer')
  @ApiOperation({ summary: 'List requestable catalog entries for Access Request Portal' })
  async listRequestable(
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('system') system?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    let parsed: z.infer<typeof RequestableQuerySchema>;
    try {
      parsed = RequestableQuerySchema.parse({ category, search, system, page, limit });
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException(
          `Validation failed: ${error.errors.map((e) => e.message).join(', ')}`,
        );
      }
      throw error;
    }
    const tenantId = getCurrentTenantId();
    const result = await this.catalog.listRequestable(tenantId, {
      category: parsed.category,
      search: parsed.search,
      system: parsed.system,
      page: parsed.page,
      limit: parsed.limit,
    });
    return result;
  }

  @Get()
  @Roles('viewer')
  @ApiOperation({
    summary: 'List entitlements by system (for UI Source column: Policy vs External)',
  })
  async list(
    @Query('system') system: string,
    @Query('origin') origin?: string,
    @Query('type') type?: string,
  ) {
    if (!system) return { entitlements: [], count: 0 };
    let parsed: z.infer<typeof ListQuerySchema>;
    try {
      parsed = ListQuerySchema.parse({ system, origin, type });
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException(
          `Validation failed: ${error.errors.map((e) => e.message).join(', ')}`,
        );
      }
      throw error;
    }
    const options: { origin?: EntitlementOrigin; type?: 'Group' | 'License' | 'DirectoryRole' } =
      {};
    if (parsed.origin) options.origin = parsed.origin;
    if (parsed.type) options.type = parsed.type;
    const entitlements = await this.catalog.list(
      parsed.system,
      Object.keys(options).length ? options : undefined,
    );
    return {
      entitlements: entitlements.map((e) => ({
        nativeId: e.nativeId,
        name: e.name,
        type: e.type,
        origin: e.origin,
        governanceLevel: e.governanceLevel,
        ...(e.adminTier && { adminTier: e.adminTier }),
      })),
      count: entitlements.length,
    };
  }

  @Patch(':id/tags')
  @Roles('super-admin', 'policy-admin')
  @ApiOperation({ summary: 'Update governance tags for a catalog entry' })
  async setTags(@Param('id', ParseObjectIdPipe) id: string, @Body() body: unknown) {
    const parsed = UpdateGovernanceTagsSchema.parse(body);
    const doc = await this.catalog.setTags(id, parsed.governanceTags);
    if (!doc) throw new NotFoundException('Entitlement catalog entry not found');
    return {
      id: doc._id,
      nativeId: doc.nativeId,
      name: doc.name,
      type: doc.type,
      origin: doc.origin,
      governanceLevel: doc.governanceLevel,
      governanceTags: doc.governanceTags ?? [],
    };
  }
}
