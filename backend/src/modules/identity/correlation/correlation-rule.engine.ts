/**
 * CorrelationRuleEngine — finds existing Identity when a new source has no source-key match
 *
 * Evaluates configured rules (employeeNumber, email, hashedNationalId, composite, heuristicName)
 * to link records from different systems that represent the same person.
 */

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { ClientSession } from 'mongoose';
import type { IdentityDocument } from '../schemas/identity.schema';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { normalizeEmail } from '@shared/utils/email';
import type { CorrelationConfig, CorrelationRule } from './correlation-rule.interface';
import { CORRELATION_NAME_CANDIDATE_LIMIT } from '../identity.constants';
import { normalizeName, matchNames } from './name-utils';

export interface CorrelationResult {
  identity: IdentityDocument | null;
  matchedBy: string | null;
  confidence: number;
  reviewRequired?: boolean;
  /** When heuristicName finds multiple candidates, list of identity IDs for manual review */
  ambiguousCandidates?: string[];
}

@Injectable()
export class CorrelationRuleEngine {
  constructor(@InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>) {}

  /**
   * Find an existing Identity that correlates with the incoming DTO.
   * Rules are evaluated in order; first match wins.
   * `deleted`: search only soft-deleted identities (most recently deleted first) instead of live ones.
   */
  async findCorrelatedIdentity(
    dto: StandardUserDto,
    tenantId: string,
    config: CorrelationConfig,
    session?: ClientSession,
    options?: { deleted?: boolean },
  ): Promise<CorrelationResult> {
    const rules = config?.rules ?? [];
    const deleted = options?.deleted ?? false;
    for (const rule of rules) {
      const result = await this.tryRule(dto, tenantId, rule, session, deleted);
      if (result.identity) {
        const reviewRequired = this.demographicSanityCheck(
          dto,
          result.identity,
          result.confidence,
          config,
        );
        return { ...result, reviewRequired };
      }
      if (result.ambiguousCandidates?.length) {
        return result;
      }
    }
    return { identity: null, matchedBy: null, confidence: 0 };
  }

  /** Live identities of the tenant, or only its soft-deleted ones. */
  private scope(tenantId: string, deleted: boolean): Record<string, unknown> {
    return { tenantId, deletedAt: deleted ? { $ne: null } : null };
  }

  private findOne(filter: Record<string, unknown>, session?: ClientSession, deleted = false) {
    let q = this.identityModel.findOne(filter);
    if (deleted) q = q.sort({ deletedAt: -1 });
    if (session) q = q.session(session);
    return q.exec();
  }

  private async tryRule(
    dto: StandardUserDto,
    tenantId: string,
    rule: CorrelationRule,
    session?: ClientSession,
    deleted = false,
  ): Promise<CorrelationResult> {
    const filter = this.scope(tenantId, deleted);

    switch (rule.strategy) {
      case 'employeeNumber': {
        const empNo = dto.employeeNumber?.trim();
        if (!empNo) return { identity: null, matchedBy: null, confidence: 0 };
        filter['sources.rawData.employeeNumber'] = empNo;
        const identity = await this.findOne(filter, session, deleted);
        return identity
          ? { identity, matchedBy: 'employeeNumber', confidence: 0.9 }
          : { identity: null, matchedBy: null, confidence: 0 };
      }

      case 'hashedNationalId': {
        // The hash IdentityCorrelationService computed from the record's national ID (and then
        // removed the raw value): none without the value or without CORRELATION_HMAC_SECRET
        const hashed = dto.correlationId?.trim();
        if (!hashed) return { identity: null, matchedBy: null, confidence: 0 };
        filter['profile.correlationId'] = hashed;
        const identity = await this.findOne(filter, session, deleted);
        return identity
          ? { identity, matchedBy: 'hashedNationalId', confidence: 0.95 }
          : { identity: null, matchedBy: null, confidence: 0 };
      }

      case 'email': {
        const email = dto.email ? normalizeEmail(dto.email) : '';
        if (!email) return { identity: null, matchedBy: null, confidence: 0 };
        filter['profile.email'] = email;
        const identity = await this.findOne(filter, session, deleted);
        return identity
          ? { identity, matchedBy: 'email', confidence: 0.7 }
          : { identity: null, matchedBy: null, confidence: 0 };
      }

      case 'composite': {
        const fields = rule.compositeFields ?? ['firstName', 'lastName', 'dateOfBirth'];
        const values: string[] = [];
        for (const path of fields) {
          const v = this.getNested(dto, path);
          if (v == null || String(v).trim() === '')
            return { identity: null, matchedBy: null, confidence: 0 };
          values.push(String(v).trim().toLowerCase());
        }
        const identity = await this.findByComposite(tenantId, fields, values, session, deleted);
        return identity
          ? { identity, matchedBy: 'composite', confidence: 0.85 }
          : { identity: null, matchedBy: null, confidence: 0 };
      }

      case 'heuristicName': {
        const threshold = rule.nameMatchThreshold ?? 0.8;
        const mode = rule.nameMatchMode ?? 'both';
        const firstName = (dto.firstName || '').trim();
        const lastName = (dto.lastName || '').trim();
        const normFirst = normalizeName(firstName);
        const normLast = normalizeName(lastName);
        if (!normFirst || !normLast) return { identity: null, matchedBy: null, confidence: 0 };

        const candidates = await this.findByNameCandidates(
          tenantId,
          lastName,
          normLast,
          session,
          deleted,
        );
        const scored = candidates
          .map((identity) => {
            const profile = identity.profile as { firstName?: string; lastName?: string };
            const existing = {
              firstName: String(profile?.firstName || ''),
              lastName: String(profile?.lastName || ''),
            };
            const result = matchNames({ firstName, lastName }, existing, threshold);
            return { identity, ...result };
          })
          .filter(
            (s) =>
              s.matchType !== 'none' &&
              (mode === 'both' ||
                (mode === 'exact' && s.matchType === 'exact') ||
                (mode === 'fuzzy' && s.matchType === 'fuzzy')),
          );

        if (scored.length === 1) {
          return {
            identity: scored[0].identity,
            matchedBy: 'heuristicName',
            confidence: scored[0].confidence,
            reviewRequired: scored[0].matchType === 'fuzzy',
          };
        }
        if (scored.length > 1) {
          return {
            identity: null,
            matchedBy: 'heuristicName-ambiguous',
            confidence: 0,
            reviewRequired: true,
            ambiguousCandidates: scored.map((s) => String(s.identity._id)),
          };
        }
        return { identity: null, matchedBy: null, confidence: 0 };
      }

      default:
        return { identity: null, matchedBy: null, confidence: 0 };
    }
  }

