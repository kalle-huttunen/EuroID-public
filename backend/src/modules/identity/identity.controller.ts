import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Query,
  Param,
  Res,
  UseInterceptors,
  NotFoundException,
  InternalServerErrorException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiBearerAuth,
  ApiExtraModels,
} from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { IdentityService } from './identity.service';
import { UserEventService, type UserEventFilter } from './user-event.service';
import { IdentityEntitlementsService } from './identity-entitlements.service';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { UpdateUserDto } from './dtos/update-user.dto';
import { CreateUserDto } from './dtos/create-user.dto';
import { CorrelateIdentityDto } from './dtos/correlate-identity.dto';
import { ResolveConflictDto } from './dtos/resolve-conflict.dto';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type {
  IdentityOffboardRequestedPayload,
  IdentityProvisionRequestedPayload,
} from '@infrastructure/events/event-payloads';
import { temporalWorkflowUrl } from '@infrastructure/config/temporal.config';
import { AuditService } from '../audit/audit.service';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { parseIdentityListQuery } from './identity-list-query';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { validatePaginationBounds } from '@shared/utils/pagination-validator';
import type { ProvisioningState } from './schemas/identity.schema';
import { MaskPiiInterceptor } from './mask-pii.interceptor';
import { rejectMaskedPii } from './identity-pii';
import {
  movesTriggerAttribute,
  requestMove,
  startSyncRun,
  type SyncRunReport,
} from './identity-sync-run';
import { uniqueValueConflict } from './identity-write-errors';
import { UserEventQuerySchema } from './dtos/user-event-query.dto';

/**
 * REST API for Identity CRUD. Orchestrates onboarding/offboarding workflows.
 * Responses mask PII fields (MaskPiiInterceptor); IdentityPiiController reveals them.
 */
@ApiTags('Identity')
@ApiBearerAuth('jwt')
// The golden-record schema stays in the OpenAPI spec: the frontend types identities with it.
@ApiExtraModels(StandardUserDto)
@Controller('identity')
@UseInterceptors(MaskPiiInterceptor)
export class IdentityController {
  private readonly logger = new Logger(IdentityController.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly userEventService: UserEventService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly auditService: AuditService,
    private readonly identityEntitlementsService: IdentityEntitlementsService,
  ) {}

