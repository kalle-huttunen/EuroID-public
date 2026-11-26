/**
 * Policy Suggestion Service
 *
 * Analyzes entitlement distribution and suggests new birthright policies.
 * Detects: birthright patterns, orphan entitlements, redundant policies, coverage gaps.
 */

import { Inject, Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  PolicySuggestion,
  PolicySuggestionDocument,
  SuggestionType,
  SuggestedPolicy,
} from './schemas/suggestion.schema';
import { PolicyService } from '../policy/policy.service';
import { PolicyEngineService } from '../policy/policy-engine.service';
import { IdentityService } from '../identity/identity.service';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { PolicyDocument, PolicyStatus, RiskLevel } from '../policy/schemas/policy.schema';
import { EntraService } from '../connectors/entra-connector/entra.service';
import { suggestedPolicyToPolicy } from './suggested-policy';
import { POLICY_SUGGESTIONS_PAGE_SIZE } from '@infrastructure/config/defaults';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import {
  type PolicySuggestionsConfig,
  policySuggestionsConfig,
} from '@infrastructure/config/policy-suggestions.config';
import {
  ENTRA_NOT_CONFIGURED,
  type AnalysisResult,
  type SkippedAnalyzer,
  type SuggestionCandidate,
  type SuggestionFilter,
} from './policy-suggestions.types';

// ── Service ────────────────────────────────────────────────────────────

@Injectable()
export class PolicySuggestionService {
  private readonly logger = new Logger(PolicySuggestionService.name);

  constructor(
    @InjectModel(PolicySuggestion.name)
    private readonly suggestionModel: Model<PolicySuggestionDocument>,
    private readonly policyService: PolicyService,
    private readonly policyEngine: PolicyEngineService,
    private readonly identityService: IdentityService,
    private readonly entitlementCatalog: EntitlementCatalogService,
    private readonly entraService: EntraService,
    private readonly config: ConfigService,
    @Inject(policySuggestionsConfig.KEY) private readonly suggestConf: PolicySuggestionsConfig,
  ) {}

  // ── REST: List, Get, Accept, Dismiss ────────────────────────────────

