/**
 * Risk Scoring Service
 *
 * Computes composite risk score (0-100) per identity from 7 factors:
 * entitlement count, high-risk entitlements, SoD violations, anomaly history, admin tier, dormancy, peer deviation.
 */

import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import type { RiskScoreDocument, RiskFactor, RiskTrend } from './schemas/risk-score.schema';
import { IdentityRiskScore } from './schemas/risk-score.schema';
import { IdentityService } from '../identity/identity.service';
import { PolicyEngineService } from '../policy/policy-engine.service';
import type {
  ProvisioningOperation,
  PolicyProvisioningIntent,
} from '../policy/policy-engine.service';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { AuditFilter } from '../audit/audit.service';
import { AuditService } from '../audit/audit.service';
import { Anomaly } from '../anomaly/schemas/anomaly.schema';
import type { AnomalyDocument } from '../anomaly/schemas/anomaly.schema';
import { EntitlementCatalog } from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import type { EntitlementCatalogDocument } from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import type { LinkedAdminAccount } from '../identity/schemas/identity.schema';
import { NOT_DELETED } from '../identity/identity.constants';
import { normalizeSystemName } from '@shared/utils/normalize-system-name';
import {
  type RiskScoringConfig,
  riskScoringConfig,
} from '@infrastructure/config/risk-scoring.config';
import { IntelligenceService } from '../intelligence/intelligence.service';

const HISTORY_MAX_ENTRIES = 30;

/** Where a tenant's batch stands: the offset of the next identity, the counts and the average. */
export interface RiskBatchProgress {
  offset: number;
  processed: number;
  errors: number;
  orgAverage: number;
}
const TREND_DELTA_THRESHOLD = 5;

// ── Service ─────────────────────────────────────────────────────────────

@Injectable()
export class RiskScoringService {
  private readonly logger = new Logger(RiskScoringService.name);

  constructor(
    @InjectModel(IdentityRiskScore.name) private readonly riskScoreModel: Model<RiskScoreDocument>,
    @InjectModel(Anomaly.name) private readonly anomalyModel: Model<AnomalyDocument>,
    @InjectModel(EntitlementCatalog.name)
    private readonly catalogModel: Model<EntitlementCatalogDocument>,
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly identityService: IdentityService,
    private readonly policyEngine: PolicyEngineService,
    private readonly auditService: AuditService,
    private readonly intelligenceService: IntelligenceService,
    @Inject(riskScoringConfig.KEY) private readonly riskConf: RiskScoringConfig,
  ) {}

