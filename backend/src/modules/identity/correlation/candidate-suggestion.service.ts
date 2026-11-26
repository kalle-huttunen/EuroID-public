/**
 * CandidateSuggestionService — suggests potential matches for uncorrelated identities.
 * Runs correlation rules against the identity's profile and returns all scored candidates.
 */

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { IdentityDocument } from '../schemas/identity.schema';
import type { CorrelationConfig } from './correlation-rule.interface';
import { CORRELATION_NAME_CANDIDATE_LIMIT } from '../identity.constants';
import { CorrelationRuleEngine } from './correlation-rule.engine';
import { normalizeName, matchNames } from './name-utils';

export interface ScoredCandidate {
  identityId: string;
  profile: {
    firstName: string;
    lastName: string;
    email?: string;
    jobTitle?: string;
    departmentName?: string;
  };
  matchedBy: string;
  confidence: number;
  sources: { sourceName: string; externalId: string }[];
}

@Injectable()
export class CandidateSuggestionService {
  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly correlationEngine: CorrelationRuleEngine,
  ) {}

  /**
   * Suggest candidate identities that may match the given uncorrelated identity.
   * Uses stored ambiguousCandidates when available; otherwise runs heuristic name matching.
   */
  async suggestCandidates(
    identity: IdentityDocument,
    correlationConfig: CorrelationConfig,
  ): Promise<ScoredCandidate[]> {
    const tenantId = identity.tenantId || 'default';
    const profile = identity.profile as unknown as Record<string, unknown>;
    const firstName = String(profile?.firstName || '');
    const lastName = String(profile?.lastName || '');

    const seen = new Set<string>();
    const candidates: ScoredCandidate[] = [];

    if (identity.metadata?.ambiguousCandidates?.length) {
      const ids = identity.metadata.ambiguousCandidates;
      const docs = await this.identityModel
        .find({ _id: { $in: ids }, deletedAt: null, tenantId })
        .exec();
      const threshold = correlationConfig.confidenceThreshold ?? 0.7;
      for (const doc of docs) {
        const idStr = String(doc._id);
        if (seen.has(idStr)) continue;
        seen.add(idStr);
        const p = doc.profile as unknown as Record<string, unknown>;
        const result = matchNames(
          { firstName, lastName },
          {
            firstName: String(p?.firstName || ''),
            lastName: String(p?.lastName || ''),
          },
          correlationConfig.rules?.find((r) => r.strategy === 'heuristicName')?.nameMatchThreshold ?? 0.8,
        );
        if (result.confidence >= threshold) {
          candidates.push(this.toScoredCandidate(doc, 'heuristicName', result.confidence));
        }
      }
    }

    if (candidates.length === 0) {
      const nameCandidates = await this.findNameCandidates(
        tenantId,
        String(identity._id),
        firstName,
        lastName,
        correlationConfig,
      );
      for (const c of nameCandidates) {
        const idStr = c.identityId;
        if (seen.has(idStr)) continue;
        seen.add(idStr);
        candidates.push(c);
      }
    }

    return candidates.sort((a, b) => b.confidence - a.confidence);
  }

  private async findNameCandidates(
    tenantId: string,
    excludeIdentityId: string,
    firstName: string,
    lastName: string,
    config: CorrelationConfig,
  ): Promise<ScoredCandidate[]> {
    const rule = config.rules?.find((r) => r.strategy === 'heuristicName');
    if (!rule) return [];

    const threshold = rule.nameMatchThreshold ?? 0.8;
    const normLast = normalizeName(lastName);
    if (!normLast || !firstName.trim()) return [];

    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [escapeRegex(lastName), escapeRegex(normLast)];
    const uniquePatterns = [...new Set(patterns)];
    const orConditions = uniquePatterns.map(
      (p) => ({ 'profile.lastName': { $regex: new RegExp(`^${p}$`, 'i') } }) as Record<string, unknown>,
    );

    const docs = await this.identityModel
      .find({
        _id: { $ne: excludeIdentityId },
        tenantId,
        deletedAt: null,
        $and: [
          {
            $or: [
              { 'metadata.correlationStatus': 'correlated' },
              { 'metadata.correlationStatus': { $exists: false } },
            ],
          },
          { $or: orConditions },
        ],
      })
      .limit(CORRELATION_NAME_CANDIDATE_LIMIT)
      .exec();

    const scored: ScoredCandidate[] = [];
    for (const doc of docs) {
      const p = doc.profile as { firstName?: string; lastName?: string };
      const result = matchNames(
        { firstName, lastName },
        {
          firstName: String(p?.firstName || ''),
          lastName: String(p?.lastName || ''),
        },
        threshold,
      );
      if (result.matchType !== 'none' && result.confidence >= threshold) {
        scored.push(this.toScoredCandidate(doc, 'heuristicName', result.confidence));
      }
    }

    return scored;
  }

  private toScoredCandidate(
    doc: IdentityDocument,
    matchedBy: string,
    confidence: number,
  ): ScoredCandidate {
    const p = doc.profile as unknown as Record<string, unknown>;
    const sources = (doc.sources || []).map((s) => ({
      sourceName: s.sourceName,
      externalId: s.externalId,
    }));
    return {
      identityId: String(doc._id),
      profile: {
        firstName: String(p?.firstName || ''),
        lastName: String(p?.lastName || ''),
        email: p?.email as string | undefined,
        jobTitle: p?.jobTitle as string | undefined,
        departmentName: (p?.departmentName ?? p?.departmentCode) as string | undefined,
      },
      matchedBy,
      confidence,
      sources,
    };
  }
}