  async findAll(
    filter: SuggestionFilter,
  ): Promise<{ data: PolicySuggestionDocument[]; total: number }> {
    const tenantId = getRequestContext()?.tenantId || 'default';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose query filter with dynamic operators ($in, $gte)
    const q: Record<string, any> = { tenantId };
    if (filter.type) {
      q.type = Array.isArray(filter.type) ? { $in: filter.type } : filter.type;
    }
    if (filter.status) {
      q.status = Array.isArray(filter.status) ? { $in: filter.status } : filter.status;
    }
    if (filter.confidenceMin != null) {
      q.confidence = { $gte: filter.confidenceMin };
    }

    const total = await this.suggestionModel.countDocuments(q).exec();
    const page = filter.page ?? 0;
    const limit = Math.min(filter.limit ?? 50, 100);
    const skip = page * limit;

    const data = await this.suggestionModel
      .find(q)
      .sort({ confidence: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();

    return { data, total };
  }

  async findOne(id: string): Promise<PolicySuggestionDocument> {
    const tenantId = getRequestContext()?.tenantId || 'default';
    const doc = await this.suggestionModel.findOne({ suggestionId: id, tenantId }).exec();
    if (!doc) throw new NotFoundException(`Suggestion ${id} not found`);
    return doc;
  }

  /**
   * Creates the suggested policy as a DRAFT. The suggestion is claimed first (pending to
   * accepted, a conditional update): of two accepts, or an accept and a dismiss, at once only one
   * goes through, so one policy is made. A policy that could not be created gives the claim back.
   */
  async accept(id: string, actor: string): Promise<PolicySuggestionDocument> {
    const suggestion = await this.findOne(id);
    if (!suggestion.suggestedPolicy) {
      throw new BadRequestException(`Suggestion ${id} has no suggested policy to create`);
    }
    const claimed = await this.claim(suggestion, { status: 'accepted', acceptedBy: actor });
    try {
      const created = await this.policyService.create(
        { ...suggestedPolicyToPolicy(suggestion.suggestedPolicy), status: PolicyStatus.DRAFT },
        actor,
      );
      claimed.resultingPolicyId = created._id.toString();
      await claimed.save();
      this.logger.log(`Accepted suggestion ${id}, created DRAFT policy ${created._id}`);
      return claimed;
    } catch (err: unknown) {
      await this.suggestionModel
        .updateOne(
          { _id: claimed._id, status: 'accepted' },
          { $set: { status: 'pending' }, $unset: { acceptedBy: '' } },
        )
        .exec();
      throw err;
    }
  }

  async dismiss(id: string, actor: string, reason?: string): Promise<PolicySuggestionDocument> {
    const suggestion = await this.findOne(id);
    const dismissed = await this.claim(suggestion, {
      status: 'dismissed',
      dismissedBy: actor,
      ...(reason !== undefined ? { dismissReason: reason } : {}),
    });
    this.logger.log(`Dismissed suggestion ${id}`);
    return dismissed;
  }

  /** Moves a pending suggestion on with `set`; 400 when it is no longer pending. */
  private async claim(
    suggestion: PolicySuggestionDocument,
    set: Record<string, unknown>,
  ): Promise<PolicySuggestionDocument> {
    const claimed = await this.suggestionModel
      .findOneAndUpdate({ _id: suggestion._id, status: 'pending' }, { $set: set }, { new: true })
      .exec();
    if (!claimed) {
      throw new BadRequestException(`Suggestion ${suggestion.suggestionId} is not pending`);
    }
    return claimed;
  }

  // ── Analyze: run all analyzers and persist suggestions ──────────────

  /**
   * Runs the analyzers and stores their suggestions. `analyzed` is the number of candidate
   * suggestions found (not of identities read). `skipped` names each analyzer that did not run
   * and why, so "nothing to suggest" and "nothing was analysed" do not look the same.
   */
  async runAnalysis(): Promise<AnalysisResult> {
    const candidates: SuggestionCandidate[] = [];
    const seenKeys = new Set<string>(); // dedupe by (type, dimension, target)
    const skipped: SkippedAnalyzer[] = [];

    // The birthright and orphan analyzers read group memberships from Entra ID.
    const entraConfigured = await this.entraService.isConfiguredForTenant();
    if (!entraConfigured) {
      skipped.push(
        { analyzer: 'birthright', reason: ENTRA_NOT_CONFIGURED },
        { analyzer: 'orphan', reason: ENTRA_NOT_CONFIGURED },
      );
    }

    // 1. Birthright pattern analyzer
    const birthright = entraConfigured ? await this.analyzeBirthrightPatterns() : [];
    for (const c of birthright) {
      const key = `BIRTHRIGHT:${c.evidence.affectedEntitlements[0]}:${c.suggestedPolicy?.conditionGroups?.[0]?.conditions?.[0]?.value}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        candidates.push(c);
      }
    }

    // 2. Orphan entitlement analyzer
    const orphans = entraConfigured ? await this.analyzeOrphanEntitlements() : [];
    for (const c of orphans) {
      const key = `ORPHAN:${c.evidence.affectedEntitlements[0]}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        candidates.push(c);
      }
    }

    // 3. Redundant policy analyzer
    const redundant = await this.analyzeRedundantPolicies();
    for (const c of redundant) {
      const key = `REDUNDANT:${c.sourcePolicyId}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        candidates.push(c);
      }
    }

    // 4. Coverage gap analyzer
    const gaps = await this.analyzeCoverageGaps();
    for (const c of gaps) {
      const val = c.suggestedPolicy?.conditionGroups?.[0]?.conditions?.[0]?.value;
      const key = `GAP:${val}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        candidates.push(c);
      }
    }

    let created = 0;
    for (const c of candidates) {
      const saved = await this.persistSuggestion(c);
      if (saved) created++;
    }

    this.logger.log(`Analysis complete: ${candidates.length} candidates, ${created} persisted`);
    return { analyzed: candidates.length, suggestionsCreated: created, skipped };
  }

