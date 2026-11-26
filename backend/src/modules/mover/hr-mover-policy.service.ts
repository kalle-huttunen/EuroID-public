import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { MoverPolicy, MoverPolicyDocument } from './schemas/mover-policy.schema';
import { defaultMoverPolicy, type MoverPolicySettings } from './hr-mover-policy.defaults';
import type { UpdateMoverPolicyDto } from './dto/hr-mover.dto';

export interface MoverPolicyView extends MoverPolicySettings {
  /** False while the tenant runs on the defaults (no stored policy). */
  configured: boolean;
  updatedBy?: string;
  updatedAt?: Date;
}

const POLICY_FIELDS: (keyof MoverPolicySettings)[] = [
  'massMoverMaxCount',
  'massMoverMaxPercent',
  'massMoverMinCount',
];

/** Reads and stores the per-tenant HR mover policy. Queries are scoped by the tenant plugin. */
@Injectable()
export class HrMoverPolicyService {
  constructor(
    @InjectModel(MoverPolicy.name) private readonly policyModel: Model<MoverPolicyDocument>,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** The current tenant's policy, or the defaults when it has none. */
  async getPolicy(): Promise<MoverPolicyView> {
    const doc = await this.policyModel.findOne({}).lean().exec();
    if (!doc) return { ...defaultMoverPolicy(), configured: false };
    const stored = doc as MoverPolicy & { updatedAt?: Date };
    return {
      massMoverMaxCount: stored.massMoverMaxCount,
      massMoverMaxPercent: stored.massMoverMaxPercent,
      massMoverMinCount: stored.massMoverMinCount,
      configured: true,
      updatedBy: stored.updatedBy,
      updatedAt: stored.updatedAt,
    };
  }

  /** Store the current tenant's policy; `actor` is the authenticated user. Audited. */
  async updatePolicy(dto: UpdateMoverPolicyDto, actor: string): Promise<MoverPolicyView> {
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
      DomainEventType.MOVER_POLICY_UPDATED,
      'mover-policy',
      { changedFields },
      { actor },
    );
    return this.getPolicy();
  }
}
