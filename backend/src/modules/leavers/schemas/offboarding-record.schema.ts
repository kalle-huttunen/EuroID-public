import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { OffboardingResult } from '@shared/types/deprovision';

/** What an offboarding did per target system, as the Leavers page shows it. */
export interface StoredOffboardingResult {
  status: OffboardingResult['status'];
  hubStatus: OffboardingResult['hubStatus'];
  systems: OffboardingResult['systems'];
  /** The person's linked admin accounts, offboarded first; absent or empty when there were none. */
  linkedAdmins?: NonNullable<OffboardingResult['linkedAdmins']>;
  finishedAt: Date;
}

/**
 * The per-system result of one offboarding (IDENTITY_OFFBOARDING_COMPLETED), whatever started it:
 * an HR leaver event (LeaverEvent.workflowId) or DELETE /identity/:id, which has no leaver event.
 * Keyed by the workflow id; a rerun of the same workflow id replaces it. The Leavers page lists
 * the ones that left a target or a linked admin account failed, and an admin closes a failed
 * target as removed manually here (LeaverManualRemovalService).
 */
@Schema({ timestamps: true, collection: 'offboarding_records' })
export class OffboardingRecord implements StoredOffboardingResult {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  workflowId!: string;

  @Prop({ required: true })
  identityId!: string;

  @Prop({ required: true, type: String, enum: ['completed', 'partial-failure'] })
  status!: OffboardingResult['status'];

  @Prop({ required: true, type: String, enum: ['deleted', 'suspended'] })
  hubStatus!: OffboardingResult['hubStatus'];

  @Prop({ type: [Object], required: true })
  systems!: OffboardingResult['systems'];

  /** Absent on records from before the cascade to linked admin accounts. */
  @Prop({ type: [Object], default: undefined })
  linkedAdmins?: NonNullable<OffboardingResult['linkedAdmins']>;

  @Prop({ required: true })
  finishedAt!: Date;
}

export type OffboardingRecordDocument = HydratedDocument<OffboardingRecord>;
export const OffboardingRecordSchema = SchemaFactory.createForClass(OffboardingRecord);

OffboardingRecordSchema.index({ tenantId: 1, workflowId: 1 }, { unique: true });
OffboardingRecordSchema.index({ tenantId: 1, 'systems.outcome': 1, finishedAt: -1 });
OffboardingRecordSchema.index({ tenantId: 1, 'linkedAdmins.outcome': 1, finishedAt: -1 });