  // ── Analyzers ────────────────────────────────────────────────────────

  async analyzeBirthrightPatterns(): Promise<SuggestionCandidate[]> {
    const threshold = this.suggestConf.birthrightThreshold;
    const dimension = this.suggestConf.birthrightDimension;
    const results: SuggestionCandidate[] = [];

    if (!(await this.entraService.isConfiguredForTenant())) {
      this.logger.debug('Entra not configured, skipping birthright analyzer');
      return results;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- users from identity service are dynamic lean documents
    const groupByValue = new Map<string, any[]>();
    let skip = 0;
    let total = 0;
    do {
      const [users, pageTotal] = await this.identityService.findAllPaginated(
        skip,
        skip + POLICY_SUGGESTIONS_PAGE_SIZE,
      );
      if (skip === 0) total = pageTotal;
      for (const u of users) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic lean document with arbitrary profile fields
        const ud = u as any;
        const val = ud[dimension] || ud.departmentName || ud.departmentCode || '';
        if (!val) continue;
        const list = groupByValue.get(String(val)) || [];
        list.push(ud);
        groupByValue.set(String(val), list);
      }
      skip += POLICY_SUGGESTIONS_PAGE_SIZE;
    } while (skip < total);
    if (total === 0) return results;

    const activePolicies = await this.policyService.findActive();

    for (const [groupValue, groupUsers] of groupByValue) {
      if (groupUsers.length < 2) continue;

      const entitlementToUserIds = new Map<string, string[]>();
      for (const user of groupUsers) {
        const groups = await this.getUserEntitlements(user);
        for (const g of groups) {
          const ids = entitlementToUserIds.get(g) || [];
          ids.push(String(user._id ?? user.email ?? ''));
          entitlementToUserIds.set(g, ids);
        }
      }

      for (const [entitlement, userIds] of entitlementToUserIds) {
        const pct = Math.round((userIds.length / groupUsers.length) * 100);
        if (pct < threshold) continue;

        const alreadyCovered = await this.isPatternCoveredByPolicy(
          dimension,
          groupValue,
          entitlement,
          activePolicies,
        );
        if (alreadyCovered) continue;

        const suggestedPolicy = this.buildBirthrightPolicy(dimension, groupValue, entitlement);
        results.push({
          type: SuggestionType.BIRTHRIGHT_PATTERN,
          confidence: pct,
          title: `Birthright: ${groupValue} → ${entitlement}`,
          description: `${pct}% of ${groupValue} users have ${entitlement} but no policy covers it.`,
          suggestedPolicy,
          evidence: {
            totalUsers: groupUsers.length,
            matchingUsers: userIds.length,
            percentage: pct,
            sampleUserIds: [...new Set(userIds)].slice(0, 5),
            affectedEntitlements: [entitlement],
          },
        });
      }
    }
    return results;
  }

