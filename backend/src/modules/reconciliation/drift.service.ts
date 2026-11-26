/**
 * Drift Service
 *
 * CRUD operations for drift records. Supports the Drift Dashboard
 * with listing, filtering, auto-correction, ignore, and bulk actions.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { paginateQuery } from '@shared/utils/paginate-query';

type FilterQuery<_T> = Record<string, unknown>;

import {
  Drift,
  DriftDocument,
  DriftType,
  DriftSeverity,
  DriftStatus,
} from './schemas/drift.schema';
import { DriftCorrectionService, type CorrectionResult } from './drift-correction.service';
import { OrphanCleanupService } from './orphan-cleanup.service';
import { maskEmails } from '../../activities/deprovision-failure';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';

/**
 * The statuses an admin can correct or ignore: an open drift, and a quarantined orphan drift
 * (still awaiting Adopt or Delete, as OrphanCleanupService treats it).
 */
const UNDECIDED: DriftStatus[] = ['open', 'quarantined'];

// ── Filter DTO ───────────────────────────────────────────────────────

export interface DriftFilter {
  severity?: DriftSeverity | DriftSeverity[];
  type?: DriftType | DriftType[];
  targetSystem?: string;
  status?: DriftStatus;
  userId?: string;
  /** Search in userDisplayName or userEmail (case-insensitive) */
  search?: string;
}

