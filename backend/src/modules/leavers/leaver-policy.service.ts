import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { LeaverPolicy, LeaverPolicyDocument } from './schemas/leaver-policy.schema';
import {
  defaultLeaverPolicy,
  defaultMassLeaverMinCount,
  isValidTimeZone,
  type LeaverPolicySettings,
} from './leaver-policy.defaults';
import type { UpdateLeaverPolicyDto } from './dto/leaver.dto';

export interface LeaverPolicyView extends LeaverPolicySettings {
  /** False while the tenant runs on the defaults (no stored policy). */
  configured: boolean;
  updatedBy?: string;
  updatedAt?: Date;
}

const POLICY_FIELDS: (keyof LeaverPolicySettings)[] = [
  'signals',
  'terminatedStatuses',
  'missingSyncThreshold',
  'massLeaverMaxCount',
  'massLeaverMaxPercent',
  'massLeaverMinCount',
  'timezone',
];

/** Reads and stores the per-tenant leaver policy. Queries are scoped by the tenant plugin. */
@Injectable()
export class LeaverPolicyService {
  constructor(
    @InjectModel(LeaverPolicy.name) private readonly policyModel: Model<LeaverPolicyDocument>,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** The current tenant's policy, or the defaults when it has none. */
  async getPolicy(): Promise<LeaverPolicyView> {
    const doc = await this.policyModel.findOne({}).lean().exec();
    if (!doc) return { ...defaultLeaverPolicy(), configured: false };
    const stored = doc as LeaverPolicy & { updatedAt?: Date };
    return {
      signals: { ...stored.signals },
      terminatedStatuses: [...stored.terminatedStatuses],
      missingSyncThreshold: stored.missingSyncThreshold,
      massLeaverMaxCount: stored.massLeaverMaxCount,
      massLeaverMaxPercent: stored.massLeaverMaxPercent,
      massLeaverMinCount:
        stored.massLeaverMinCount ?? defaultMassLeaverMinCount(stored.massLeaverMaxCount),
      // A zone the runtime no longer knows falls back to UTC instead of breaking detection.
      timezone: isValidTimeZone(stored.timezone) ? stored.timezone : 'UTC',
      configured: true,
      updatedBy: stored.updatedBy,
      updatedAt: stored.updatedAt,
    };
  }

  /** Store the current tenant's policy; `actor` is the authenticated user. Audited. */
  async updatePolicy(dto: UpdateLeaverPolicyDto, actor: string): Promise<LeaverPolicyView> {
    const before = await this.getPolicy();
    await this.policyModel
      .findOneAndUpdate(
        {},
        { $set: { ...dto, updatedBy: actor } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
      )
      .exec();
    const changedFields = POLICY_FIELDS.filter(
      (field) => JSON.stringify(before[field]) !== JSON.stringify(dto[field]),
    );
    this.eventEmitter.emit(
      DomainEventType.LEAVER_POLICY_UPDATED,
      'leaver-policy',
      { changedFields },
      { actor },
    );
    return this.getPolicy();
  }
}
