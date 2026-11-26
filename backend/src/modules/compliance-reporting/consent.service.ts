/**
 * Consent Service (GDPR Article 6)
 *
 * CRUD for per-identity processing consent records.
 * Tracks opt-in/opt-out per purpose with expiration support: one record per identity and purpose
 * (unique index), marked `expired` once past its expiresAt when it is read.
 */

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { ConsentDocument } from './schemas/consent.schema';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';

import type { GrantConsentDto } from './dtos/grant-consent.dto';

/** The unique { tenantId, identityId, purpose } index refused the write. */
const isDuplicateKey = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

export interface ConsentReport {
  tenantId: string;
  totalIdentities: number;
  byPurpose: Array<{
    purpose: string;
    granted: number;
    revoked: number;
    expired: number;
  }>;
}

@Injectable()
export class ConsentService {
  constructor(
    @InjectModel('Consent') private readonly consentModel: Model<ConsentDocument>,
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
  ) {}

  /**
   * Record a consent grant for an identity + purpose.
   * Upserts: if a record for this identity+purpose already exists, it becomes this grant: the
   * method and expiry are this grant's (removed when it has none) and a revocation is cleared.
   * The identity must exist in the caller's tenant (an offboarded one counts), else 404.
   */
  async grantConsent(
    identityId: string,
    dto: GrantConsentDto,
    grantedBy: string,
  ): Promise<ConsentDocument> {
    if (!dto.purpose?.trim()) {
      throw new BadRequestException('purpose is required');
    }

    const ctx = getRequestContext();
    const tenantId = ctx?.tenantId ?? 'unknown';

    const identity = await this.identityModel.exists({ _id: identityId, tenantId }).exec();
    if (!identity) {
      throw new NotFoundException(`Identity ${identityId} not found`);
    }

    // Mongoose drops undefined values from $set, so fields this grant does not have are unset:
    // a grant again would otherwise keep the old expiry, method and revocation date.
    const set: Record<string, unknown> = { status: 'granted', grantedAt: new Date(), grantedBy };
    const unset: Record<string, ''> = { revokedAt: '' };
    if (dto.method) set.method = dto.method;
    else unset.method = '';
    if (dto.expiresAt) set.expiresAt = new Date(dto.expiresAt);
    else unset.expiresAt = '';

    const upsert = () =>
      this.consentModel
        .findOneAndUpdate(
          { tenantId, identityId, purpose: dto.purpose },
          {
            $set: set,
            $unset: unset,
            $setOnInsert: { tenantId, identityId, purpose: dto.purpose },
          },
          { upsert: true, new: true },
        )
        .exec();
    // Two grants at once both try the insert; the unique index refuses the second, which then
    // finds the record the first stored and updates it
    const consent = await upsert().catch((err: unknown) => {
      if (isDuplicateKey(err)) return upsert();
      throw err;
    });

    if (!consent) {
      throw new NotFoundException(
        `Consent not found for identity ${identityId}, purpose ${dto.purpose}`,
      );
    }
    return consent;
  }

  /**
   * Revoke consent for an identity + purpose.
   */
  async revokeConsent(identityId: string, purpose: string): Promise<ConsentDocument> {
    const ctx = getRequestContext();
    const tenantId = ctx?.tenantId ?? 'unknown';

    const consent = await this.consentModel
      .findOneAndUpdate(
        { tenantId, identityId, purpose },
        { $set: { status: 'revoked', revokedAt: new Date() } },
        { new: true },
      )
      .exec();

    if (!consent) {
      throw new NotFoundException(
        `No consent found for identity ${identityId}, purpose ${purpose}`,
      );
    }

    return consent;
  }

  /**
   * List all consent records for a single identity.
   */
  async listConsents(identityId: string): Promise<ConsentDocument[]> {
    const ctx = getRequestContext();
    const tenantId = ctx?.tenantId ?? 'unknown';
    await this.expireDue(tenantId, identityId);

    return this.consentModel
      .find({ tenantId, identityId })
      .sort({ purpose: 1 })
      .lean()
      .exec() as Promise<ConsentDocument[]>;
  }

  /**
   * Aggregate consent report across all identities in the tenant.
   */
  async getConsentReport(): Promise<ConsentReport> {
    const ctx = getRequestContext();
    const tenantId = ctx?.tenantId ?? 'unknown';
    await this.expireDue(tenantId);

    const totalIdentities = await this.consentModel
      .distinct('identityId', { tenantId })
      .then((ids) => ids.length);

    const pipeline = await this.consentModel
      .aggregate([
        { $match: { tenantId } },
        {
          $group: {
            _id: { purpose: '$purpose', status: '$status' },
            count: { $sum: 1 },
          },
        },
      ])
      .exec();

    const purposeMap = new Map<string, { granted: number; revoked: number; expired: number }>();
    for (const row of pipeline) {
      const purpose = row._id.purpose;
      const status = row._id.status as string;
      if (!purposeMap.has(purpose)) {
        purposeMap.set(purpose, { granted: 0, revoked: 0, expired: 0 });
      }
      const entry = purposeMap.get(purpose);
      if (!entry) continue;
      if (status === 'granted') entry.granted = row.count;
      else if (status === 'revoked') entry.revoked = row.count;
      else if (status === 'expired') entry.expired = row.count;
    }

    const byPurpose = Array.from(purposeMap.entries()).map(([purpose, counts]) => ({
      purpose,
      ...counts,
    }));

    return { tenantId, totalIdentities, byPurpose };
  }

  /**
   * Marks the tenant's granted consents past their expiresAt `expired` (only `identityId`'s when
   * given), so a list or the report answers the status without a cron. Only records still
   * granted change: a revoke is never overwritten, and a grant again with a new expiry makes the
   * record granted again.
   */
  private async expireDue(tenantId: string, identityId?: string): Promise<void> {
    await this.consentModel
      .updateMany(
        {
          tenantId,
          ...(identityId ? { identityId } : {}),
          status: 'granted',
          expiresAt: { $lte: new Date() },
        },
        { $set: { status: 'expired' } },
      )
      .exec();
  }
}
