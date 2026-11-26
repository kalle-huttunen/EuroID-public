import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ReconciliationConfig,
  ReconciliationConfigDocument,
} from './schemas/reconciliation-config.schema';
import { UpsertReconciliationConfigDto } from './dtos/reconciliation-config.dto';

/**
 * ReconciliationConfigService — CRUD for per-tenant reconciliation configuration.
 *
 * Controls HR source tags, source priority, contract-critical fields, field mastery,
 * and target ID keys. No hardcoded defaults; returns null when unconfigured.
 */
@Injectable()
export class ReconciliationConfigService {
  private readonly logger = new Logger(ReconciliationConfigService.name);

  constructor(
    @InjectModel(ReconciliationConfig.name)
    private readonly configModel: Model<ReconciliationConfigDocument>,
  ) {}

  /**
   * The tenant's config. Its source names (hrSourceTags, sourcePriorityOrder) come lower-cased,
   * as every consumer compares them with lower-cased source names; a config saved before they
   * were stored so may hold them as typed.
   */
  async getConfig(tenantId: string): Promise<ReconciliationConfigDocument | null> {
    const config = await this.configModel.findOne({ tenantId }).exec();
    if (config) {
      config.hrSourceTags = lowerCased(config.hrSourceTags);
      config.sourcePriorityOrder = lowerCased(config.sourcePriorityOrder);
    }
    return config;
  }

  async upsertConfig(
    tenantId: string,
    dto: UpsertReconciliationConfigDto,
  ): Promise<ReconciliationConfigDocument> {
    this.logger.log(`[UpsertConfig] Saving reconciliation config for tenant ${tenantId}`);
    return this.configModel.findOneAndUpdate(
      { tenantId },
      { $set: { ...dto, tenantId } },
      { upsert: true, new: true, runValidators: true },
    );
  }

  /** Convenience: get just the hrSourceTags for a tenant. Returns empty array if unconfigured. */
  async getHrSourceTags(tenantId: string): Promise<string[]> {
    const config = await this.configModel.findOne({ tenantId }).select('hrSourceTags').exec();
    return lowerCased(config?.hrSourceTags);
  }
}

/** Source names trimmed and lower-cased, as identity sources name them. */
function lowerCased(names: string[] | undefined): string[] {
  return (names ?? []).map((name) => name.trim().toLowerCase());
}
