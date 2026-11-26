/**
 * Access Anomaly Service
 *
 * Detects suspicious access patterns using rule-based heuristics.
 * Uses audit logs, user event timeline, policy engine, and entitlement catalog.
 */

import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { type AnomalyConfig, anomalyConfig } from '@infrastructure/config/anomaly.config';
import { Anomaly, AnomalyDocument, AnomalyType, AnomalyStatus } from './schemas/anomaly.schema';
import { RiskScore, RiskScoreDocument } from './schemas/risk-score.schema';
import {
  timeBasedRule,
  peerDeviationRule,
  velocityRule,
  privilegeEscalationRule,
  orphanAccessRule,
  ANOMALY_TYPE_SCORES,
  type AnomalyCandidate,
} from './anomaly-rules';
import { AuditService } from '../audit/audit.service';
import type { AuditAction } from '../audit/schemas/audit-event.schema';
import { UserEventService } from '../identity/user-event.service';
import { IdentityService } from '../identity/identity.service';
import { PolicyEngineService } from '../policy/policy-engine.service';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EntraService } from '../connectors/entra-connector/entra.service';
import { publicIdFilter } from '@shared/pipes/parse-public-id.pipe';
import { maskPersonalData } from '../../activities/deprovision-failure';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { privilegeGroupChanges } from './anomaly-privilege-groups';

// ── Filter ────────────────────────────────────────────────────────────

export interface AnomalyFilter {
  identityId?: string;
  type?: AnomalyType | AnomalyType[];
  severity?: string | string[];
  status?: AnomalyStatus;
}

// ── Analysis result ───────────────────────────────────────────────────

/** Identities one run without `identityId` analyses: its rules are too heavy for a whole tenant. */
export const ANALYSIS_DEFAULT_LIMIT = 50;

/** Rules that threw during a run: counts only, the causes go to the log. */
export interface AnomalyRuleFailures {
  /** Distinct rules that failed for at least one identity. */
  rules: number;
  /** Identities with at least one failed rule. */
  identities: number;
  /** Per rule (the anomaly type it detects): the identities it failed for. */
  byRule: Partial<Record<AnomalyType, number>>;
}

export interface AnomalyAnalysisResult {
  /** Identities the rules ran for. */
  analyzed: number;
  /** Identities the run could cover: the tenant's (not deleted) for a page, 1 for a found identity. */
  totalIdentities: number;
  anomaliesCreated: number;
  identityIds: string[];
  ruleFailures: AnomalyRuleFailures;
}

// ── Status changes ────────────────────────────────────────────────────

type StatusChange = Exclude<AnomalyStatus, 'open'>;

/** The statuses each change may start from: resolved and dismissed are final. */
const ALLOWED_FROM: Record<StatusChange, AnomalyStatus[]> = {
  acknowledged: ['open'],
  resolved: ['open', 'acknowledged'],
  dismissed: ['open', 'acknowledged'],
};

// ── De-duplication ────────────────────────────────────────────────────

/** Statuses of an anomaly that is still being handled: it is scored, and no copy is added. */
const HANDLED_STATUSES: AnomalyStatus[] = ['open', 'acknowledged'];

/** Earlier anomalies of a type an analysis compares a candidate with (newest first). */
const EARLIER_ANOMALIES_COMPARED = 50;

/**
 * What an anomaly's evidence consists of: its events (audit or timeline ids) for the rules that
 * have them, else the entitlements PEER_DEVIATION and ORPHAN_ACCESS name.
 */
function evidenceItems(evidence: AnomalyCandidate['evidence'] | undefined): string[] {
  if (evidence?.events?.length) return evidence.events;
  const details = (evidence?.details ?? {}) as Record<string, unknown>;
  const named = details.uniqueEntitlements ?? details.orphanEntitlements;
  return Array.isArray(named) ? named.map(String) : [];
}

/**
 * Whether `earlier` has every item of `items` (nothing new since that anomaly). A candidate whose
 * evidence names nothing is never covered: there is nothing to compare, and `every` over no items
 * would keep it from being raised again after any decision.
 */
