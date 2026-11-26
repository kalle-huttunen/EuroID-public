import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { JoinerPolicy, JoinerPolicyDocument } from './schemas/joiner-policy.schema';
import { defaultJoinerPolicy, type JoinerPolicySettings } from './joiner-policy.defaults';
import type { UpdateJoinerPolicyDto } from './dto/joiner.dto';

export interface JoinerPolicyView extends JoinerPolicySettings {
  /** False while the tenant runs on the defaults (no stored policy). */
  configured: boolean;
  updatedBy?: string;
  updatedAt?: Date;
}

const POLICY_FIELDS: (keyof JoinerPolicySettings)[] = [
  'massJoinerMaxCount',
  'massJoinerMaxPercent',
  'massJoinerMinCount',
];

/** Reads and stores the per-tenant HR joiner policy. Queries are scoped by the tenant plugin. */
@Injectable()
export class JoinerPolicyService {
  constructor(
    @InjectModel(JoinerPolicy.name) private readonly policyModel: Model<JoinerPolicyDocument>,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** The current tenant's policy, or the defaults when it has none. */
  async getPolicy(): Promise<JoinerPolicyView> {
    const doc = await this.policyModel.findOne({}).lean().exec();
    if (!doc) return { ...defaultJoinerPolicy(), configured: false };
    const stored = doc as JoinerPolicy & { updatedAt?: Date };
    return {
      massJoinerMaxCount: stored.massJoinerMaxCount,
      massJoinerMaxPercent: stored.massJoinerMaxPercent,
      massJoinerMinCount: stored.massJoinerMinCount,
      configured: true,
      updatedBy: stored.updatedBy,
      updatedAt: stored.updatedAt,
    };
  }

  /** Store the current tenant's policy; `actor` is the authenticated user. Audited. */
  async updatePolicy(dto: UpdateJoinerPolicyDto, actor: string): Promise<JoinerPolicyView> {
    const before = await this.getPolicy();
    await this.policyModel
      .findOneAndUpdate(
        {},
        { $set: { ...dto, updatedBy: actor } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
      )
      .exec();
    const changedFields = POLICY_FIELDS.filter((field) => before[field] !== dto[field]);
    this.eventEmitter.emit(
      DomainEventType.JOINER_POLICY_UPDATED,
      'joiner-policy',
      { changedFields },
      { actor },
    );
    return this.getPolicy();
  }
}
