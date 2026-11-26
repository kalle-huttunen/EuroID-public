/**
 * Audit Service
 *
 * Central audit logging service. All modules inject this service to emit
 * audit events. Also provides paginated query and statistics for the
 * Audit & Compliance dashboard.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

type FilterQuery<_T> = Record<string, unknown>;

import {
  AuditEvent,
  AuditEventDocument,
  AuditAction,
  AuditSeverity,
} from './schemas/audit-event.schema';
import { AuditChainHead, AuditChainHeadDocument } from './schemas/audit-chain-head.schema';
import { AuditChainWriter, isDuplicateKey } from './audit-chain-writer';
import { AuditChainVerifier } from './audit-chain-verifier';
import type { VerifyIntegrityResult } from './audit-integrity.types';
import { escapeRegex } from '@shared/utils/escape-regex';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';

// ── Filter interface ─────────────────────────────────────────────────

export interface AuditFilter {
  action?: AuditAction[];
  severity?: AuditSeverity[];
  actor?: string;
  resourceType?: string;
  resourceId?: string;
  targetSystem?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

export interface AuditQueryResult {
  data: AuditEventDocument[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AuditStats {
  total: number;
  critical: number;
  warnings: number;
  today: number;
}

// ── Log-event DTO ────────────────────────────────────────────────────

export interface LogAuditEvent {
  action: AuditAction;
  severity?: AuditSeverity;
  actor: string;
  resourceType: string;
  resourceId: string;
  resourceName: string;
  targetSystem?: string;
  description: string;
  payload?: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
  source?: string;
  tenantId: string;
  /** The domain event the entry records: one entry per event (a second log of it writes none). */
  eventId?: string;
}

export type {
  ErasureGap,
  IntegrityBreakReason,
  VerifyIntegrityResult,
} from './audit-integrity.types';

// ── Service ──────────────────────────────────────────────────────────

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly chain: AuditChainWriter;

  constructor(
    @InjectModel(AuditEvent.name)
    private readonly auditModel: Model<AuditEventDocument>,
    @InjectModel(AuditChainHead.name)
    private readonly chainHeadModel: Model<AuditChainHeadDocument>,
  ) {
    this.chain = new AuditChainWriter(auditModel, chainHeadModel);
  }

  /**
   * Fire-and-forget audit log. Use when audit must not block the critical path.
   * Failures are logged but not thrown. Prefer over .log().catch(() => {}) to avoid silent discard.
   */
  logFireAndForget(event: LogAuditEvent): void {
    this.log(event).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Audit] Fire-and-forget write failed: ${message}`);
    });
  }

  /**
   * Write an audit event at the next position of its tenant's hash chain (audit-chain-writer.ts):
   * it gets `seq`, links to the event before it and is hashed with hash version 2.
   * Fire-and-forget -- callers should not await this on the critical path
   * unless they need the document back.
   */
  async log(event: LogAuditEvent): Promise<AuditEventDocument> {
    try {
      const doc = await this.chain.append({ ...event, severity: event.severity ?? 'info' });
      this.logger.debug(
        `[Audit] ${event.action} by ${event.actor} on ${event.resourceType}/${event.resourceId}`,
      );
      return doc;
    } catch (error: unknown) {
      // The event is in the log already (a redelivery): the entry it has stands, the chain too
      if (event.eventId && isDuplicateKey(error)) {
        const existing = await this.auditModel
          .findOne({ tenantId: event.tenantId, eventId: event.eventId })
          .exec();
        if (existing) return existing;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[Audit] Failed to log event: ${message}`);
      throw error;
    }
  }

  /**
   * Verify the tenant's hash chain over a time window (audit-chain-verifier.ts): every event is
   * re-hashed, chained events must link to the position before them, and gaps are tampering unless
   * a GDPR erasure recorded them. Returns the first event that breaks the chain and why.
   */
  async verifyIntegrity(
    tenantId: string,
    from?: string,
    to?: string,
  ): Promise<VerifyIntegrityResult> {
    return new AuditChainVerifier(this.auditModel, this.chainHeadModel, tenantId).verify(
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }

  /**
   * Paginated, filtered query for the Audit dashboard.
   * When filter.search is present, uses $text query with relevance sorting.
   */
  async query(filter: AuditFilter, page = 1, limit = 50): Promise<AuditQueryResult> {
    limit = Math.min(limit, 100);
    const tenantId = getRequestContext()?.tenantId || 'default';
    const mongoFilter = this.buildFilter(filter, tenantId);
    const skip = (page - 1) * limit;
    const useTextSearch = !!filter.search;

    const findQuery = this.auditModel.find(mongoFilter);
    if (useTextSearch) {
      findQuery.select({ score: { $meta: 'textScore' } });
      findQuery.sort({ score: { $meta: 'textScore' }, timestamp: -1 });
    } else {
      findQuery.sort({ timestamp: -1 });
    }

    const [data, total] = await Promise.all([
      findQuery.skip(skip).limit(limit).exec(),
      this.auditModel.countDocuments(mongoFilter).exec(),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Summary statistics for the dashboard header.
   */
  async getStats(): Promise<AuditStats> {
    const tenantId = getRequestContext()?.tenantId || 'default';
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [total, critical, warnings, today] = await Promise.all([
      this.auditModel.countDocuments({ tenantId }).exec(),
      this.auditModel.countDocuments({ tenantId, severity: 'critical' }).exec(),
      this.auditModel.countDocuments({ tenantId, severity: 'warning' }).exec(),
      this.auditModel.countDocuments({ tenantId, timestamp: { $gte: todayStart } }).exec(),
    ]);

    return { total, critical, warnings, today };
  }

  // ── Private ────────────────────────────────────────────────────────

  private buildFilter(filter: AuditFilter, tenantId?: string): FilterQuery<AuditEventDocument> {
    const q: FilterQuery<AuditEventDocument> = {};
    if (tenantId) q.tenantId = tenantId;

    if (filter.action?.length) {
      q.action = { $in: filter.action };
    }
    if (filter.severity?.length) {
      q.severity = { $in: filter.severity };
    }
    if (filter.actor) {
      q.actor = { $regex: '^' + escapeRegex(filter.actor), $options: 'i' };
    }
    if (filter.resourceType) {
      q.resourceType = filter.resourceType;
    }
    if (filter.resourceId) {
      q.resourceId = filter.resourceId;
    }
    if (filter.targetSystem) {
      q.targetSystem = filter.targetSystem;
    }
    if (filter.dateFrom || filter.dateTo) {
      const ts: Record<string, Date> = {};
      if (filter.dateFrom) ts.$gte = new Date(filter.dateFrom);
      if (filter.dateTo) ts.$lte = new Date(filter.dateTo);
      q.timestamp = ts;
    }
    if (filter.search) {
      q.$text = { $search: filter.search };
    }

    return q;
  }
}

// --- TASK_104 recap: $text search (replaces $regex), escapeRegex for actor prefix, relevance sort when searching.
