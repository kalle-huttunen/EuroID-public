/**
 * Credential Inventory Service
 *
 * Tracks credential state (password expiry, MFA, passkeys, certificates)
 * per identity per target system. Written by the nightly credential rotation run
 * (CredentialInventoryRefresh), read by it and by the credential lifecycle API.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  CredentialInventory,
  type CredentialInventoryDocument,
  type PasswordStatus,
} from './schemas/credential-inventory.schema';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';

/** Earliest due date first; `_id` keeps rows with the same date (or none) in a stable order. */
const EARLIEST_DUE_FIRST = { 'password.nextRotation': 1, _id: 1 } as const;

@Injectable()
export class CredentialInventoryService {
  private readonly logger = new Logger(CredentialInventoryService.name);

  constructor(
    @InjectModel(CredentialInventory.name)
    private readonly model: Model<CredentialInventoryDocument>,
  ) {}

  /**
   * Upsert credential state for an identity+target combination.
   */
  async upsert(
    tenantId: string,
    identityId: string,
    targetSystem: string,
    externalId: string,
    update: Partial<CredentialInventory>,
  ): Promise<CredentialInventoryDocument> {
    const result = await this.model.findOneAndUpdate(
      { tenantId, identityId, targetSystem },
      {
        $set: {
          externalId,
          ...update,
        },
        $setOnInsert: { tenantId, identityId, targetSystem },
      },
      { upsert: true, new: true, lean: false },
    );
    return result!;
  }

  /**
   * Get all credential records for an identity.
   */
  async findByIdentity(
    tenantId: string,
    identityId: string,
  ): Promise<CredentialInventoryDocument[]> {
    return this.model.find({ tenantId, identityId }).lean().exec();
  }

  /**
   * Get credential record for a specific identity + target system.
   */
  async findByIdentityAndTarget(
    tenantId: string,
    identityId: string,
    targetSystem: string,
  ): Promise<CredentialInventoryDocument | null> {
    return this.model.findOne({ tenantId, identityId, targetSystem }).lean().exec();
  }

  /**
   * Find credentials where nextRotation <= beforeDate (due for rotation), most overdue first, so
   * a limit cuts the ones due last.
   */
  async findExpiring(
    tenantId: string,
    beforeDate: Date,
    limit: number,
  ): Promise<CredentialInventoryDocument[]> {
    return this.model
      .find({
        tenantId,
        'password.nextRotation': { $lte: beforeDate },
        'password.status': { $ne: 'UNKNOWN' },
      })
      .sort(EARLIEST_DUE_FIRST)
      .limit(limit)
      .lean()
      .exec();
  }

  /**
   * Find credentials by password status, earliest due first (UNKNOWN rows have no due date).
   */
  async findByStatus(
    tenantId: string,
    status: PasswordStatus,
    limit: number,
  ): Promise<CredentialInventoryDocument[]> {
    return this.model
      .find({ tenantId, 'password.status': status })
      .sort(EARLIEST_DUE_FIRST)
      .limit(limit)
      .lean()
      .exec();
  }

  /**
   * The credentials in a due status (EXPIRED, EXPIRING_SOON) the nightly run reports next: never
   * reported first, then the ones reported longest ago, earliest due among equals. With more due
   * than the run's cap, the rows left out one night come first the next.
   */
  async findDueToReport(
    tenantId: string,
    status: Extract<PasswordStatus, 'EXPIRED' | 'EXPIRING_SOON'>,
    limit: number,
  ): Promise<CredentialInventoryDocument[]> {
    return this.model
      .find({ tenantId, 'password.status': status })
      .sort({ dueReportedAt: 1, ...EARLIEST_DUE_FIRST })
      .limit(limit)
      .lean()
      .exec();
  }

  /** Stamps the rows the run reported as due (findDueToReport). */
  async markDueReported(tenantId: string, ids: Types.ObjectId[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.model
      .updateMany({ tenantId, _id: { $in: ids } }, { $set: { dueReportedAt: at } })
      .exec();
  }

  /**
   * Each row of the tenant: its key, when the nightly run last read the account, and its password
   * status.
   */
  async findObservations(tenantId: string): Promise<
    Array<
      Pick<CredentialInventory, 'identityId' | 'targetSystem' | 'observedAt' | 'password'> & {
        _id: Types.ObjectId;
      }
    >
  > {
    return this.model
      .find({ tenantId }, { identityId: 1, targetSystem: 1, observedAt: 1, 'password.status': 1 })
      .lean()
      .exec();
  }

  /** Delete these rows of the tenant (accounts the identity no longer has); answers the count. */
  async deleteByIds(tenantId: string, ids: Types.ObjectId[]): Promise<number> {
    if (!ids.length) return 0;
    const result = await this.model.deleteMany({ tenantId, _id: { $in: ids } });
    return result.deletedCount ?? 0;
  }

  /**
   * Bulk-recalculate password statuses: COMPLIANT → EXPIRING_SOON → EXPIRED.
   */
  async recalculateStatuses(
    tenantId: string,
    now: Date,
    warningDays: number,
  ): Promise<{ updated: number }> {
    const warningDate = new Date(now.getTime() + warningDays * 86_400_000);

    // Mark expired (nextRotation <= now)
    const expired = await this.model.updateMany(
      {
        tenantId,
        'password.nextRotation': { $lte: now },
        'password.status': { $in: ['COMPLIANT', 'EXPIRING_SOON'] },
      },
      { $set: { 'password.status': 'EXPIRED' } },
    );

    // Mark expiring soon (nextRotation <= warningDate AND > now)
    const expiringSoon = await this.model.updateMany(
      {
        tenantId,
        'password.nextRotation': { $gt: now, $lte: warningDate },
        'password.status': 'COMPLIANT',
      },
      { $set: { 'password.status': 'EXPIRING_SOON' } },
    );

    const total = (expired.modifiedCount ?? 0) + (expiringSoon.modifiedCount ?? 0);
    if (total > 0) {
      this.logger.log(`[recalculateStatuses] Updated ${total} credentials for tenant ${tenantId}`);
    }
    return { updated: total };
  }

  /**
   * Compliance summary: aggregate counts by password status.
   */
  async getComplianceSummary(tenantId: string): Promise<{
    compliant: number;
    expiringSoon: number;
    expired: number;
    unknown: number;
    total: number;
  }> {
    const results = await this.model.aggregate([
      { $match: { tenantId } },
      {
        $group: {
          _id: '$password.status',
          count: { $sum: 1 },
        },
      },
    ]);

    const counts: Record<string, number> = {};
    for (const r of results) {
      counts[r._id ?? 'UNKNOWN'] = r.count;
    }

    const compliant = counts['COMPLIANT'] ?? 0;
    const expiringSoon = counts['EXPIRING_SOON'] ?? 0;
    const expired = counts['EXPIRED'] ?? 0;
    const unknown = counts['UNKNOWN'] ?? 0;

    return {
      compliant,
      expiringSoon,
      expired,
      unknown,
      total: compliant + expiringSoon + expired + unknown,
    };
  }
}