  private getNested(obj: unknown, path: string): unknown {
    const parts = path.split('.');
    let cur: unknown = obj;
    for (const p of parts) {
      cur = (cur as Record<string, unknown>)?.[p] ?? undefined;
      if (cur === undefined) return undefined;
    }
    return cur;
  }

  private async findByComposite(
    tenantId: string,
    fields: string[],
    values: string[],
    session?: ClientSession,
    deleted = false,
  ): Promise<IdentityDocument | null> {
    const filter = this.scope(tenantId, deleted);
    for (let i = 0; i < fields.length; i++) {
      const key = `profile.${fields[i]}`;
      filter[key] = new RegExp(`^${this.escapeRegex(values[i])}$`, 'i');
    }
    return this.findOne(filter, session, deleted);
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Find identity candidates by lastName. Uses $or with raw and normalized forms
   * to support diacritic matching (Mäkinen ↔ Makinen).
   */
  private async findByNameCandidates(
    tenantId: string,
    rawLastName: string,
    normalizedLastName: string,
    session?: ClientSession,
    deleted = false,
  ): Promise<IdentityDocument[]> {
    const patterns = [this.escapeRegex(rawLastName), this.escapeRegex(normalizedLastName)];
    const uniquePatterns = [...new Set(patterns)];
    const orConditions = uniquePatterns.map(
      (p) =>
        ({ 'profile.lastName': { $regex: new RegExp(`^${p}$`, 'i') } }) as Record<string, unknown>,
    );
    let q = this.identityModel
      .find({ ...this.scope(tenantId, deleted), $or: orConditions })
      .limit(CORRELATION_NAME_CANDIDATE_LIMIT);
    if (session) q = q.session(session);
    return q.exec();
  }

  /**
   * When a match is found, compare demographics. If both firstName and lastName
   * are completely different and confidence < 0.9, flag for review.
   */
  private demographicSanityCheck(
    dto: StandardUserDto,
    identity: IdentityDocument,
    confidence: number,
    config: CorrelationConfig,
  ): boolean {
    if (confidence >= 0.9) return false;
    const profile = identity.profile as unknown as Record<string, unknown>;
    const incomingFirst = (dto.firstName || '').trim().toLowerCase();
    const incomingLast = (dto.lastName || '').trim().toLowerCase();
    const existingFirst = ((profile?.firstName as string) || '').trim().toLowerCase();
    const existingLast = ((profile?.lastName as string) || '').trim().toLowerCase();
    const firstDiff = incomingFirst && existingFirst && incomingFirst !== existingFirst;
    const lastDiff = incomingLast && existingLast && incomingLast !== existingLast;
    if (firstDiff && lastDiff && config.conflictAction === 'review') {
      return true;
    }
    return false;
  }
}

// ── TASK 106 RECAP ──
// Modified: findCorrelatedIdentity and tryRule accept optional session; all findOne/find use .session(session).