  /**
   * Calculate risk score for a single identity.
   */
  async calculateForIdentity(
    tenantId: string,
    identityId: string,
    orgEntitlementAverage: number,
    now: Date,
  ): Promise<RiskScoreDocument> {
    const user = await this.identityService.findOne(identityId);
    const rawIdentity = await this.identityModel
      .findById(identityId)
      .select('adminTier linkedAdminAccounts deletedAt')
      .lean()
      .exec();
    if (!user || rawIdentity?.deletedAt) {
      throw new NotFoundException(`Identity ${identityId} not found or deleted`);
    }

    // A failed evaluation fails the identity's score (counted as an error by batchCalculate): read
    // as "no entitlements" it wrote a low score and a DECREASING trend, and the old one is right
    const evalResult: {
      intent: Pick<PolicyProvisioningIntent, 'operations'>;
      sodViolationCount: number;
    } = await this.policyEngine.evaluateForRiskScoring(
      user as unknown as StandardUserDto,
      tenantId,
    );

    const entitlementCount = evalResult.intent.operations.filter(
      (op) => op.action === 'add' && (op.type === 'group' || op.type === 'license'),
    ).length;

    const highRiskCount = await this.countHighRiskEntitlements(
      tenantId,
      evalResult.intent.operations.filter(
        (op) => op.action === 'add' && (op.type === 'group' || op.type === 'license'),
      ),
    );

    const sodCount = evalResult.sodViolationCount;

    const anomalyCount = await this.countAnomaliesLast90Days(identityId, tenantId, now);

    const adminTierScore = await this.getAdminTierScore(tenantId, rawIdentity ?? user);

    const dormantScore = await this.getDormantScore(identityId, tenantId, now);

    let peerDeviationScore = 0;
    try {
      peerDeviationScore = await this.intelligenceService.getPeerDeviationScore(
        tenantId,
        identityId,
      );
    } catch {
      // Peer groups may not be built yet — gracefully default to 0
      peerDeviationScore = 0;
    }
    const peerDeviationNorm = peerDeviationScore; // already 0-100

    const avg = Math.max(1, orgEntitlementAverage);
    const entitlementNorm = Math.min((entitlementCount / avg) * 50, 100);
    const highRiskNorm = Math.min(highRiskCount * 25, 100);
    const sodNorm = Math.min(sodCount * 33, 100);
    const anomalyNorm = Math.min(anomalyCount * 20, 100);

    const w = this.riskConf;
    const factors: Array<{
      factor: RiskFactor;
      weight: number;
      rawValue: number;
      contribution: number;
    }> = [
      {
        factor: 'entitlement_count',
        weight: w.weightEntitlement,
        rawValue: entitlementCount,
        contribution: (entitlementNorm * w.weightEntitlement) / 100,
      },
      {
        factor: 'high_risk_entitlements',
        weight: w.weightHighRisk,
        rawValue: highRiskCount,
        contribution: (highRiskNorm * w.weightHighRisk) / 100,
      },
      {
        factor: 'sod_violations',
        weight: w.weightSod,
        rawValue: sodCount,
        contribution: (sodNorm * w.weightSod) / 100,
      },
      {
        factor: 'anomaly_count',
        weight: w.weightAnomaly,
        rawValue: anomalyCount,
        contribution: (anomalyNorm * w.weightAnomaly) / 100,
      },
      {
        factor: 'admin_tier',
        weight: w.weightAdmin,
        rawValue: adminTierScore,
        contribution: (adminTierScore * w.weightAdmin) / 100,
      },
      {
        factor: 'dormant',
        weight: w.weightDormant,
        rawValue: dormantScore,
        contribution: (dormantScore * w.weightDormant) / 100,
      },
      {
        factor: 'peer_deviation',
        weight: w.weightPeerDeviation,
        rawValue: peerDeviationScore,
        contribution: (peerDeviationNorm * w.weightPeerDeviation) / 100,
      },
    ];

    const score = Math.min(100, Math.round(factors.reduce((s, f) => s + f.contribution, 0)));

    const existing = await this.riskScoreModel.findOne({ tenantId, identityId }).lean().exec();
    const prevScore = existing?.score ?? null;
    let trend: RiskTrend = 'STABLE';
    if (prevScore !== null) {
      const delta = score - prevScore;
      if (delta > TREND_DELTA_THRESHOLD) trend = 'INCREASING';
      else if (delta < -TREND_DELTA_THRESHOLD) trend = 'DECREASING';
    }

    const history = [...(existing?.history ?? [])];
    history.push({ date: now, score });
    if (history.length > HISTORY_MAX_ENTRIES) {
      history.splice(0, history.length - HISTORY_MAX_ENTRIES);
    }

    const doc = await this.riskScoreModel.findOneAndUpdate(
      { tenantId, identityId },
      {
        $set: {
          score,
          factors,
          trend,
          history,
          calculatedAt: now,
        },
      },
      { upsert: true, new: true },
    );

    return doc as RiskScoreDocument;
  }