function covers(earlier: string[], items: string[]): boolean {
  return items.length > 0 && items.every((item) => earlier.includes(item));
}

// ── Service ────────────────────────────────────────────────────────────

@Injectable()
export class AccessAnomalyService {
  private readonly logger = new Logger(AccessAnomalyService.name);

  constructor(
    @InjectModel(Anomaly.name) private readonly anomalyModel: Model<AnomalyDocument>,
    @InjectModel(RiskScore.name) private readonly riskScoreModel: Model<RiskScoreDocument>,
    private readonly auditService: AuditService,
    private readonly userEventService: UserEventService,
    private readonly identityService: IdentityService,
    private readonly policyEngine: PolicyEngineService,
    private readonly entitlementCatalog: EntitlementCatalogService,
    private readonly eventEmitter: DomainEventEmitterService,
    @Inject(anomalyConfig.KEY) private readonly anomalyConf: AnomalyConfig,
    private readonly entraService: EntraService,
  ) {}

  /**
   * Run the rules for one identity, or for one page of the tenant's identities (1-based `page`,
   * `limit` per page, default the first 50). A rule that throws is counted in `ruleFailures` and
   * logged; the other rules and identities still run.
   */
  async runAnalysis(options?: {
    identityId?: string;
    page?: number;
    limit?: number;
  }): Promise<AnomalyAnalysisResult> {
    const tz = this.anomalyConf.businessHoursTz;
    const page = options?.page ?? 1;
    const limit = options?.limit ?? ANALYSIS_DEFAULT_LIMIT;

    let users: Record<string, unknown>[];
    let totalIdentities: number;
    if (options?.identityId) {
      const user = await this.identityService.findOne(options.identityId);
      if (!user) this.logger.warn(`Identity ${options.identityId} not found`);
      users = user ? [user] : [];
      totalIdentities = users.length;
    } else {
      const start = (page - 1) * limit;
      [users, totalIdentities] = await this.identityService.findAllPaginated(start, start + limit);
    }

    const identityIds: string[] = [];
    const failuresByRule: Partial<Record<AnomalyType, number>> = {};
    let identitiesWithFailures = 0;
    let anomaliesCreated = 0;
    for (const user of users) {
      const identityId = String(user._id ?? '');
      if (!identityId) continue;
      identityIds.push(identityId);
      const { created, failedRules } = await this.analyzeIdentity(identityId, user, tz);
      anomaliesCreated += created;
      if (failedRules.length > 0) identitiesWithFailures++;
      for (const rule of failedRules) failuresByRule[rule] = (failuresByRule[rule] ?? 0) + 1;
    }

    return {
      analyzed: identityIds.length,
      totalIdentities,
      anomaliesCreated,
      identityIds,
      ruleFailures: {
        rules: Object.keys(failuresByRule).length,
        identities: identitiesWithFailures,
        byRule: failuresByRule,
      },
    };
  }

  /** The rules, by the anomaly type each detects. */
  private readonly rules: Array<
    [
      AnomalyType,
      (id: string, user: Record<string, unknown>, tz: string) => Promise<AnomalyCandidate | null>,
    ]
  > = [
    ['TIME_BASED', (id, _user, tz) => this.runTimeBasedRule(id, tz)],
    ['PEER_DEVIATION', (id, user) => this.runPeerDeviationRule(id, user)],
    ['VELOCITY', (id) => this.runVelocityRule(id)],
    ['PRIVILEGE_ESCALATION', (id) => this.runPrivilegeEscalationRule(id)],
    ['ORPHAN_ACCESS', (id, user) => this.runOrphanAccessRule(id, user)],
  ];

