/**
 * Audit Controller
 *
 * REST API for the Audit & Compliance dashboard.
 *   GET  /api/v1/audit                   -- paginated, filtered event list
 *   GET  /api/v1/audit/stats             -- summary statistics
 *   GET  /api/v1/audit/verify-integrity  -- hash-chain verification (super-admin)
 *   GET  /api/v1/audit/merkle-roots      -- list Merkle checkpoints (super-admin)
 *   POST /api/v1/audit/merkle-roots      -- create a checkpoint now (super-admin, audited)
 *   POST /api/v1/audit/verify-event/:id  -- Merkle proof for single event (super-admin)
 *   POST /api/v1/audit/verify            -- checkpoints of a date range against their events (super-admin)
 *   GET  /api/v1/audit/merkle-roots/:checkpointId/anchor -- signed anchor (super-admin)
 * Every input is parsed with Zod; the global ZodErrorFilter answers invalid input with 400.
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiBearerAuth,
  ApiBody,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { AuditService, AuditFilter } from './audit.service';
import { AuditMerkleService } from './audit-merkle.service';
import { AuditAnchorService } from './audit-anchor.service';
import { AuditAction, AuditSeverity } from './schemas/audit-event.schema';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { validatePageLimit } from '@shared/utils/pagination-validator';
import { z } from 'zod';
import {
  CheckpointIdParamSchema,
  EventIdParamSchema,
  MerkleRootsQuerySchema,
  TimeWindowSchema,
  auditDateRangeIsValid,
  isoDateTime,
} from './dtos/audit-integrity.dto';

const AuditQuerySchema = z
  .object({
    action: z.union([z.string().max(100), z.array(z.string().max(100)).max(50)]).optional(),
    severity: z
      .union([
        z.enum(['info', 'warning', 'error', 'critical']),
        z.array(z.enum(['info', 'warning', 'error', 'critical'])).max(4),
      ])
      .optional(),
    actor: z.string().max(320).optional(),
    resourceType: z.string().max(100).optional(),
    targetSystem: z.string().max(200).optional(),
    dateFrom: isoDateTime.optional(),
    dateTo: isoDateTime.optional(),
    search: z.string().max(500).optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine(auditDateRangeIsValid, { message: 'must not be after dateTo', path: ['dateFrom'] });

@ApiTags('Audit')
@ApiBearerAuth('jwt')
@Controller('audit')
export class AuditController {
  private readonly logger = new Logger(AuditController.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly auditMerkleService: AuditMerkleService,
    private readonly auditAnchorService: AuditAnchorService,
  ) {}

  @Get()
  @Roles('viewer')
  @ApiOperation({ summary: 'Query audit events with filters and pagination' })
  @ApiQuery({
    name: 'action',
    required: false,
    isArray: true,
    description: 'Filter by action types',
  })
  @ApiQuery({
    name: 'severity',
    required: false,
    isArray: true,
    description: 'Filter by severity levels',
  })
  @ApiQuery({ name: 'actor', required: false, description: 'Filter by actor email/name' })
  @ApiQuery({ name: 'resourceType', required: false, description: 'Filter by resource type' })
  @ApiQuery({ name: 'targetSystem', required: false, description: 'Filter by target system' })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'Start of date range (ISO)' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'End of date range (ISO)' })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Full-text search across description, resource name, actor',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (1-based)' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default 50)',
  })
  async queryEvents(
    @Query('action') action?: string | string[],
    @Query('severity') severity?: string | string[],
    @Query('actor') actor?: string,
    @Query('resourceType') resourceType?: string,
    @Query('targetSystem') targetSystem?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @AuthUser() authUser?: AuthUserType,
  ) {
    const parsed = AuditQuerySchema.parse({
      action,
      severity,
      actor,
      resourceType,
      targetSystem,
      dateFrom,
      dateTo,
      search,
      page,
      limit,
    });

    const filter: AuditFilter = {
      action: this.toArray(parsed.action) as AuditAction[],
      severity: this.toArray(parsed.severity) as AuditSeverity[],
      actor: parsed.actor,
      resourceType: parsed.resourceType,
      targetSystem: parsed.targetSystem,
      dateFrom: parsed.dateFrom,
      dateTo: parsed.dateTo,
      search: parsed.search,
    };

    validatePageLimit(parsed.page, parsed.limit);
    const result = await this.auditService.query(filter, parsed.page, parsed.limit);

    // Emit BULK_QUERY_EXECUTED when audit logs themselves are queried
    const ctx = getRequestContext();
    this.auditService.logFireAndForget({
      action: 'BULK_QUERY_EXECUTED',
      actor: authUser?.email ?? 'unknown',
      resourceType: 'audit',
      resourceId: 'audit_events',
      resourceName: 'Audit Log Query',
      description: `Audit logs queried (${result.total} results)`,
      payload: { metadata: { filter, resultCount: result.total } },
      tenantId: ctx?.tenantId ?? 'unknown',
    });

    return result;
  }

  @Get('stats')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get audit summary statistics' })
  async getStats() {
    return this.auditService.getStats();
  }

  @Get('verify-integrity')
  @Roles('super-admin')
  @ApiOperation({
    summary: 'Verify audit log hash-chain integrity for a time range (SOC2)',
    description:
      'Re-hashes every event of the window; chained events (seq) must link to the position ' +
      'before them, and missing positions are tampering unless a GDPR erasure recorded them ' +
      '(erasureGaps). legacyEventsChecked counts events written before hash version 2, whose ' +
      'hash does not cover the payload.',
  })
  @ApiQuery({ name: 'from', required: false, description: 'Start of time range (ISO 8601)' })
  @ApiQuery({ name: 'to', required: false, description: 'End of time range (ISO 8601)' })
  @ApiResponse({ status: 400, description: 'from or to is not an ISO 8601 time, or from > to' })
  async verifyIntegrity(@Query('from') from?: string, @Query('to') to?: string) {
    const window = TimeWindowSchema.parse({ from, to });
    const ctx = getRequestContext();
    const tenantId = ctx?.tenantId ?? 'unknown';
    return this.auditService.verifyIntegrity(tenantId, window.from, window.to);
  }

  // ── Merkle Tree Endpoints (Phase 2) ──────────────────────────────

  @Get('merkle-roots')
  @Roles('super-admin')
  @ApiOperation({ summary: 'List Merkle tree checkpoints' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '1 to 10000 (default 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1 to 100 (default 50)' })
  async getMerkleRoots(@Query('page') page?: string, @Query('limit') limit?: string) {
    const query = MerkleRootsQuerySchema.parse({ page, limit });
    const ctx = getRequestContext();
    const tenantId = ctx?.tenantId ?? 'unknown';
    return this.auditMerkleService.getMerkleRoots(tenantId, query.page, query.limit);
  }

  @Post('merkle-roots')
  @Roles('super-admin')
  @ApiOperation({
    summary: 'Create a Merkle checkpoint now',
    description:
      'Covers the chained audit events (seq) after the last checkpoint, at most ' +
      'AUDIT_CHECKPOINT_MAX_EVENTS of them, and signs it when an anchor key is configured. ' +
      'Writes an AUDIT_CHECKPOINT_CREATED audit event. The daily audit archive run makes them too, ' +
      'and once per tenant the legacy checkpoints (legacy: true) over the events written before ' +
      'hash version 2.',
  })
  @ApiResponse({ status: 201, description: 'The checkpoint (without its event hashes)' })
  @ApiResponse({ status: 400, description: 'No chained audit event since the last checkpoint' })
  @ApiResponse({
    status: 409,
    description: 'Another checkpoint over the same events was just made',
  })
  async createCheckpoint(@AuthUser() authUser?: AuthUserType) {
    const ctx = getRequestContext();
    const tenantId = ctx?.tenantId ?? 'unknown';
    const checkpoint = await this.auditMerkleService.createCheckpoint(tenantId);
    await this.auditService.log({
      action: 'AUDIT_CHECKPOINT_CREATED',
      actor: authUser?.email ?? 'unknown',
      resourceType: 'audit_checkpoint',
      resourceId: checkpoint.checkpointId,
      resourceName: 'Merkle checkpoint',
      description: `Merkle checkpoint created over ${checkpoint.eventCount} audit events`,
      payload: {
        metadata: {
          rootHash: checkpoint.rootHash,
          eventCount: checkpoint.eventCount,
          firstSeq: checkpoint.firstSeq,
          lastSeq: checkpoint.lastSeq,
          signed: !!checkpoint.anchorSignature,
        },
      },
      tenantId,
    });
    const { eventHashes: _leaves, ...listed } = checkpoint.toObject();
    return listed;
  }

  @Post('verify-event/:eventId')
  @Roles('super-admin')
  @ApiOperation({
    summary: 'Generate Merkle proof for a single audit event',
    description:
      'The checkpoint whose event hashes hold the event, its proof and root. legacy is true for ' +
      'a legacy checkpoint, with legacyNote saying what it proves and what it cannot.',
  })
  @ApiParam({ name: 'eventId', description: "The audit event's _id (24 hexadecimal characters)" })
  async verifyEvent(@Param('eventId') rawEventId: string) {
    const { eventId } = EventIdParamSchema.parse({ eventId: rawEventId });
    const ctx = getRequestContext();
    const tenantId = ctx?.tenantId ?? 'unknown';
    return this.auditMerkleService.verifyEvent(tenantId, eventId);
  }

  @Post('verify')
  @Roles('super-admin')
  @ApiOperation({
    summary: 'Check the Merkle checkpoints of a date range against the events they cover',
    description:
      'For each checkpoint created in the range (all without one): its stored root against its ' +
      'stored leaves, and every covered event still in the log re-hashed against its leaf. ' +
      'eventsMissing counts leaves whose event left the log (retention, GDPR erasure, deletion). ' +
      'legacyCheckpointsChecked counts legacy checkpoints, with legacyNote saying what they prove.',
  })
  @ApiBody({ required: false, description: '{ from?, to? } (ISO 8601), checkpoint creation time' })
  async verifyRange(@Body() body: unknown) {
    const window = TimeWindowSchema.parse(body ?? {});
    const ctx = getRequestContext();
    const tenantId = ctx?.tenantId ?? 'unknown';
    return this.auditMerkleService.verifyRange(
      tenantId,
      window.from ? new Date(window.from) : undefined,
      window.to ? new Date(window.to) : undefined,
    );
  }

  @Get('merkle-roots/:checkpointId/anchor')
  @Roles('super-admin')
  @ApiOperation({
    summary: 'Fetch the external anchor envelope for a Merkle checkpoint',
    description:
      'Returns the detached Ed25519 signature and canonical payload so an ' +
      'external verifier (holding only the public key) can prove the checkpoint ' +
      'was produced by the legitimate signer.',
  })
  @ApiParam({ name: 'checkpointId', description: "The checkpoint's checkpointId (UUID)" })
  async getAnchorEnvelope(@Param('checkpointId') rawCheckpointId: string) {
    const { checkpointId } = CheckpointIdParamSchema.parse({ checkpointId: rawCheckpointId });
    const ctx = getRequestContext();
    const tenantId = ctx?.tenantId ?? 'unknown';
    const checkpoint = await this.auditMerkleService.getCheckpoint(tenantId, checkpointId);
    if (!checkpoint) {
      throw new BadRequestException(`Checkpoint ${checkpointId} not found`);
    }
    const envelope = this.auditAnchorService.envelopeFromCheckpoint(checkpoint);
    if (!envelope) {
      throw new BadRequestException(`Checkpoint ${checkpointId} has not been anchored`);
    }
    const verified = this.auditAnchorService.verify(envelope);
    return { envelope, verified };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private toArray(value: string | string[] | undefined): string[] | undefined {
    if (!value) return undefined;
    if (Array.isArray(value)) return value;
    return [value];
  }
}