  /**
   * Score every live identity of the tenant, in pages of `batchSize`. The organisation's average
   * entitlement count is taken from the first page. `progress.onProgress` gets, after each
   * identity, the offset of the next one with the counts so far and the average (the per-tenant
   * activity heartbeats it); `progress.resume` (a retried activity's last heartbeat) goes on from
   * there with those, scoring no identity twice.
   */
  async batchCalculate(
    tenantId: string,
    batchSize: number,
    now: Date,
    progress?: {
      resume?: RiskBatchProgress;
      onProgress?: (state: RiskBatchProgress) => void;
    },
  ): Promise<{ processed: number; errors: number }> {
    const resume = progress?.resume;
    let processed = resume?.processed ?? 0;
    let errors = resume?.errors ?? 0;
    let offset = resume?.offset ?? 0;

    const { users: firstPage, total: totalIdentities } =
      await this.identityService.findUsersPageForReconciliation(0, batchSize);
    if (!totalIdentities || totalIdentities === 0) return { processed, errors };
    const orgAverage =
      resume?.orgAverage ?? (await this.orgEntitlementAverage(firstPage, tenantId));

    while (offset < totalIdentities) {
      const batch =
        offset === 0
          ? firstPage
          : (await this.identityService.findUsersPageForReconciliation(offset, batchSize)).users;
      if (batch.length === 0) break;

      for (const user of batch) {
        const userRecord = user as Record<string, unknown>;
        const id = String(userRecord._id ?? userRecord.id ?? userRecord.email ?? '');
        if (id) {
          try {
            await this.calculateForIdentity(tenantId, id, orgAverage, now);
            processed++;
          } catch (err: unknown) {
            this.logger.warn(
              `Risk score failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
            );
            errors++;
          }
        }
        offset++;
        progress?.onProgress?.({ offset, processed, errors, orgAverage });
      }
    }

    return { processed, errors };
  }

  /** The average count of entitlements the policy grants the identities of `users` (at least 1). */
  private async orgEntitlementAverage(
    users: Record<string, unknown>[],
    tenantId: string,
  ): Promise<number> {
    let entitlementSum = 0;
    let entitlementCount = 0;
    for (const u of users) {
      try {
        const result = await this.policyEngine.evaluateForRiskScoring(
          u as unknown as StandardUserDto,
          tenantId,
        );
        const count = result.intent.operations.filter(
          (op) => op.action === 'add' && (op.type === 'group' || op.type === 'license'),
        ).length;
        entitlementSum += count;
        entitlementCount++;
      } catch {
        // skip
      }
    }
    return entitlementCount > 0 ? entitlementSum / entitlementCount : 1;
  }

  async getTopRisky(
    tenantId: string,
    limit: number,
    minScore?: number,
  ): Promise<RiskScoreDocument[]> {
    const q: Record<string, unknown> = { tenantId };
    if (minScore != null) q.score = { $gte: minScore };
    return this.riskScoreModel.find(q).sort({ score: -1 }).limit(limit).lean().exec() as Promise<
      RiskScoreDocument[]
    >;
  }

  /** The tenant's average risk score (one decimal), undefined when it has none. */
  async getAverageScore(tenantId: string): Promise<number | undefined> {
    const [row] = await this.riskScoreModel
      .aggregate<{
        average: number;
      }>([{ $match: { tenantId } }, { $group: { _id: null, average: { $avg: '$score' } } }])
      .exec();
    return row ? Math.round(row.average * 10) / 10 : undefined;
  }

  async getDistribution(
    tenantId: string,
  ): Promise<{ buckets: { range: string; count: number }[]; average: number; median: number }> {
    const bucketDefs = [
      { range: '0-10', min: 0, max: 10 },
      { range: '11-25', min: 11, max: 25 },
      { range: '26-50', min: 26, max: 50 },
      { range: '51-75', min: 51, max: 75 },
      { range: '76-100', min: 76, max: 100 },
    ];
    const buckets: { range: string; count: number }[] = [];
    for (const b of bucketDefs) {
      const count = await this.riskScoreModel
        .countDocuments({
          tenantId,
          score: { $gte: b.min, $lte: b.max },
        })
        .exec();
      buckets.push({ range: b.range, count });
    }

    const scores = await this.riskScoreModel.find({ tenantId }).select('score').lean().exec();
    const scoreArr = scores.map((s) => s.score).sort((a, b) => a - b);
    const total = scoreArr.length;
    const average = total > 0 ? scoreArr.reduce((s, v) => s + v, 0) / total : 0;
    const median =
      total > 0
        ? total % 2 === 1
          ? scoreArr[Math.floor(total / 2)]
          : (scoreArr[total / 2 - 1] + scoreArr[total / 2]) / 2
        : 0;

    return {
      buckets,
      average: Math.round(average * 10) / 10,
      median: Math.round(median * 10) / 10,
    };
  }

  async getForIdentity(identityId: string): Promise<RiskScoreDocument | null> {
    const doc = await this.riskScoreModel.findOne({ identityId }).lean().exec();
    return doc as RiskScoreDocument | null;
  }

  private async countHighRiskEntitlements(
    tenantId: string,
    operations: Array<{ target: string; targetId: string }>,
  ): Promise<number> {
    if (operations.length === 0) return 0;
    const systems = [...new Set(operations.map((o) => this.targetToCatalogSystem(o.target)))];
    const targetIds = operations.map((o) => o.targetId?.trim()).filter(Boolean);
    if (targetIds.length === 0) return 0;

    const escaped = targetIds.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const highRisk = await this.catalogModel
      .find({
        tenantId,
        system: { $in: systems },
        riskLevel: { $in: ['HIGH', 'CRITICAL'] },
        $or: [
          { nativeId: { $in: targetIds } },
          { name: { $in: targetIds } },
          ...escaped.map((t) => ({ name: { $regex: `^${t}$`, $options: 'i' } })),
        ],
      })
      .countDocuments()
      .exec();
    return highRisk;
  }

  private targetToCatalogSystem(target: string): string {
    const n = normalizeSystemName(target);
    if (n === 'entra' || n === 'entraid') return 'entra-id';
    if (n === 'ad' || n === 'activedirectory') return 'ad';
    return target;
  }

  private async countAnomaliesLast90Days(
    identityId: string,
    tenantId: string,
    now: Date,
  ): Promise<number> {
    const since = new Date(now);
    since.setDate(since.getDate() - this.riskConf.anomalyLookbackDays);
    // Anomalies still open or acknowledged: a dismissed or resolved one is no risk signal
    const count = await this.anomalyModel
      .countDocuments({
        identityId,
        tenantId,
        status: { $in: ['open', 'acknowledged'] },
        detectedAt: { $gte: since },
      })
      .exec();
    return count;
  }

  /**
   * The identity's own admin tier, else the highest tier of its ACTIVE linked admin accounts
   * whose admin identity is live: an entry can read ACTIVE for an admin identity deleted before
   * deletion ended entries (IdentityMutationService.markAsDeleted), which holds no account.
   */
  private async getAdminTierScore(
    tenantId: string,
    user: { adminTier?: string; linkedAdminAccounts?: LinkedAdminAccount[] },
  ): Promise<number> {
    const adminTier = user.adminTier;
    if (adminTier === 'TIER_0') return 100;
    if (adminTier === 'TIER_1') return 60;
    if (adminTier === 'TIER_2') return 30;

    // identityId is a free string: one that is no ObjectId names no identity (and would fail the
    // query with a CastError), as findLiveLinkedAdmins treats it
    const active = (user.linkedAdminAccounts ?? []).filter(
      (a) => a.status === 'ACTIVE' && isValidObjectId(a.identityId),
    );
    if (active.length === 0) return 0;
    const live = await this.identityModel
      .find({ _id: { $in: active.map((a) => a.identityId) }, tenantId, ...NOT_DELETED })
      .select('_id')
      .lean()
      .exec();
    const liveIds = new Set(live.map((doc) => String(doc._id)));
    const tiers = active.filter((a) => liveIds.has(a.identityId)).map((a) => a.adminTier);
    if (tiers.includes('TIER_0')) return 100;
    if (tiers.includes('TIER_1')) return 60;
    if (tiers.includes('TIER_2')) return 30;
    return 0;
  }

  private async getDormantScore(identityId: string, tenantId: string, now: Date): Promise<number> {
    const since = new Date(now);
    since.setDate(since.getDate() - this.riskConf.dormancyDays);
    const auditFilter: AuditFilter = {
      action: ['provisioning.completed', 'provisioning.started'],
      resourceType: 'identity',
      resourceId: identityId,
      dateFrom: since.toISOString(),
    };
    const result = await this.auditService.query(auditFilter, 1, 1);
    return result.total > 0 ? 0 : 100;
  }
}
