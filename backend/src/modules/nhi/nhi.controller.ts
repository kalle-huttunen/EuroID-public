/**
 * NHI Controller — REST API for non-human (agent) identities.
 *
 *   GET    /api/v1/nhi                         list NHIs (filter by owner/kind/status/risk)
 *   GET    /api/v1/nhi/:agentId                get one
 *   POST   /api/v1/nhi                         create (owner required, scope required)
 *   POST   /api/v1/nhi/:parent/delegate        create sub-agent with attenuated scope
 *   POST   /api/v1/nhi/:agentId/revoke         terminal revocation (?dryRun=true: preview)
 *   POST   /api/v1/nhi/:agentId/kill           engage kill-switch (critical, sticky; ?dryRun=true)
 *   POST   /api/v1/nhi/:agentId/owner          give the agent a new owner (ends ownerless)
 *   POST   /api/v1/nhi/:agentId/credentials    issue short-lived signed credential
 *   POST   /api/v1/nhi/credentials/verify      introspect a credential (RFC 7662 style)
 *   GET    /api/v1/nhi/_/public-key            the signing public key (PEM and JWK)
 *   GET    /api/v1/nhi/_/credential-signing-status  whether issuance is configured
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z, ZodError } from 'zod';

import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';

import { NhiService } from './nhi.service';
import { NhiCredentialService } from './nhi-credential.service';
import { NhiOwnershipService } from './nhi-ownership.service';
import {
  CreateAgentIdentitySchema,
  DelegateAgentIdentitySchema,
  IssueCredentialSchema,
  ListAgentIdentitiesQuerySchema,
  ReownAgentIdentitySchema,
  RevokeAgentIdentitySchema,
} from './dtos/agent-identity.dto';
import { AgentCredentialSchema } from './dtos/agent-credential.dto';

/** ?dryRun=true previews a revoke or kill switch; any other value than true or false is a 400. */
const DryRunQuerySchema = z.object({ dryRun: z.enum(['true', 'false']).optional() });

const DRY_RUN_QUERY = {
  name: 'dryRun',
  required: false,
  enum: ['true', 'false'],
  description:
    'true: change nothing and answer { dryRun, agentId, killSwitch, changes, reached }, the ' +
    'delegated agents the call would revoke too (the reason may then be left out)',
};

function toBadRequest(err: unknown): never {
  if (err instanceof ZodError) {
    throw new BadRequestException(err.errors.map((e) => e.message).join(', '));
  }
  throw err;
}

@ApiTags('NHI')
@ApiBearerAuth('jwt')
@Controller('nhi')
export class NhiController {
  constructor(
    private readonly nhi: NhiService,
    private readonly creds: NhiCredentialService,
    private readonly ownership: NhiOwnershipService,
  ) {}

