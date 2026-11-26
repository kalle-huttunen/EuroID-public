import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';
import { UseFilters, UseInterceptors } from '@nestjs/common';
import { Public } from '@infrastructure/auth/public.decorator';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { ScimInboundMapper } from './scim-inbound.mapper';
import { ScimFilterService } from './scim-filter.service';
import { scimBaseUrl } from './scim-base-url';
import { ScimAuth } from './guards/scim-auth.guard';
import { ScimResponseInterceptor } from './interceptors/scim-response.interceptor';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import {
  SCIMErrorFilter,
  SCIMError,
  SCIMGroup,
  SCIMListResponse,
  SCIMPatchOp,
  SCIM_SCHEMAS,
} from '@shared/scim';
import {
  storedMemberRefs,
  toMemberRef,
  toStoredMembers,
  type EntitlementCatalogEntry,
  type ScimMemberRef,
  type StoredScimMembers,
} from './scim-inbound.mapper';
import { z, ZodError } from 'zod';

// ── Zod schemas for SCIM Group @Body() validation (RFC 7643 §4.2) ──
// Uses .passthrough() so extra SCIM attributes are forwarded without being stripped.

const ScimGroupBodySchema = z
  .object({
    schemas: z.array(z.string().max(500)).min(1).max(20),
    displayName: z.string().min(1).max(500),
    externalId: z.string().max(500).optional(),
    members: z
      .array(
        z
          .object({
            value: z.string().min(1).max(500),
            display: z.string().max(500).optional(),
            $ref: z.string().max(2000).optional(),
            type: z.string().max(100).optional(),
          })
          .passthrough(),
      )
      .max(1000)
      .optional(),
  })
  .passthrough();

const ScimGroupPatchOpSchema = z
  .object({
    schemas: z.array(z.string().max(500)).min(1).max(20),
    Operations: z
      .array(
        z.object({
          op: z.enum(['add', 'remove', 'replace']),
          path: z.string().max(500).optional(),
          value: z.unknown().optional(),
        }),
      )
      .min(1)
      .max(1000),
  })
  .passthrough();

const SCIM_SYSTEM = 'scim-inbound';