  /**
   * Run every rule for one identity and persist what they detect. A rule that throws is returned
   * in `failedRules`, never read as "nothing found"; its cause is logged with personal data masked.
   */
  private async analyzeIdentity(
    identityId: string,
    user: Record<string, unknown>,
    tz: string,
  ): Promise<{ created: number; failedRules: AnomalyType[] }> {
    const candidates: AnomalyCandidate[] = [];
    const failedRules: AnomalyType[] = [];

    for (const [rule, run] of this.rules) {
      try {
        const candidate = await run(identityId, user, tz);
        if (candidate) candidates.push(candidate);
      } catch (err: unknown) {
        failedRules.push(rule);
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Anomaly rule ${rule} failed for identity ${identityId}: ${maskPersonalData(message)}`,
        );
      }
    }

    const riskScore = this.computeRiskScore(candidates);
    let created = 0;
    for (const c of candidates) {
      const saved = await this.saveAnomaly(identityId, c, riskScore);
      if (saved) created++;
    }
    // Always, from what is open now: a score of anomalies resolved since must come down
    await this.refreshRiskScore(identityId);
    return { created, failedRules };
  }

  private async runTimeBasedRule(identityId: string, tz: string): Promise<AnomalyCandidate | null> {
    const result = await this.auditService.query(
      {
        action: ['provisioning.completed', 'provisioning.started'] as AuditAction[],
        resourceType: 'identity',
        resourceId: identityId,
        dateFrom: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      1,
      200,
    );
    const events = result.data.map((e) => ({
      eventId: e._id?.toString() || '',
      timestamp: e.timestamp,
      actor: e.actor,
      action: e.action,
    }));
    return timeBasedRule(
      events,
      tz,
      this.anomalyConf.businessHoursStart,
      this.anomalyConf.businessHoursEnd,
    );
  }

  private async runPeerDeviationRule(
    identityId: string,
    user: Record<string, unknown>,
  ): Promise<AnomalyCandidate | null> {
    const dept = (user.departmentName as string) || (user.departmentCode as string) || '';
    const jobTitle = (user.jobTitle as string) || '';
    if (!dept && !jobTitle) return null;

    const filter: Record<string, unknown> = {
      $or: [{ 'profile.departmentName': dept }, { 'profile.departmentCode': dept }],
      'profile.jobTitle': jobTitle,
      _id: { $ne: identityId },
    };
    const [peers] = await this.identityService.findAllPaginated(0, 50, {
      filter,
      trustedFilter: true,
    });
    if (peers.length < 3) return null;

    const identityEntitlements = await this.getPolicyEntitlementsForUser(user);
    const peerEntitlements = await Promise.all(
      peers.slice(0, 20).map((p) => this.getPolicyEntitlementsForUser(p)),
    );

    return peerDeviationRule(
      identityEntitlements,
      peerEntitlements,
      this.anomalyConf.peerDeviationThreshold,
    );
  }

  private async runVelocityRule(identityId: string): Promise<AnomalyCandidate | null> {
    const events = await this.userEventService.getEvents(
      identityId,
      { type: ['USER_PROVISIONED'] },
      100,
    );
    const withOps = events.map((e) => {
      const meta = e.metadata as Record<string, unknown> | undefined;
      const ops = meta?.operations;
      return {
        eventId: e._id?.toString() || '',
        timestamp: e.timestamp,
        operationCount: Array.isArray(ops) ? ops.length : 1,
      };
    });
    return velocityRule(
      withOps,
      this.anomalyConf.velocityThresholdN,
      this.anomalyConf.velocityWindowM,
    );
  }

  /** Group changes resolved through the catalog first (anomaly-privilege-groups.ts). */
  private async runPrivilegeEscalationRule(identityId: string): Promise<AnomalyCandidate | null> {
    const events = await this.userEventService.getEvents(
      identityId,
      { type: ['USER_PROVISIONED'] },
      100,
    );
    const withGroups = await privilegeGroupChanges(events, (targets) =>
      this.entitlementCatalog.loadTargetLookup(getCurrentTenantId(), targets),
    );
    if (withGroups.length === 0) return null;
    return privilegeEscalationRule(withGroups, this.anomalyConf.privilegeEscalationWindowH);
  }

  private async runOrphanAccessRule(
    identityId: string,
    user: Record<string, unknown>,
  ): Promise<AnomalyCandidate | null> {
    const email = user.email as string | undefined;
    if (!email) return null;
    // Without Entra ID the rule does not apply; with it, an Entra failure is a failed rule.
    if (!(await this.entraService.isConfiguredForTenant())) return null;

    const entraUserId = await this.entraService.checkUserExists(email);
    if (!entraUserId) return null;

    const memberships = await this.entraService.getUserGroupMemberships(entraUserId);
    const actualNames = memberships.map((g) => g.displayName || g.id);

    const policyEntitlements = await this.getPolicyEntitlementsForUser(user);
    const catalogEntries = await this.entitlementCatalog.list('entra-id', {
      origin: 'EXTERNAL',
    });
    const catalogOpen = await this.entitlementCatalog.list('entra-id');
    const externalOrOpen = [
      ...catalogEntries.map((c) => c.name),
      ...catalogOpen.filter((c) => c.governanceLevel === 'OPEN').map((c) => c.name),
    ];

    return orphanAccessRule(actualNames, policyEntitlements, [...new Set(externalOrOpen)]);
  }

  private async getPolicyEntitlementsForUser(user: Record<string, unknown>): Promise<string[]> {
    // Policy engine accepts StandardUserDto; projected identity records are structurally compatible
    const intent = await this.policyEngine.evaluate(
      user as unknown as import('@shared/dtos/standard-user.dto').StandardUserDto,
    );
    const ids = new Set<string>();
    for (const op of intent.operations) {
      if (op.type === 'group' || op.type === 'license') {
        ids.add(op.targetId);
      }
    }
    return [...ids];
  }

  /**
   * Compute risk score from anomalies. Cap at 100.
   */
  computeRiskScore(candidates: AnomalyCandidate[]): number {
    let score = 0;
    for (const c of candidates) {
      score += ANOMALY_TYPE_SCORES[c.type] ?? 0;
    }
    return Math.min(100, score);
  }

  /**
   * Record the candidate unless the identity has it already: an open or acknowledged anomaly of
   * the type (being handled), or a decided one (dismissed, resolved) whose evidence covers every
   * item of the candidate's (evidenceItems). A dismissal sticks until new evidence comes in, and a
   * shrinking 7-day window raises nothing again.
   */
  private async saveAnomaly(
    identityId: string,
    candidate: AnomalyCandidate,
    riskScore: number,
  ): Promise<boolean> {
    const anomalyId = randomUUID();
    const earlier = await this.anomalyModel
      .find({ identityId, type: candidate.type })
      .sort({ detectedAt: -1 })
      .limit(EARLIER_ANOMALIES_COMPARED)
      .lean()
      .exec();
    if (earlier.some((a) => HANDLED_STATUSES.includes(a.status))) return false;
    const items = evidenceItems(candidate.evidence);
    if (earlier.some((a) => covers(evidenceItems(a.evidence), items))) return false;

    await this.anomalyModel.create({
      anomalyId,
      identityId,
      type: candidate.type,
      severity: candidate.severity,
      riskScore,
      title: candidate.title,
      description: candidate.description,
      evidence: candidate.evidence,
      status: 'open',
      detectedAt: new Date(),
    });

    this.eventEmitter.emit(DomainEventType.ANOMALY_DETECTED, identityId, {
      anomalyId,
      identityId,
      type: candidate.type,
      severity: candidate.severity,
      riskScore,
    });

    return true;
  }

  /**
   * The identity's risk score from its open and acknowledged anomalies (each type once,
   * computeRiskScore); none open removes the identity's row, so GET /anomalies/risk-scores lists
   * only identities with something open.
   */
  private async refreshRiskScore(identityId: string): Promise<void> {
    const types: AnomalyType[] = await this.anomalyModel
      .distinct('type', { identityId, status: { $in: HANDLED_STATUSES } })
      .exec();
    const riskScore = Math.min(
      100,
      types.reduce((score, type) => score + (ANOMALY_TYPE_SCORES[type] ?? 0), 0),
    );
    if (riskScore === 0) {
      await this.riskScoreModel.deleteOne({ identityId }).exec();
      return;
    }
    await this.riskScoreModel.findOneAndUpdate(
      { identityId },
      { $set: { riskScore, updatedAt: new Date() } },
      { upsert: true },
    );
  }

  // ── REST API methods ──────────────────────────────────────────────────

  /**
   * List anomalies within a date range (for compliance reporting).
   */
  async listByDateRange(tenantId: string, from: Date, to: Date): Promise<AnomalyDocument[]> {
    return this.anomalyModel
      .find({
        tenantId,
        detectedAt: { $gte: from, $lte: to },
      })
      .sort({ detectedAt: -1 })
      .lean()
      .exec() as Promise<AnomalyDocument[]>;
  }

  async list(
    filter?: AnomalyFilter,
    page = 1,
    limit = 50,
  ): Promise<{
    data: AnomalyDocument[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const q: Record<string, unknown> = {};
    if (filter?.identityId) q.identityId = filter.identityId;
    if (filter?.type) {
      q.type = Array.isArray(filter.type) ? { $in: filter.type } : filter.type;
    }
    if (filter?.severity) {
      q.severity = Array.isArray(filter.severity) ? { $in: filter.severity } : filter.severity;
    }
    if (filter?.status) q.status = filter.status;

    const [data, total] = await Promise.all([
      this.anomalyModel
        .find(q)
        .sort({ detectedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.anomalyModel.countDocuments(q).exec(),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** One anomaly by its `anomalyId` (UUID) or its document `_id`, in the current tenant. */
  async findOne(id: string): Promise<AnomalyDocument> {
    const anomaly = await this.anomalyModel.findOne(publicIdFilter('anomalyId', id));
    if (!anomaly) throw new NotFoundException(`Anomaly ${id} not found`);
    return anomaly;
  }

  async acknowledge(id: string, acknowledgedBy: string): Promise<AnomalyDocument> {
    return this.changeStatus(id, 'acknowledged', { acknowledgedBy });
  }

  async dismiss(id: string, reason?: string, actor?: string): Promise<AnomalyDocument> {
    const anomaly = await this.changeStatus(id, 'dismissed', {
      resolvedAt: new Date(),
      ...(actor ? { resolvedBy: actor } : {}),
      ...(reason ? { 'metadata.dismissReason': reason } : {}),
    });
    await this.refreshRiskScore(anomaly.identityId);
    this.eventEmitter.emit(DomainEventType.ANOMALY_RESOLVED, anomaly.identityId, {
      anomalyId: anomaly.anomalyId,
      identityId: anomaly.identityId,
      status: 'dismissed',
    });
    return anomaly;
  }

  async resolve(id: string, actor?: string): Promise<AnomalyDocument> {
    const anomaly = await this.changeStatus(id, 'resolved', {
      resolvedAt: new Date(),
      ...(actor ? { resolvedBy: actor } : {}),
    });
    await this.refreshRiskScore(anomaly.identityId);
    this.eventEmitter.emit(DomainEventType.ANOMALY_RESOLVED, anomaly.identityId, {
      anomalyId: anomaly.anomalyId,
      identityId: anomaly.identityId,
      status: 'resolved',
    });
    return anomaly;
  }

  /**
   * Move the anomaly to `to` in one conditional update, only from a status ALLOWED_FROM lists,
   * so of two simultaneous changes one wins. Otherwise 409 naming the current status (404 when
   * there is no such anomaly); nothing is written and the caller emits nothing.
   */
  private async changeStatus(
    id: string,
    to: StatusChange,
    set: Record<string, unknown>,
  ): Promise<AnomalyDocument> {
    const changed = await this.anomalyModel.findOneAndUpdate(
      { ...publicIdFilter('anomalyId', id), status: { $in: ALLOWED_FROM[to] } },
      { $set: { ...set, status: to } },
      { new: true },
    );
    if (changed) return changed;

    const current = await this.findOne(id);
    throw new ConflictException(
      current.status === to
        ? `Anomaly ${current.anomalyId} is already ${to}.`
        : `Anomaly ${current.anomalyId} is ${current.status} and cannot be ${to}.`,
    );
  }

  async getRiskScores(
    limit = 50,
  ): Promise<Array<{ identityId: string; riskScore: number; updatedAt: Date }>> {
    const scores = await this.riskScoreModel
      .find()
      .sort({ riskScore: -1 })
      .limit(limit)
      .lean()
      .exec();
    return scores.map((s) => ({
      identityId: s.identityId,
      riskScore: s.riskScore,
      updatedAt: s.updatedAt,
    }));
  }
}