  @Get()
  @Roles('viewer')
  @ApiOperation({
    summary: 'List non-human identities for the current tenant',
    description: 'Agents past their expiresAt are marked expired before the list is read.',
  })
  @ApiQuery({ name: 'ownerIdentityId', required: false, description: "The owner's identity _id" })
  @ApiQuery({
    name: 'kind',
    required: false,
    enum: ['service-account', 'workload', 'ai-agent', 'bot'],
  })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'revoked', 'expired'] })
  @ApiQuery({ name: 'riskTier', required: false, enum: ['low', 'medium', 'high', 'critical'] })
  @ApiQuery({
    name: 'ownerless',
    required: false,
    enum: ['true', 'false'],
    description: 'true: only agents whose owner was offboarded or erased; false: the others',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '1 to 10000 (default 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1 to 100 (default 50)' })
  async list(
    @Query('ownerIdentityId') ownerIdentityId?: string,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('riskTier') riskTier?: string,
    @Query('ownerless') ownerless?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    let parsed;
    try {
      parsed = ListAgentIdentitiesQuerySchema.parse({
        ownerIdentityId,
        kind,
        status,
        riskTier,
        ownerless,
        page,
        limit,
      });
    } catch (err) {
      toBadRequest(err);
    }
    const tenantId = this.tenantId();
    return this.nhi.list(
      tenantId,
      {
        ownerIdentityId: parsed!.ownerIdentityId,
        kind: parsed!.kind,
        status: parsed!.status,
        riskTier: parsed!.riskTier,
        ownerless: parsed!.ownerless,
      },
      parsed!.page,
      parsed!.limit,
    );
  }

  @Get(':agentId')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get one non-human identity (expired once past its expiresAt)' })
  async get(@Param('agentId') agentId: string) {
    const doc = await this.nhi.get(this.tenantId(), agentId);
    if (!doc) throw new NotFoundException(`Agent '${agentId}' not found`);
    return doc;
  }

  @Post()
  @Roles('super-admin')
  @ApiOperation({ summary: 'Create a non-human identity' })
  async create(@Body() body: unknown, @AuthUser() user?: AuthUserType) {
    try {
      const dto = CreateAgentIdentitySchema.parse(body);
      return await this.nhi.create(this.tenantId(), dto, user?.email ?? 'unknown');
    } catch (err) {
      toBadRequest(err);
    }
  }

  @Post(':parentAgentId/delegate')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Create a sub-agent with attenuated scope' })
  async delegate(
    @Param('parentAgentId') parentAgentId: string,
    @Body() body: unknown,
    @AuthUser() user?: AuthUserType,
  ) {
    try {
      const dto = DelegateAgentIdentitySchema.parse(body);
      return await this.nhi.delegate(this.tenantId(), parentAgentId, dto, user?.email ?? 'unknown');
    } catch (err) {
      toBadRequest(err);
    }
  }

  @Post(':agentId/revoke')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Revoke an agent identity (terminal)' })
  @ApiQuery(DRY_RUN_QUERY)
  async revoke(
    @Param('agentId') agentId: string,
    @Query('dryRun') dryRun: string | undefined,
    @Body() body: unknown,
    @AuthUser() user?: AuthUserType,
  ) {
    return this.end(agentId, dryRun, body, user, false);
  }

  @Post(':agentId/kill')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Engage the kill-switch (sticky revocation + critical fan-out)' })
  @ApiQuery(DRY_RUN_QUERY)
  async kill(
    @Param('agentId') agentId: string,
    @Query('dryRun') dryRun: string | undefined,
    @Body() body: unknown,
    @AuthUser() user?: AuthUserType,
  ) {
    return this.end(agentId, dryRun, body, user, true);
  }

  @Post(':agentId/owner')
  @Roles('super-admin')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Give the agent a new owner',
    description:
      'Body { ownerIdentityId }: an active identity of the tenant (400 otherwise). Ends the ' +
      'ownerless state an agent gets when its owner is offboarded or erased, so it can be ' +
      'issued credentials again. A revoked agent keeps its owner (409).',
  })
  @ApiBody({ description: '{ ownerIdentityId }' })
  async reown(
    @Param('agentId') agentId: string,
    @Body() body: unknown,
    @AuthUser() user?: AuthUserType,
  ) {
    try {
      const dto = ReownAgentIdentitySchema.parse(body);
      return await this.ownership.reown(
        this.tenantId(),
        agentId,
        dto.ownerIdentityId,
        user?.email ?? 'unknown',
      );
    } catch (err) {
      toBadRequest(err);
    }
  }

  @Post(':agentId/credentials')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Issue a short-lived signed credential for the agent' })
  async issueCredential(
    @Param('agentId') agentId: string,
    @Body() body: unknown,
    @AuthUser() user?: AuthUserType,
  ) {
    try {
      const dto = IssueCredentialSchema.parse(body ?? {});
      return await this.creds.issue(
        this.tenantId(),
        agentId,
        dto.ttlSeconds,
        user?.email ?? 'unknown',
      );
    } catch (err) {
      toBadRequest(err);
    }
  }

  @Post('credentials/verify')
  @Roles('viewer')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Introspect an NHI credential (RFC 7662 style)',
    description:
      'Body: the credential envelope POST /nhi/:agentId/credentials answered. Answers ' +
      '{ active: true, agentId, scope, expiresAt } when it is signed by the current key, ' +
      'unaltered, unexpired, issued for the caller tenant, and its agent is not revoked, killed ' +
      'or past its expiresAt; otherwise { active: false, reason }. A body that is not an ' +
      'envelope is a 400.',
  })
  @ApiBody({ description: '{ payload, signature, keyFingerprint, algorithm }' })
  async verifyCredential(@Body() body: unknown) {
    const credential = AgentCredentialSchema.parse(body);
    return this.creds.verify(this.tenantId(), credential);
  }

  @Get('_/public-key')
  @Roles('viewer')
  @ApiOperation({
    summary: 'The public key that verifies NHI credentials offline',
    description:
      'PEM and JWK, the key fingerprint, the algorithm and the SPIFFE trust domain. An offline ' +
      'check cannot see a revoke, kill switch or expiry of the agent before the credential ' +
      'itself expires (at most 1 h); POST /nhi/credentials/verify can. 404 when no signing key ' +
      'is configured.',
  })
  publicKey() {
    const key = this.creds.publicKey();
    if (!key) {
      throw new NotFoundException(
        'NHI credential signing is not configured: there is no public key',
      );
    }
    return key;
  }

  @Get('_/credential-signing-status')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Whether credential issuance is configured' })
  credentialStatus() {
    return { enabled: this.creds.isEnabled() };
  }

  /** Revoke or kill switch, or with ?dryRun=true what it would reach. */
  private async end(
    agentId: string,
    dryRun: string | undefined,
    body: unknown,
    user: AuthUserType | undefined,
    killSwitch: boolean,
  ) {
    try {
      if (DryRunQuerySchema.parse({ dryRun }).dryRun === 'true') {
        RevokeAgentIdentitySchema.partial().parse(body ?? {});
        return await this.nhi.previewRevoke(this.tenantId(), agentId, killSwitch);
      }
      const dto = RevokeAgentIdentitySchema.parse(body);
      return await this.nhi.revoke(this.tenantId(), agentId, {
        reason: dto.reason,
        actor: user?.email ?? 'unknown',
        killSwitch,
      });
    } catch (err) {
      toBadRequest(err);
    }
  }

  private tenantId(): string {
    return getRequestContext()?.tenantId ?? 'unknown';
  }
}
