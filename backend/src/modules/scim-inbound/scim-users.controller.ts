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
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { IdentityService } from '../identity/identity.service';
import { IdentityLimitReached } from '../identity/identity-limit';
import { HrMasteredFieldsException } from '../identity/hr-mastered-fields.exception';
import { ScimInboundMapper } from './scim-inbound.mapper';
import { ScimFilterService } from './scim-filter.service';
import { scimBaseUrl } from './scim-base-url';
import { ScimAuth } from './guards/scim-auth.guard';
import { ScimResponseInterceptor } from './interceptors/scim-response.interceptor';
import {
  SCIMErrorFilter,
  SCIMError,
  SCIMUser,
  SCIMListResponse,
  SCIMPatchOp,
  SCIM_SCHEMAS,
} from '@shared/scim';
import { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';
import { z, ZodError } from 'zod';

/** The most users one list page returns: a larger `count` gets this many (RFC 7644 3.4.2.4). */
const MAX_SCIM_PAGE = 100;

const ListScimUsersQuery = z.object({
  startIndex: z.coerce.number().int().positive().default(1),
  count: z.coerce
    .number()
    .int()
    .positive()
    .default(MAX_SCIM_PAGE)
    .transform((count) => Math.min(count, MAX_SCIM_PAGE)),
  filter: z.string().max(500).optional(),
});

const EmailFormat = z.string().email();

/**
 * Refuses (SCIM 400 invalidValue) an email the mapping took from `emails[].value` or a userName
 * used as the email when it is no email address: it is stored and sent to the target systems.
 */
function assertEmail(email: unknown): void {
  if (email === undefined) return;
  if (typeof email !== 'string' || !EmailFormat.safeParse(email.trim()).success) {
    throw new SCIMError(
      'invalidValue',
      'The email (emails.value, else userName) is no email address',
      '400',
    );
  }
}

// ── Zod schemas for SCIM User @Body() validation (RFC 7643 §4.1) ──
// Uses .passthrough() so extra SCIM attributes are forwarded without being stripped.

const ScimUserBodySchema = z
  .object({
    schemas: z.array(z.string().max(500)).min(1).max(20),
    userName: z.string().min(1).max(500),
    externalId: z.string().max(500).optional(),
    name: z
      .object({
        formatted: z.string().max(500).optional(),
        familyName: z.string().max(500).optional(),
        givenName: z.string().max(500).optional(),
        middleName: z.string().max(500).optional(),
        honorificPrefix: z.string().max(500).optional(),
        honorificSuffix: z.string().max(500).optional(),
      })
      .passthrough()
      .optional(),
    displayName: z.string().max(500).optional(),
    emails: z
      .array(
        z
          .object({
            value: z.string().max(500),
            type: z.string().max(100).optional(),
            primary: z.boolean().optional(),
          })
          .passthrough(),
      )
      .max(50)
      .optional(),
    phoneNumbers: z
      .array(
        z
          .object({
            value: z.string().max(100),
            type: z.string().max(100).optional(),
          })
          .passthrough(),
      )
      .max(50)
      .optional(),
    active: z.boolean().optional(),
    title: z.string().max(500).optional(),
  })
  .passthrough();

const ScimPatchOpSchema = z
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

@Controller('scim/v2/Users')
@Public()
@ScimAuth('Users')
@UseFilters(SCIMErrorFilter)
@UseInterceptors(ScimResponseInterceptor)
export class ScimUsersController {
  constructor(
    private readonly identityService: IdentityService,
    private readonly mapper: ScimInboundMapper,
    private readonly filterService: ScimFilterService,
  ) {}

  /**
   * An update from the SCIM client. A change of a field an HR source masters is refused in SCIM's
   * error model (400, scimType "mutability", the field and its owner in the detail): the next HR
   * sync would set it back (owner decision 2026-11-24). A value the body repeats unchanged, as a
   * full PUT does, passes.
   */
  private async updateFromScim(id: string, dto: Partial<StandardUserDto>): Promise<void> {
    try {
      await this.identityService.update(id, dto, 'scim-inbound', { refuseHrMastered: true });
    } catch (error) {
      if (error instanceof HrMasteredFieldsException) {
        throw new SCIMError('mutability', error.message, '400');
      }
      throw error;
    }
  }

  /**
   * POST /scim/v2/Users — Create user
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown, @Req() req: Request) {
    let scimUser: SCIMUser;
    try {
      scimUser = ScimUserBodySchema.parse(body) as SCIMUser;
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

    const userName = scimUser.userName;
    const dto = this.mapper.toStandardUser(scimUser) as Partial<StandardUserDto>;
    // The stored email: the primary email, else the userName (buildFullDto)
    assertEmail(dto.email ?? userName);

    // The userName becomes the UPN and the primary email (else the userName) the email: either
    // held by another identity is that user, never a new one to correlate into it
    const [, holders] = await this.identityService.findAllPaginated(0, 1, {
      filter: this.filterService.existingUserQuery(userName, dto.email),
      trustedFilter: true,
    });
    if (holders > 0) {
      throw new SCIMError('uniqueness', 'A user with this userName or email already exists', '409');
    }

    // The identity belongs to the SCIM token's tenant (request context), not the mapper's default.
    const fullDto: StandardUserDto = {
      ...this.mapper.buildFullDto(dto, userName),
      tenantId: getCurrentTenantId(),
    };
    const user = await this.identityService.create(fullDto, 'scim-inbound').catch((error) => {
      // Not a duplicate: no scimType (the filter would answer any other 409 as uniqueness)
      if (error instanceof IdentityLimitReached)
        throw new SCIMError(undefined, error.message, '409');
      throw error;
    });

    const baseUrl = scimBaseUrl(req);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- identity is a dynamic lean document; toObject may exist on Mongoose docs
    const userObj = (user as any).toObject?.() ?? user;
    return this.mapper.toSCIMResponse(userObj, baseUrl);
  }

  /**
   * GET /scim/v2/Users — List users
   */
  @Get()
  async list(
    @Req() req: Request,
    @Query('startIndex') startIndex?: string,
    @Query('count') count?: string,
    @Query('filter') filter?: string,
  ) {
    const query = ListScimUsersQuery.parse({ startIndex, count, filter });
    const start = query.startIndex;
    const limit = query.count;
    const skip = start - 1;

    let mongoFilter: Record<string, unknown> = {};
    if (query.filter?.trim()) {
      mongoFilter = this.filterService.parseFilter(query.filter);
    }

    const hasFilter = Object.keys(mongoFilter).length > 0;
    const [data, total] = await this.identityService.findAllPaginated(skip, skip + limit, {
      filter: hasFilter ? mongoFilter : undefined,
      trustedFilter: hasFilter,
    });

    const baseUrl = scimBaseUrl(req);
    const resources = data.map((u) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- identity may be a Mongoose doc with toObject
      const obj = (u as any).toObject?.() ?? u;
      return this.mapper.toSCIMResponse(obj, baseUrl);
    });

    const response: SCIMListResponse<SCIMUser> = {
      schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
      totalResults: total,
      startIndex: start,
      itemsPerPage: resources.length,
      Resources: resources,
    };
    return response;
  }

  /**
   * GET /scim/v2/Users/:id — Get single user
   */
  @Get(':id')
  async getById(@Param('id') id: string, @Req() req: Request) {
    const user = await this.identityService.findById(id);
    if (!user) {
      throw new SCIMError(undefined, 'User not found', '404');
    }
    const baseUrl = scimBaseUrl(req);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- identity is a dynamic lean document; toObject may exist on Mongoose docs
    const userObj = (user as any).toObject?.() ?? user;
    return this.mapper.toSCIMResponse(userObj, baseUrl);
  }

  /**
   * PUT /scim/v2/Users/:id — Full replace
   */
  @Put(':id')
  async replace(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    let scimUser: SCIMUser;
    try {
      scimUser = ScimUserBodySchema.parse(body) as SCIMUser;
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

    const existing = await this.identityService.findById(id);
    if (!existing) {
      throw new SCIMError(undefined, 'User not found', '404');
    }

    const dto = this.mapper.toStandardUser(scimUser) as Partial<StandardUserDto>;
    assertEmail(dto.email);
    const email = dto.email ?? (existing.email as string | undefined) ?? '';
    const fullDto = this.mapper.buildFullDto(dto, email, existing);

    await this.updateFromScim(id, fullDto);
    const updated = await this.identityService.findById(id);
    const baseUrl = scimBaseUrl(req);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- identity is a dynamic lean document; toObject may exist on Mongoose docs
    const updatedObj = (updated as any)?.toObject?.() ?? updated;
    return this.mapper.toSCIMResponse(updatedObj, baseUrl);
  }

  /**
   * PATCH /scim/v2/Users/:id — Partial update
   */
  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    let patchOp: SCIMPatchOp;
    try {
      patchOp = ScimPatchOpSchema.parse(body) as SCIMPatchOp;
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

    const existing = await this.identityService.findById(id);
    if (!existing) {
      throw new SCIMError(undefined, 'User not found', '404');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- identity is a dynamic lean document; toObject may exist on Mongoose docs
    const existingObj = (existing as any).toObject?.() ?? existing;
    const updateDto = this.mapper.applyPatchOps(existingObj, patchOp.Operations ?? []);
    assertEmail(updateDto.email);
    await this.updateFromScim(id, updateDto);

    const updated = await this.identityService.findById(id);
    const baseUrl = scimBaseUrl(req);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- identity is a dynamic lean document; toObject may exist on Mongoose docs
    const updatedObj2 = (updated as any)?.toObject?.() ?? updated;
    return this.mapper.toSCIMResponse(updatedObj2, baseUrl);
  }

  /**
   * DELETE /scim/v2/Users/:id — Soft delete (set status to inactive)
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string) {
    const user = await this.identityService.findById(id);
    if (!user) {
      throw new SCIMError(undefined, 'User not found', '404');
    }
    await this.updateFromScim(id, { status: UserStatus.INACTIVE });
  }
}