  @Post()
  @Roles('operator')
  @ApiOperation({ summary: 'Create a new user' })
  @ApiResponse({ status: 201, description: 'User created successfully.' })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed, sourceSystem is an HR source of the tenant (its records come from ' +
      'the HR sync only), or the identity would exceed the source limit.',
  })
  @ApiResponse({
    status: 409,
    description:
      'Nothing was created: another identity has the email, the record was held for a ' +
      'correlation conflict review on the identity whose email it has (the message names it), ' +
      "or the tenant's identity limit (settings.maxIdentities) is reached (the message names it).",
  })
  @ApiResponse({
    status: 503,
    description: 'The correlation settings could not be read: nothing was stored. Try again.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  @ApiQuery({
    name: 'triggerWorkflow',
    required: false,
    type: Boolean,
    description: 'If true, immediately starts the onboarding workflow for this user',
  })
  async create(
    @Body() createUserDto: CreateUserDto,
    @Query('triggerWorkflow') triggerWorkflow?: string,
    @AuthUser() authUser?: AuthUserType,
  ) {
    rejectMaskedPii(createUserDto);
    // The identity belongs to the caller's tenant; the body cannot name another one.
    const dto: StandardUserDto = { ...createUserDto, tenantId: getCurrentTenantId() };
    // A record of an HR source reconciles as HR (it overwrites, can be the primary contract, and
    // no mastery check applies): only the HR sync writes one
    if (await this.identityService.isHrSource(dto.sourceSystem)) {
      throw new BadRequestException(
        `sourceSystem "${dto.sourceSystem}" is an HR source of this tenant: its records come ` +
          'from the HR sync only. Name another source system (Manual-Test, for example).',
      );
    }
    try {
      const user = await this.identityService.create(dto, authUser?.email);
      let workflow: {
        triggered: boolean;
        workflowId?: string;
        trackingUrl?: string;
        error?: string;
      } | null = null;
      if (triggerWorkflow === 'true' && user?.email) {
        try {
          // The onboarding handler reads the identity by the aggregate (its id, never the email)
          // and builds the workflow id from it
          const aggregateId = String(user._id);
          const payload: IdentityProvisionRequestedPayload = {};
          const results = await this.eventEmitter.emitAndWait<
            IdentityProvisionRequestedPayload,
            string
          >(DomainEventType.IDENTITY_PROVISION_REQUESTED, aggregateId, payload);
          const workflowId = results?.[0];
          workflow =
            workflowId && typeof workflowId === 'string'
              ? {
                  triggered: true,
                  workflowId,
                  trackingUrl: temporalWorkflowUrl(workflowId),
                }
              : { triggered: false, error: 'Workflow trigger failed' };
        } catch (error: unknown) {
          const stack = error instanceof Error ? error.stack : String(error);
          this.logger.error('Failed to trigger onboarding workflow', stack);
          workflow = { triggered: false, error: 'Workflow trigger failed' };
        }
      }
      return { user, workflow };
    } catch (error: unknown) {
      // A refusal the client can act on keeps its status: a record held for a conflict review
      // (409), the tenant's identity limit (409), the source limit (400), unreadable correlation
      // settings (503), a taken email (409)
      if (error instanceof HttpException) throw error;
      const conflict = uniqueValueConflict(error);
      if (conflict) throw conflict;
      const stack = error instanceof Error ? error.stack : String(error);
      this.logger.error('Failed to create user', stack);
      throw new InternalServerErrorException('Operation failed');
    }
  }

  @Get()
  @Roles('viewer')
  @ApiOperation({ summary: 'List all users (supports _start, _end for Refine pagination)' })
  @ApiQuery({
    name: '_start',
    required: false,
    type: Number,
    description: 'Start index (inclusive)',
  })
  @ApiQuery({ name: '_end', required: false, type: Number, description: 'End index (exclusive)' })
  @ApiQuery({
    name: 'filter',
    required: false,
    description: 'JSON filter object (whitelisted keys only; $ operators rejected)',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Search: every word in the work email, first, last or display name (case ignored)',
  })
  @ApiQuery({
    name: 'includeDeleted',
    required: false,
    type: Boolean,
    description: 'Offboarded (soft-deleted) identities too, with deletedAt; operator and above',
  })
  @ApiResponse({ status: 403, description: 'includeDeleted=true without the operator role' })
  async findAll(
    @Query('_start') start?: string,
    @Query('_end') end?: string,
    @Query('filter') filterParam?: string,
    @Res({ passthrough: true }) res?: Response,
    @AuthUser() authUser?: AuthUserType,
    @Query('q') q?: string,
    @Query('includeDeleted') includeDeleted?: string,
  ) {
    const query = parseIdentityListQuery(
      { filter: filterParam, q, includeDeleted },
      authUser?.roles,
    );
    const startNum = start != null ? parseInt(start, 10) : undefined;
    const endNum = end != null ? parseInt(end, 10) : undefined;
    validatePaginationBounds(startNum, endNum);
    const [data, total] = await this.identityService.findAllPaginated(startNum, endNum, query);
    if (res?.setHeader && total != null) res.setHeader('X-Total-Count', String(total));

    // Emit BULK_QUERY_EXECUTED when bulk list returns >50 records
    if (total > 50) {
      const ctx = getRequestContext();
      this.auditService.logFireAndForget({
        action: 'BULK_QUERY_EXECUTED',
        actor: authUser?.email ?? 'unknown',
        resourceType: 'identity',
        resourceId: 'identity_list',
        resourceName: 'Identity Bulk Query',
        description: `Identity list query returned ${total} records`,
        payload: { metadata: { total, start, end } },
        tenantId: ctx?.tenantId ?? 'unknown',
      });
    }

    return data;
  }

  @Patch(':id')
  @Roles('operator')
  @ApiOperation({ summary: 'Update user by ID' })
  @ApiResponse({
    status: 200,
    description:
      'User updated. A body that changes no field (empty, or every value as stored) writes ' +
      'nothing and records no timeline entry. `workflow`: the run the edit started (with ' +
      'syncToEntra, the mover or onboarding; without, the mover for an edit that moves a ' +
      'trigger attribute of a provisioned identity), else null. While a mover run for the ' +
      'identity is open, the edit is queued on it: `queued: true`, `workflowId` that run, ' +
      'which applies the access change when it has finished.',
  })
  @ApiResponse({ status: 404, description: 'User not found.' })
  @ApiResponse({
    status: 409,
    description:
      'Nothing was changed: the body changes a field an HR source masters (GET ' +
      '/identity/:id/mastery), or a department or job title with an active override. The ' +
      'message names the field and its owner, e.g. "departmentName is mastered by csv-hr: ' +
      'change it in HR, or set an override"; the override of a department or job title is ' +
      'PATCH /identity/v2/:id/controls. Also when the national ID in the body (the Hashed ' +
      'National ID field or hetu in customAttributes, never stored) hashes to the correlationId ' +
      "of another identity, or the email is another live identity's.",
  })
  @ApiResponse({
    status: 503,
    description:
      'Nothing was changed: the correlation settings, which the HR-mastery check reads, could ' +
      'not be read. Try again.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  @ApiQuery({
    name: 'syncToEntra',
    required: false,
    type: Boolean,
    description:
      'If true, immediately syncs the updated user attributes to Entra ID. An update that changes a mover trigger attribute of an identity provisioned to a target system starts the mover instead, and that run makes the sync, also when it changes no access (workflow.workflowType: mover).',
  })
  async update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() updateDto: UpdateUserDto,
    @Query('syncToEntra') syncToEntra?: string,
    @AuthUser() authUser?: AuthUserType,
  ) {
    rejectMaskedPii(updateDto);
    const sync = syncToEntra === 'true';
    // identity.updated carries syncToEntra / moverRequested so the handlers leave the run to this
    // route: it is started once, below, where its outcome (or the queued change) can be reported.
    // A change of a field an HR source masters is refused (409): the override is the controls
    const { user, changedFields, previousAttributes } =
      await this.identityService.updateWithChanges(id, updateDto, authUser?.email, {
        refuseHrMastered: true,
        moverRequested: true,
        ...(sync ? { syncToEntra: true } : {}),
      });
    // The changes as identity.updated reported them: access attributes only, an email value
    // (managerEmail) masked, and no national ID even when the profile held one
    const edit = { identityId: id, changedFields, previousAttributes };
    let workflow: SyncRunReport | null = null;
    if (sync && user?.email) {
      workflow = await startSyncRun(this.eventEmitter, this.logger, edit);
    } else if (user?.email && movesTriggerAttribute(edit)) {
      // The mover run the edit started, or the open one it was queued on (null: not the mover's)
      workflow = await requestMove(this.eventEmitter, this.logger, edit);
    }
    return { user, workflow };
  }

  @Get(':id/offboard-impact')
  @Roles('viewer')
  @ApiOperation({ summary: 'Simulate offboard impact — affected systems and entitlements (FF-4)' })
  @ApiResponse({ status: 200, description: 'Impact preview.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  async getOffboardImpact(@Param('id', ParseObjectIdPipe) id: string) {
    const identity = await this.identityService.findById(id);
    if (!identity) throw new NotFoundException('User not found');

    const provisioning: ProvisioningState[] =
      (identity as { provisioning?: ProvisioningState[] }).provisioning ?? [];
    const affectedSystems = provisioning
      .filter((p: ProvisioningState) => p.status !== 'DEPROVISIONED')
      .map((p: ProvisioningState) => p.targetSystem);

    const results = await this.eventEmitter.emitAndWait<{ identityId: string }, unknown[]>(
      DomainEventType.IDENTITY_OFFBOARD_IMPACT_QUERY,
      id,
      { identityId: id },
    );
    const activeRequests =
      (results?.[0] as Array<{
        entitlements?: Array<{ entitlementName: string; system: string; entitlementType?: string }>;
      }>) ?? [];

    const entitlements = activeRequests.flatMap((r) =>
      (r.entitlements ?? []).map(
        (e: { entitlementName: string; system: string; entitlementType?: string }) => ({
          name: e.entitlementName,
          system: e.system,
          type: e.entitlementType ?? 'Group',
        }),
      ),
    );

    return { affectedSystems, entitlements };
  }

  @Get(':id/entitlements')
  @Roles('viewer')
  @ApiOperation({
    summary:
      'Entitlements for an identity: granted by active policies or active access requests, with status',
  })
  @ApiResponse({ status: 200, description: 'Entitlement list ({ identityId, entitlements[] }).' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  async getEntitlements(@Param('id', ParseObjectIdPipe) id: string) {
    const result = await this.identityEntitlementsService.getEntitlements(id);
    if (!result) throw new NotFoundException('User not found');
    return result;
  }

  @Delete(':id')
  @Roles('operator')
  @ApiOperation({ summary: 'Delete user by ID (triggers offboarding workflow)' })
  @ApiResponse({ status: 200, description: 'Offboarding workflow started successfully.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  async delete(@Param('id', ParseObjectIdPipe) id: string, @AuthUser() _authUser?: AuthUserType) {
    const user = await this.identityService.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const userEmail = user.email as string | undefined;
    if (!userEmail) {
      return {
        success: false,
        error: 'User has no email; cannot trigger offboarding',
      };
    }
    try {
      // No email in the event: the handler reads it from the identity
      const payload: IdentityOffboardRequestedPayload = { userId: id };
      const results = await this.eventEmitter.emitAndWait<IdentityOffboardRequestedPayload, string>(
        DomainEventType.IDENTITY_OFFBOARD_REQUESTED,
        id,
        payload,
      );
      const workflowId = results?.[0];
      if (workflowId && typeof workflowId === 'string') {
        return {
          success: true,
          workflowId,
          trackingUrl: temporalWorkflowUrl(workflowId),
          message: `Offboarding workflow started for ${userEmail}`,
        };
      }
      return { success: false, error: 'Failed to start offboarding workflow' };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to trigger offboarding for ${id}: ${msg}`,
        error instanceof Error ? error.stack : undefined,
      );
      return { success: false, error: 'Failed to start offboarding workflow' };
    }
  }

  // ========== User Events / Timeline API ==========

  @Get('conflicts')
  @Roles('viewer')
  @ApiOperation({ summary: 'List identities with correlation conflicts requiring review' })
  @ApiResponse({
    status: 200,
    description: 'List of identities with requiresReview or correlationConflict.',
  })
  async getConflicts() {
    return this.identityService.getConflicts();
  }

  // ========== Uncorrelated Queue API ==========

  @Get('uncorrelated')
  @Roles('viewer')
  @ApiOperation({ summary: 'List uncorrelated/ambiguous identities for manual linking' })
  @ApiResponse({
    status: 200,
    description:
      'Live uncorrelated or ambiguous identities, then offboarded ones holding no account ' +
      '(`offboarded: true`; Link still merges them).',
  })
  async getUncorrelated() {
    return this.identityService.getUncorrelated();
  }

  @Get('uncorrelated/count')
  @Roles('viewer')
  @ApiOperation({ summary: 'Count uncorrelated identities (for sidebar badge)' })
  @ApiResponse({ status: 200, description: 'Count of what GET /identity/uncorrelated lists.' })
  async getUncorrelatedCount() {
    const count = await this.identityService.countUncorrelated();
    return { count };
  }

  @Get(':id/candidates')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get candidate matches for an uncorrelated identity' })
  @ApiResponse({ status: 200, description: 'Scored candidates for manual linking.' })
  async getCandidates(@Param('id', ParseObjectIdPipe) id: string) {
    const candidates = await this.identityService.getCandidatesForIdentity(id);
    return { candidates };
  }

  @Post(':id/link')
  @Roles('operator')
  @ApiOperation({ summary: 'Manually link uncorrelated identity to a target identity' })
  @ApiResponse({ status: 200, description: 'Linked and reconciled (also an offboarded identity).' })
  @ApiResponse({ status: 400, description: 'The merged identity would exceed the source limit.' })
  @ApiResponse({ status: 404, description: 'Identity not found, not uncorrelated or merged away.' })
  @ApiResponse({
    status: 409,
    description:
      'Nothing was changed: the uncorrelated identity still has an account in a target system ' +
      '(delete it first), another identity has the merged email (or another unique value), ' +
      'or an identity changed while merging. The message says which.',
  })
  async linkIdentity(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() body: CorrelateIdentityDto,
    @AuthUser() authUser?: AuthUserType,
  ) {
    const result = await this.identityService.linkUncorrelatedToTargetFormatted(
      id,
      body.targetIdentityId,
      authUser?.email,
    );
    if (!result) throw new NotFoundException('Identity not found or not uncorrelated');
    return result;
  }

  @Post(':id/create-standalone')
  @Roles('operator')
  @ApiOperation({ summary: 'Accept uncorrelated identity as new standalone person (no linking)' })
  @ApiResponse({
    status: 200,
    description: 'Marked as correlated (standalone). An offboarded identity stays deleted.',
  })
  @ApiResponse({ status: 404, description: 'Identity not found, not uncorrelated or merged away.' })
  async createStandalone(
    @Param('id', ParseObjectIdPipe) id: string,
    @AuthUser() authUser?: AuthUserType,
  ) {
    const result = await this.identityService.createStandaloneFormatted(id, authUser?.email);
    if (!result) throw new NotFoundException('Identity not found or not uncorrelated');
    return result;
  }

  @Post(':id/resolve-conflict')
  @Roles('operator')
  @ApiOperation({ summary: 'Resolve a correlation conflict (merge, split, or dismiss)' })
  @ApiResponse({ status: 200, description: 'Conflict resolved.' })
  @ApiResponse({ status: 400, description: 'The merged identity would exceed the source limit.' })
  @ApiResponse({ status: 404, description: 'Identity not found or no conflict.' })
  @ApiResponse({
    status: 409,
    description:
      'Nothing was changed and the conflict stays open: the incoming identity still has an ' +
      'account in a target system (delete it first; an offboarded one is merged), another ' +
      'identity has the merged email, the incoming record is gone or was never stored, an ' +
      'identity changed meanwhile, or a held record (no identity of its own) was to be split. ' +
      'The message says which.',
  })
  async resolveConflict(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() body: ResolveConflictDto,
  ) {
    const result = await this.identityService.resolveConflictFormatted(id, body.action);
    if (!result) throw new NotFoundException('Identity not found or has no conflict');
    return result;
  }

  @Get(':id/events')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get timeline events for a user' })
  @ApiResponse({ status: 200, description: 'List of user events.' })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by event type' })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'Start of date range (ISO)' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'End of date range (ISO)' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max events to return (default 50)',
  })
  async getUserEvents(
    @Param('id', ParseObjectIdPipe) id: string,
    @Query('type') type?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = UserEventQuerySchema.safeParse({ type, dateFrom, dateTo, limit });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten().fieldErrors);
    }
    const { type: t, dateFrom: df, dateTo: dt, limit: lim } = parsed.data;
    const filter: { type?: string; dateFrom?: string; dateTo?: string } = {};
    if (t) filter.type = t;
    if (df) filter.dateFrom = df;
    if (dt) filter.dateTo = dt;

    const events = await this.userEventService.getEvents(
      id,
      Object.keys(filter).length > 0 ? (filter as UserEventFilter) : undefined,
      lim,
    );
    return events;
  }

  // ========== Onion Model (Identity v2) API ==========
  // NOTE: "v2" here is a route segment for the Onion model endpoints,
  // not NestJS API versioning. All routes are under the global /api/v1/ prefix.
  // Full path: /api/v1/identity/v2/by-email
  // See: docs/architecture/api/API_STABILITY_CONTRACT.md

  @Get('v2/by-email')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get Identity (Onion) by profile email' })
  @ApiResponse({ status: 200, description: 'Identity found.' })
  @ApiResponse({ status: 404, description: 'Identity not found.' })
  async getIdentityByEmail(@Query('email') email: string) {
    return this.identityService.findIdentityByEmailFormatted(email);
  }

  @Get('v2/:id')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get Identity (Onion) by ID' })
  @ApiResponse({ status: 200, description: 'Identity found.' })
  @ApiResponse({ status: 404, description: 'Identity not found.' })
  async getIdentityById(@Param('id', ParseObjectIdPipe) id: string) {
    return this.identityService.findIdentityByIdFormatted(id);
  }

  // PATCH v2/:id/controls and GET :id/mastery: IdentityControlsController

  @Get(':id')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get user by ID (must be after :id/events and v2 routes)' })
  @ApiResponse({ status: 200, description: 'User found.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  async findOne(@Param('id', ParseObjectIdPipe) id: string) {
    const user = await this.identityService.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