  async analyzeOrphanEntitlements(): Promise<SuggestionCandidate[]> {
    const results: SuggestionCandidate[] = [];

    if (!(await this.entraService.isConfiguredForTenant())) {
      this.logger.debug('Entra not configured, skipping orphan analyzer');
      return results;
    }

    const activePolicies = await this.policyService.findActive();
    const policyEntitlements = new Set<string>();
    for (const p of activePolicies) {
      for (const a of p.actions || []) {
        if (a.type === 'assign_group' && a.params?.groupName) {
          policyEntitlements.add(String(a.params.groupName).toLowerCase());
        }
      }
    }

    const entitlementToUserIds = new Map<string, string[]>();
    let totalUsers = 0;
    let skip = 0;
    let total = 0;
    do {
      const [users, pageTotal] = await this.identityService.findAllPaginated(
        skip,
        skip + POLICY_SUGGESTIONS_PAGE_SIZE,
      );
      if (skip === 0) total = pageTotal;
      totalUsers = total;
      for (const user of users) {
        const groups = await this.getUserEntitlements(user as { email?: string });
        for (const g of groups) {
          const ids = entitlementToUserIds.get(g) || [];
          ids.push(String(user._id ?? user.email ?? ''));
          entitlementToUserIds.set(g, ids);
        }
      }
      skip += POLICY_SUGGESTIONS_PAGE_SIZE;
    } while (skip < total);

    for (const [entitlement, userIds] of entitlementToUserIds) {
      if (policyEntitlements.has(entitlement.toLowerCase())) continue;

      const uniqueIds = [...new Set(userIds)];
      if (uniqueIds.length === 0) continue;

      const pct = totalUsers > 0 ? Math.round((uniqueIds.length / totalUsers) * 100) : 0;
      results.push({
        type: SuggestionType.ORPHAN_ENTITLEMENT,
        confidence: Math.min(100, pct + 50),
        title: `Orphan: ${entitlement} assigned to ${uniqueIds.length} users, not in any policy`,
        description: `Group "${entitlement}" is assigned to ${uniqueIds.length} user(s) but is not referenced by any active policy. Consider creating a policy or flagging for removal.`,
        suggestedPolicy: undefined,
        evidence: {
          totalUsers,
          matchingUsers: uniqueIds.length,
          percentage: pct,
          sampleUserIds: uniqueIds.slice(0, 5),
          affectedEntitlements: [entitlement],
        },
      });
    }
    return results;
  }

  async analyzeRedundantPolicies(): Promise<SuggestionCandidate[]> {
    const results: SuggestionCandidate[] = [];
    const activePolicies = await this.policyService.findActive();
    const [, totalUsers] = await this.identityService.findAllPaginated(0, 1);

    for (const policy of activePolicies) {
      const sim = await this.policyEngine.simulate(policy);
      if (sim.matchedCount === 0) {
        results.push({
          type: SuggestionType.REDUNDANT_POLICY,
          confidence: 100,
          title: `Redundant: ${policy.name} matches zero users`,
          description: `Policy "${policy.name}" matches no users. Consider disabling or removing it.`,
          suggestedPolicy: undefined,
          evidence: {
            totalUsers,
            matchingUsers: 0,
            percentage: 0,
            sampleUserIds: [],
            affectedEntitlements: (policy.actions || [])
              .map((a) => String(a.params?.groupName || a.params?.licenseSku || ''))
              .filter(Boolean),
          },
          sourcePolicyId: (policy as PolicyDocument)._id?.toString(),
        });
      }
    }
    return results;
  }