export interface DriftListResult {
  drifts: DriftDocument[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** A drift bulk correction did not correct, and why. */
export interface BulkCorrectionFailure {
  driftId: string;
  error: string;
}

export interface BulkCorrectionResult {
  corrected: number;
  failed: BulkCorrectionFailure[];
}

/** A drift one reconciliation run detected for one identity (activities/reconciliation.activities.ts). */
export interface DetectedDrift {
  targetSystem: string;
  type: DriftType;
  field?: string;
  severity: DriftSeverity;
  hubValue?: string;
  targetValue?: string;
  autoCorrectEligible: boolean;
}

/** The identity a run checked, and the target systems whose account it could read. */
export interface DetectionScope {
  identityId: string;
  displayName: string;
  email: string;
  checkedSystems: string[];
}

/** The drift types reconciliation detects; other open drifts (orphans, hand-made) it never closes. */
const DETECTED_TYPES: DriftType[] = ['MISSING_USER', 'FIELD_MISMATCH', 'STATUS_MISMATCH'];

/** One drift per identity, system, type and field: the key repeated runs find it by. */
function driftKey(d: { targetSystem: string; type: string; field?: string | null }): string {
  return `${d.targetSystem}|${d.type}|${d.field ?? ''}`;
}

/** Why a correction failed, as single Correct (400) and bulk correction both report it. */
function correctionFailure(result: CorrectionResult): string {
  return result.error ?? 'Unknown error';
}

// ── Service ──────────────────────────────────────────────────────────

@Injectable()
export class DriftService {
  private readonly logger = new Logger(DriftService.name);

  constructor(
    @InjectModel(Drift.name)
    private readonly driftModel: Model<DriftDocument>,
    private readonly driftCorrection: DriftCorrectionService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly orphanCleanup: OrphanCleanupService,
  ) {}

  /**
   * Save a drift record (orphan detection).
   */
  async saveDrift(drift: Partial<Drift>): Promise<DriftDocument> {
    return this.driftModel.create({
      ...drift,
      status: drift.status ?? 'open',
      detectedAt: drift.detectedAt ?? new Date(),
    });
  }

  /**
   * Store what one reconciliation run detected for one identity. A drift already open (same
   * identity, system, type and field) gets the latest values and keeps its detectedAt; one the
   * admin ignored with the same values stays ignored; any other is added open. An open drift of
   * a checked system that the run no longer detects is closed as corrected (drift.resolved,
   * `no_longer_detected`). Systems the run could not read keep their drifts as they are.
   */
  async recordDetection(scope: DetectionScope, drifts: DetectedDrift[]): Promise<void> {
    const tenantId = this.getTenantId();
    const userId = scope.identityId;
    const now = new Date();
    for (const d of drifts) {
      const key = { tenantId, userId, targetSystem: d.targetSystem, type: d.type };
      const values = { hubValue: d.hubValue ?? null, targetValue: d.targetValue ?? null };
      const field = d.field ?? null;
      if (await this.driftModel.exists({ ...key, field, ...values, status: 'ignored' })) continue;
      await this.driftModel.updateOne(
        { ...key, field, status: 'open' },
        {
          $set: {
            ...values,
            severity: d.severity,
            autoCorrectEligible: d.autoCorrectEligible,
            userDisplayName: scope.displayName,
            userEmail: scope.email,
          },
          $setOnInsert: { detectedAt: now },
        },
        { upsert: true },
      );
    }

    if (scope.checkedSystems.length === 0) return;
    const detected = new Set(drifts.map(driftKey));
    const open = await this.driftModel
      .find({
        tenantId,
        userId,
        status: 'open',
        targetSystem: { $in: scope.checkedSystems },
        type: { $in: DETECTED_TYPES },
      })
      .exec();
    const gone = open.filter((drift) => !detected.has(driftKey(drift)));
    if (gone.length === 0) return;
    await this.driftModel.updateMany(
      { _id: { $in: gone.map((drift) => drift._id) }, tenantId, status: 'open' },
      { $set: { status: 'corrected', correctedAt: now } },
    );
    for (const drift of gone) this.emitResolved(drift, 'no_longer_detected');
  }

  /**
   * Close the open drift a reconciliation run's auto-correction fixed (drift.resolved,
   * `reconciliation_auto_correct`). Nothing happens when no such drift is open.
   */
  async closeCorrectedDrift(
    identityId: string,
    targetSystem: string,
    type: DriftType,
    field?: string,
  ): Promise<void> {
    const tenantId = this.getTenantId();
    const drift = await this.driftModel.findOneAndUpdate(
      { tenantId, userId: identityId, targetSystem, type, field: field ?? null, status: 'open' },
      { $set: { status: 'corrected', correctedAt: new Date() } },
      { new: true },
    );
    if (drift) this.emitResolved(drift, 'reconciliation_auto_correct');
  }

  /**
   * Open drifts per identity, for the identities given (the identity hub's drift column).
   * Identities without an open drift are not in the answer.
   */
  async countOpenByUser(userIds: string[]): Promise<Record<string, number>> {
    const tenantId = this.getTenantId();
    const rows: Array<{ _id: string; count: number }> = await this.driftModel
      .aggregate([
        { $match: { tenantId, status: 'open', userId: { $in: userIds } } },
        { $group: { _id: '$userId', count: { $sum: 1 } } },
      ])
      .exec();
    return Object.fromEntries(rows.map((row) => [row._id, row.count]));
  }

  /**
   * Get a single drift by ID.
   */
  async getDriftById(driftId: string): Promise<DriftDocument | null> {
    const tenantId = this.getTenantId();
    return this.driftModel.findOne({ _id: driftId, tenantId }).exec();
  }

  /**
   * List drifts with optional filtering and pagination.
   */
  async getDrifts(filter?: DriftFilter): Promise<DriftDocument[]>;
  async getDrifts(filter?: DriftFilter, page?: number, limit?: number): Promise<DriftListResult>;
  async getDrifts(
    filter?: DriftFilter,
    page?: number,
    limit?: number,
  ): Promise<DriftDocument[] | DriftListResult> {
    const q = this.buildFilter(filter);
    const sort = { detectedAt: -1 } as const;

    if (page != null && limit != null) {
      const skip = (page - 1) * limit;
      const result = await paginateQuery(this.driftModel, q, {
        skip,
        limit,
        sort: { detectedAt: -1 },
      });
      return {
        drifts: result.items as DriftDocument[],
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      };
    }
    return this.driftModel.find(q).sort(sort).limit(500).exec();
  }

  /**
   * Get summary statistics for the dashboard header.
   */
  async getStats(): Promise<{
    total: number;
    critical: number;
    autoFixEligible: number;
    pending: number;
  }> {
    const tenantId = this.getTenantId();
    const [result] = await this.driftModel
      .aggregate([
        { $match: { status: 'open', tenantId } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            critical: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
            autoFixEligible: { $sum: { $cond: ['$autoCorrectEligible', 1, 0] } },
            pending: { $sum: { $cond: [{ $not: '$autoCorrectEligible' }, 1, 0] } },
          },
        },
      ])
      .exec();
    return {
      total: result?.total ?? 0,
      critical: result?.critical ?? 0,
      autoFixEligible: result?.autoFixEligible ?? 0,
      pending: result?.pending ?? 0,
    };
  }

  /**
   * Auto-correct a single drift. Performs actual correction in target system
   * (Entra, AD) for non-ORPHAN_ACCOUNT drifts before updating status. An orphan drift's cleanup
   * is stopped first (stopOrphanCleanup). A corrected or ignored drift is 409: its stored value
   * may be stale, and correcting it again would write that to the target.
   */
  async autoCorrect(driftId: string): Promise<DriftDocument> {
    const tenantId = this.getTenantId();
    const drift = await this.findUndecided(driftId, tenantId, 'corrected');

    const result = await this.driftCorrection.executeCorrection(drift, tenantId);
    if (!result.skipConnector && !result.success) {
      throw new BadRequestException(`Correction failed: ${correctionFailure(result)}`);
    }
    await this.stopOrphanCleanup(drift);

    drift.status = 'corrected';
    drift.correctedAt = new Date();
    await drift.save();

    this.eventEmitter.emit(DomainEventType.DRIFT_RESOLVED, drift.userId, {
      driftId,
      identityId: drift.userId,
      system: drift.targetSystem,
      resolutionAction: 'auto_correct',
    });

    return drift;
  }

  /**
   * Ignore a drift (mark as not requiring action). An orphan drift's cleanup is stopped first
   * (stopOrphanCleanup). A corrected or ignored drift is 409: relabelled ignored, a corrected
   * drift that recurs with the same values would never be recorded again (recordDetection).
   */
  async ignoreDrift(driftId: string): Promise<DriftDocument> {
    const tenantId = this.getTenantId();
    const drift = await this.findUndecided(driftId, tenantId, 'ignored');
    await this.stopOrphanCleanup(drift);

    drift.status = 'ignored';
    await drift.save();
    return drift;
  }

  /**
   * Bulk auto-correct multiple drifts. Performs actual correction in target
   * systems for non-ORPHAN_ACCOUNT drifts before updating status. Every requested drift it did
   * not correct is in `failed` with the reason: not found, not open, or the reason single
   * Correct answers for it.
   */
  async bulkAutoCorrect(driftIds: string[]): Promise<BulkCorrectionResult> {
    const tenantId = this.getTenantId();
    const ids = [...new Set(driftIds)];
    const found = await this.driftModel.find({ _id: { $in: ids }, tenantId }).exec();
    const byId = new Map(found.map((drift) => [drift._id.toString(), drift]));

    const correctedDrifts: DriftDocument[] = [];
    const failed: BulkCorrectionFailure[] = [];
    for (const driftId of ids) {
      const drift = byId.get(driftId);
      if (!drift) {
        failed.push({ driftId, error: `Drift ${driftId} not found` });
      } else if (drift.status !== 'open') {
        failed.push({ driftId, error: `Drift ${driftId} is ${drift.status}, not open` });
      } else {
        const result = await this.driftCorrection.executeCorrection(drift, tenantId);
        if (result.skipConnector || result.success) {
          correctedDrifts.push(drift);
          continue;
        }
        const error = correctionFailure(result);
        failed.push({ driftId, error });
        this.logger.warn(
          `[DriftService] Bulk correction failed for drift ${driftId}: ${maskEmails(error)}`,
        );
      }
    }

    if (correctedDrifts.length === 0) return { corrected: 0, failed };

    const correctedIds = correctedDrifts.map((drift) => drift._id.toString());
    const result = await this.driftModel.updateMany(
      { _id: { $in: correctedIds }, tenantId },
      { $set: { status: 'corrected', correctedAt: new Date() } },
    );
    for (const drift of correctedDrifts) {
      this.eventEmitter.emit(DomainEventType.DRIFT_RESOLVED, drift.userId, {
        driftId: drift._id.toString(),
        identityId: drift.userId,
        system: drift.targetSystem,
        resolutionAction: 'bulk_auto_correct',
      });
    }
    return { corrected: result.modifiedCount, failed };
  }

  /**
   * Bulk ignore multiple drifts.
   */
  async bulkIgnore(driftIds: string[]): Promise<number> {
    const tenantId = this.getTenantId();
    const result = await this.driftModel.updateMany(
      { _id: { $in: driftIds }, status: 'open', tenantId },
      { $set: { status: 'ignored' } },
    );
    return result.modifiedCount;
  }

  /** The orphan drifts recorded for one target account, oldest first (orphan detection). */
  async findOrphanDrifts(targetSystem: string, externalId: string): Promise<DriftDocument[]> {
    const tenantId = this.getTenantId();
    return this.driftModel
      .find({
        tenantId,
        type: 'ORPHAN_ACCOUNT',
        'orphanDetails.targetSystem': targetSystem,
        'orphanDetails.externalId': externalId,
      })
      .sort({ detectedAt: 1 })
      .exec();
  }

  /**
   * Update drift with orphan cleanup workflow ID (for signaling).
   */
  async updateDriftWorkflowId(driftId: string, workflowId: string): Promise<DriftDocument | null> {
    const tenantId = this.getTenantId();
    const drift = await this.driftModel.findOneAndUpdate(
      { _id: driftId, tenantId },
      { $set: { workflowId } },
      { new: true },
    );
    return drift;
  }

  /**
   * Close an undecided (open or quarantined) orphan drift whose account is no longer an orphan:
   * `corrected`, `correctedAt` now, `drift.resolved` with `resolutionAction`. A decided drift is
   * left as it is. The orphan cleanup's check before it acts (OrphanActivities.confirmOrphan).
   */
  async closeOrphanDrift(driftId: string, resolutionAction: string): Promise<void> {
    const tenantId = this.getTenantId();
    const drift = await this.driftModel.findOneAndUpdate(
      { _id: driftId, tenantId, type: 'ORPHAN_ACCOUNT', status: { $in: UNDECIDED } },
      { $set: { status: 'corrected', correctedAt: new Date() } },
      { new: true },
    );
    if (drift) this.emitResolved(drift, resolutionAction);
  }

  /**
   * Update orphan drift status and decision (for ADOPT/DELETE resolution).
   */
  async updateOrphanDrift(
    driftId: string,
    updates: {
      status?: DriftStatus;
      correctedAt?: Date;
      'orphanDetails.decision'?: 'DELETE' | 'ADOPT';
      'orphanDetails.decidedBy'?: string;
      'orphanDetails.adoptedIdentityId'?: string;
      'orphanDetails.disabledAt'?: Date;
      'orphanDetails.keptReason'?: string;
    },
  ): Promise<DriftDocument | null> {
    const tenantId = this.getTenantId();
    const drift = await this.driftModel.findOneAndUpdate(
      { _id: driftId, tenantId, type: 'ORPHAN_ACCOUNT' },
      { $set: updates },
      { new: true },
    );
    return drift;
  }

  // ── Private ────────────────────────────────────────────────────────

  /** The drift to correct or ignore: 404 when the tenant has none, 409 when it is decided. */
  private async findUndecided(
    driftId: string,
    tenantId: string,
    action: 'corrected' | 'ignored',
  ): Promise<DriftDocument> {
    const drift = await this.driftModel.findOne({ _id: driftId, tenantId });
    if (!drift) throw new NotFoundException(`Drift ${driftId} not found`);
    if (!UNDECIDED.includes(drift.status)) {
      throw new ConflictException(
        `Drift ${driftId} is ${drift.status}: only an open drift, or a quarantined orphan drift, can be ${action}`,
      );
    }
    return drift;
  }

  /**
   * An orphan drift closed by hand stops its cleanup workflow, which would otherwise still
   * disable the account and, with ORPHAN_AUTO_DELETE_AFTER_EXTENDED, delete it. Done before the
   * drift is saved: a cleanup that cannot be stopped fails the request and leaves the drift open.
   */
  private async stopOrphanCleanup(drift: DriftDocument): Promise<void> {
    if (drift.type === 'ORPHAN_ACCOUNT' && drift.workflowId) {
      await this.orphanCleanup.stop(drift.workflowId);
    }
  }

  private getTenantId(): string {
    return getRequestContext()?.tenantId || 'default';
  }

  private emitResolved(drift: DriftDocument, resolutionAction: string): void {
    this.eventEmitter.emit(DomainEventType.DRIFT_RESOLVED, drift.userId, {
      driftId: drift._id.toString(),
      identityId: drift.userId,
      system: drift.targetSystem,
      resolutionAction,
    });
  }

  private buildFilter(filter?: DriftFilter): FilterQuery<DriftDocument> {
    const tenantId = this.getTenantId();
    const q: FilterQuery<DriftDocument> = { tenantId };
    if (!filter) return q;

    if (filter.severity) {
      q.severity = Array.isArray(filter.severity) ? { $in: filter.severity } : filter.severity;
    }
    if (filter.type) {
      q.type = Array.isArray(filter.type) ? { $in: filter.type } : filter.type;
    }
    if (filter.targetSystem) q.targetSystem = filter.targetSystem;
    if (filter.status) q.status = filter.status;
    if (filter.userId) q.userId = filter.userId;
    if (filter.search && filter.search.trim()) {
      const term = filter.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(term, 'i');
      q.$or = [{ userDisplayName: re }, { userEmail: re }];
    }

    return q;
  }
}
