/**
 * Data Retention Service
 *
 * Enforces retention policies: TTL config, soft-delete purge.
 * Used by admin endpoints and optional cron/Temporal workflows.
 */

import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { IdentityDocument } from '../../modules/identity/schemas/identity.schema';
import { type DataRetentionConfig, dataRetentionConfig } from '../config/data-retention.config';

export { DataRetentionConfig as RetentionConfig };

export interface PurgeResult {
  usersPurged: number;
  identitiesPurged: number;
  cutoffDate: Date;
}

@Injectable()
export class DataRetentionService {
  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    @Inject(dataRetentionConfig.KEY) private readonly retentionConf: DataRetentionConfig,
  ) {}

  /**
   * Returns current TTL and retention settings.
   */
  getRetentionConfig(): DataRetentionConfig {
    return { ...this.retentionConf };
  }

  /**
   * Hard-delete identities with deletedAt older than retentionDays.
   * Use with caution — irreversible.
   */
  async purgeDeletedIdentities(retentionDays?: number): Promise<PurgeResult> {
    const config = this.getRetentionConfig();
    const days = retentionDays ?? config.identitySoftDeleteRetentionDays;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const identityResult = await this.identityModel
      .deleteMany({ deletedAt: { $lt: cutoffDate } })
      .exec();

    return {
      usersPurged: 0,
      identitiesPurged: identityResult.deletedCount,
      cutoffDate,
    };
  }

  /**
   * Dry-run: logs what would be purged. Returns counts without deleting.
   */
  async runRetentionChecks(retentionDays?: number): Promise<PurgeResult & { dryRun: true }> {
    const config = this.getRetentionConfig();
    const days = retentionDays ?? config.identitySoftDeleteRetentionDays;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const identitiesToPurge = await this.identityModel
      .countDocuments({ deletedAt: { $lt: cutoffDate } })
      .exec();

    return {
      usersPurged: 0,
      identitiesPurged: identitiesToPurge,
      cutoffDate,
      dryRun: true,
    };
  }
}