  async analyzeCoverageGaps(): Promise<SuggestionCandidate[]> {
    const minUsers = this.suggestConf.coverageGapMinUsers;
    const dimension = this.suggestConf.birthrightDimension;
    const results: SuggestionCandidate[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- users from identity service are dynamic lean documents
    const groupByValue = new Map<string, any[]>();
    let skip = 0;
    let total = 0;
    do {
      const [users, pageTotal] = await this.identityService.findAllPaginated(
        skip,
        skip + POLICY_SUGGESTIONS_PAGE_SIZE,
      );
      if (skip === 0) total = pageTotal;
      for (const u of users) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic lean document with arbitrary profile fields
        const ud = u as any;
        const val = ud[dimension] || ud.departmentName || ud.departmentCode || '';
        if (!val) continue;
        const list = groupByValue.get(String(val)) || [];
        list.push(ud);
        groupByValue.set(String(val), list);
      }
      skip += POLICY_SUGGESTIONS_PAGE_SIZE;
    } while (skip < total);

    const activePolicies = await this.policyService.findActive();

    for (const [groupValue, groupUsers] of groupByValue) {
      if (groupUsers.length < minUsers) continue;

      const hasCoverage = activePolicies.some((p) => {
        for (const cg of p.conditionGroups || []) {
          for (const c of cg.conditions || []) {
            const field = c.field === 'department' ? 'departmentName' : c.field;
            if (field === dimension || field === 'departmentName' || field === 'departmentCode') {
              const condVal = Array.isArray(c.value) ? c.value[0] : c.value;
              if (String(condVal).toLowerCase() === String(groupValue).toLowerCase()) {
                return true;
              }
            }
          }
        }
        return false;
      });

      if (!hasCoverage) {
        const suggestedPolicy = this.buildBirthrightPolicy(dimension, groupValue, '');
        results.push({
          type: SuggestionType.COVERAGE_GAP,
          confidence: Math.min(100, 50 + groupUsers.length),
          title: `Coverage gap: ${groupValue} has ${groupUsers.length} users, no policy`,
          description: `Department/group "${groupValue}" has ${groupUsers.length} users but no active policy targets it.`,
          suggestedPolicy,
          evidence: {
            totalUsers: groupUsers.length,
            matchingUsers: 0,
            percentage: 0,
            sampleUserIds: groupUsers
              .slice(0, 5)
              .map((u: Record<string, unknown>) => String(u._id ?? u.email ?? ''))
              .filter(Boolean),
            affectedEntitlements: [],
          },
        });
      }
    }
    return results;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async getUserEntitlements(user: { email?: string }): Promise<string[]> {
    const email = user.email;
    if (!email) return [];
    try {
      const userId = await this.entraService.checkUserExists(email);
      if (!userId) return [];
      const memberships = await this.entraService.getUserGroupMemberships(userId);
      return memberships.map((g) => g.displayName || g.id).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async isPatternCoveredByPolicy(
    dimension: string,
    value: string,
    entitlement: string,
    policies: PolicyDocument[],
  ): Promise<boolean> {
    const field = dimension === 'departmentName' ? 'departmentName' : dimension;
    for (const p of policies) {
      for (const a of p.actions || []) {
        if (a.type !== 'assign_group') continue;
        const groupName = a.params?.groupName;
        if (!groupName || String(groupName).toLowerCase() !== entitlement.toLowerCase()) continue;

        for (const cg of p.conditionGroups || []) {
          for (const c of cg.conditions || []) {
            const f = c.field === 'department' ? 'departmentName' : c.field;
            if (f !== field) continue;
            const condVal = Array.isArray(c.value) ? c.value[0] : c.value;
            if (String(condVal).toLowerCase() === String(value).toLowerCase()) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  private buildBirthrightPolicy(
    dimension: string,
    value: string,
    entitlement: string,
  ): SuggestedPolicy {
    const field = dimension === 'departmentName' ? 'departmentName' : dimension;
    const condId = `c-${randomUUID().slice(0, 8)}`;
    const groupId = `g-${randomUUID().slice(0, 8)}`;
    const actionId = `a-${randomUUID().slice(0, 8)}`;

    return {
      name: `Birthright: ${value} → ${entitlement || 'Base'}`,
      conditionGroups: [
        {
          id: groupId,
          join: 'AND',
          conditions: [
            {
              id: condId,
              field,
              operator: 'equals',
              value,
            },
          ],
        },
      ],
      actions: entitlement
        ? [
            {
              id: actionId,
              type: 'assign_group',
              target: 'entra-id',
              params: { groupName: entitlement },
            },
          ]
        : [],
      risk: RiskLevel.LOW,
    };
  }

  private async persistSuggestion(candidate: SuggestionCandidate): Promise<boolean> {
    const tenantId = getRequestContext()?.tenantId || 'default';
    const existing = await this.suggestionModel
      .findOne({
        tenantId,
        type: candidate.type,
        // An admin's decision stands: a dismissed or accepted suggestion is not made again
        status: { $in: ['pending', 'dismissed', 'accepted'] },
        title: candidate.title,
      })
      .exec();
    if (existing) return false;

    await this.suggestionModel.create({
      tenantId,
      suggestionId: randomUUID(),
      type: candidate.type,
      confidence: candidate.confidence,
      title: candidate.title,
      description: candidate.description,
      suggestedPolicy: candidate.suggestedPolicy,
      evidence: candidate.evidence,
      status: 'pending',
      sourcePolicyId: candidate.sourcePolicyId,
    });
    return true;
  }
}