@Controller('scim/v2/Groups')
@Public()
@ScimAuth('Groups')
@UseFilters(SCIMErrorFilter)
@UseInterceptors(ScimResponseInterceptor)
export class ScimGroupsController {
  constructor(
    private readonly entitlementCatalogService: EntitlementCatalogService,
    private readonly mapper: ScimInboundMapper,
    private readonly filterService: ScimFilterService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /**
   * POST /scim/v2/Groups — Create group
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown, @Req() req: Request) {
    let scimGroup: SCIMGroup;
    try {
      scimGroup = ScimGroupBodySchema.parse(body) as SCIMGroup;
    } catch (error) {
      if (error instanceof ZodError) {
        throw new SCIMError(
          'invalidValue',
          `Validation failed: ${error.errors.map((e) => e.message).join(', ')}`,
          '400',
        );
      }
      throw error;
    }

    const displayName = scimGroup.displayName;

    const entry = this.mapper.toEntitlementEntry(scimGroup);
    const doc = await this.entitlementCatalogService.createScimGroup({
      name: entry.name,
      externalId: entry.metadata?.externalId,
      scimMembers: entry.metadata?.scimMembers,
      scimMemberTypes: entry.metadata?.scimMemberTypes,
    });

    if (!doc) {
      throw new SCIMError(
        'uniqueness',
        `Group with displayName "${displayName}" already exists`,
        '409',
      );
    }

    const baseUrl = scimBaseUrl(req);
    return this.mapper.toSCIMGroupResponse(
      (doc.toObject?.() ?? doc) as unknown as EntitlementCatalogEntry,
      baseUrl,
    );
  }

  /**
   * GET /scim/v2/Groups — List groups
   */
  @Get()
  async list(
    @Req() req: Request,
    @Query('startIndex') startIndex?: string,
    @Query('count') count?: string,
    @Query('filter') filter?: string,
  ) {
    const start = Math.max(1, parseInt(startIndex ?? '1', 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(count ?? '100', 10) || 100));
    const skip = start - 1;

    let mongoFilter: Record<string, unknown> = {};
    if (filter?.trim()) {
      mongoFilter = this.filterService.parseGroupFilter(filter);
    }

    const { data, total } = await this.entitlementCatalogService.listScimGroups(
      mongoFilter,
      skip,
      limit,
    );

    const baseUrl = scimBaseUrl(req);
    const resources = data.map((e) =>
      this.mapper.toSCIMGroupResponse(
        (e.toObject?.() ?? e) as unknown as EntitlementCatalogEntry,
        baseUrl,
      ),
    );

    const response: SCIMListResponse<SCIMGroup> = {
      schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
      totalResults: total,
      startIndex: start,
      itemsPerPage: resources.length,
      Resources: resources,
    };
    return response;
  }

  /**
   * GET /scim/v2/Groups/:id — Get group with members
   */
  @Get(':id')
  async getById(@Param('id') id: string, @Req() req: Request) {
    const doc = await this.entitlementCatalogService.findById(id);
    if (!doc) {
      throw new SCIMError(undefined, 'Group not found', '404');
    }
    const baseUrl = scimBaseUrl(req);
    return this.mapper.toSCIMGroupResponse(
      (doc.toObject?.() ?? doc) as unknown as EntitlementCatalogEntry,
      baseUrl,
    );
  }

  /**
   * PUT /scim/v2/Groups/:id — Replace group
   */
  @Put(':id')
  async replace(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    let scimGroup: SCIMGroup;
    try {
      scimGroup = ScimGroupBodySchema.parse(body) as SCIMGroup;
    } catch (error) {
      if (error instanceof ZodError) {
        throw new SCIMError(
          'invalidValue',
          `Validation failed: ${error.errors.map((e) => e.message).join(', ')}`,
          '400',
        );
      }
      throw error;
    }

    const existing = await this.entitlementCatalogService.findById(id);
    if (!existing) {
      throw new SCIMError(undefined, 'Group not found', '404');
    }

    const entry = this.mapper.toEntitlementEntry(scimGroup);
    const doc = await this.entitlementCatalogService.updateScimGroup(id, {
      name: entry.name,
      externalId: entry.metadata?.externalId,
      scimMembers: entry.metadata?.scimMembers,
      scimMemberTypes: entry.metadata?.scimMemberTypes,
    });

    if (!doc) {
      throw new SCIMError(undefined, 'Group not found', '404');
    }

    this.emitEntitlementUpdated(id, doc);

    const baseUrl = scimBaseUrl(req);
    return this.mapper.toSCIMGroupResponse(
      (doc.toObject?.() ?? doc) as unknown as EntitlementCatalogEntry,
      baseUrl,
    );
  }

  /**
   * PATCH /scim/v2/Groups/:id — Partial update (add/remove members, replace displayName)
   */
  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    let patchOp: SCIMPatchOp;
    try {
      patchOp = ScimGroupPatchOpSchema.parse(body) as SCIMPatchOp;
    } catch (error) {
      if (error instanceof ZodError) {
        throw new SCIMError(
          'invalidValue',
          `Validation failed: ${error.errors.map((e) => e.message).join(', ')}`,
          '400',
        );
      }
      throw error;
    }

    const existing = await this.entitlementCatalogService.findById(id);
    if (!existing) {
      throw new SCIMError(undefined, 'Group not found', '404');
    }

    const obj = existing.toObject?.() ?? (existing as unknown as Record<string, unknown>);
    // Each member keeps the type the IdP sent it with (User or Group); one without stays a user
    let members: ScimMemberRef[] = storedMemberRefs(
      obj.metadata as Partial<StoredScimMembers> | undefined,
    );
    const refsOf = (value: unknown) =>
      Array.isArray(value) ? value.flatMap((m) => toMemberRef(m) ?? []) : [];
    const without = (values: string[]) => members.filter((m) => !values.includes(m.value));

    let newName: string | undefined;

    for (const op of patchOp.Operations ?? []) {
      const path = op.path ?? '';
      const value = op.value;

      if (op.op === 'replace') {
        if (path === 'displayName' && typeof value === 'string') {
          newName = value;
        } else if (path === 'members' && Array.isArray(value)) {
          members = refsOf(value);
        }
      } else if (op.op === 'add') {
        if (path === 'members' && Array.isArray(value)) {
          for (const ref of refsOf(value)) {
            const held = members.find((m) => m.value === ref.value);
            if (!held) members.push(ref);
            else if (ref.type) held.type = ref.type;
          }
        }
      } else if (op.op === 'remove') {
        if (path === 'members' && Array.isArray(value)) {
          members = without(refsOf(value).map((m) => m.value));
        } else if (path.startsWith('members[value eq "') && path.endsWith('"]')) {
          const match = path.match(/members\[value eq "([^"]+)"\]/);
          if (match) members = without([match[1]]);
        }
      }
    }

    const updates: { name?: string } & StoredScimMembers = toStoredMembers(members);
    if (newName !== undefined) updates.name = newName;

    const doc = await this.entitlementCatalogService.updateScimGroup(id, updates);

    if (!doc) {
      throw new SCIMError(undefined, 'Group not found', '404');
    }

    this.emitEntitlementUpdated(id, doc);

    const baseUrl = scimBaseUrl(req);
    return this.mapper.toSCIMGroupResponse(
      (doc.toObject?.() ?? doc) as unknown as EntitlementCatalogEntry,
      baseUrl,
    );
  }

  /**
   * DELETE /scim/v2/Groups/:id — Delete group
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string) {
    const existing = await this.entitlementCatalogService.findById(id);
    if (!existing) {
      throw new SCIMError(undefined, 'Group not found', '404');
    }

    const deleted = await this.entitlementCatalogService.deleteScimGroup(id);
    if (!deleted) {
      throw new SCIMError(undefined, 'Group not found', '404');
    }
  }

  private emitEntitlementUpdated(
    groupId: string,
    doc: { _id?: unknown; metadata?: Record<string, unknown> },
  ): void {
    const members = (doc.metadata?.scimMembers as string[] | undefined) ?? [];
    this.eventEmitter.emit(DomainEventType.ENTITLEMENT_UPDATED, groupId, {
      groupId,
      members,
      system: SCIM_SYSTEM,
    });
  }
}
