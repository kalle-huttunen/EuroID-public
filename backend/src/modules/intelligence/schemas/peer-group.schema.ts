/**
 * Peer Group Schema
 *
 * Groups identities by (department, jobTitle) and tracks entitlement baselines (the access the
 * members hold) and outliers. Used by peer deviation scoring (F-13). A build removes the tenant's
 * groups it did not write.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type PeerGroupDocument = HydratedDocument<PeerGroup>;

@Schema({ _id: false })
export class PeerGroupAttributes {
  @Prop()
  department?: string;

  @Prop()
  jobTitle?: string;

  @Prop()
  location?: string;
}

export const PeerGroupAttributesSchema = SchemaFactory.createForClass(PeerGroupAttributes);

@Schema({ _id: false })
export class EntitlementBaseline {
  @Prop({ required: true })
  entitlementId!: string;

  @Prop({ required: true })
  system!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true, type: Number, min: 0, max: 1 })
  holdRate!: number;

  /**
   * How the members holding it got it: role-based rules (policy), access requests, or both.
   * Absent on a group built before it was recorded.
   */
  @Prop({ type: [String], enum: ['policy', 'request'], default: undefined })
  grantedBy?: Array<'policy' | 'request'>;
}

export const EntitlementBaselineSchema = SchemaFactory.createForClass(EntitlementBaseline);

@Schema({ _id: false })
export class PeerGroupOutlier {
  @Prop({ required: true })
  identityId!: string;

  @Prop({ type: [String], default: [] })
  uniqueEntitlements!: string[];

  @Prop({ type: [String], default: [] })
  missingBaseline!: string[];

  @Prop({ required: true, type: Number, min: 0, max: 100 })
  deviationScore!: number;
}

export const PeerGroupOutlierSchema = SchemaFactory.createForClass(PeerGroupOutlier);

@Schema({ timestamps: true, collection: 'peer_groups' })
export class PeerGroup {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  groupKey!: string;

  @Prop({ type: PeerGroupAttributesSchema, required: true })
  attributes!: PeerGroupAttributes;

  @Prop({ required: true, type: Number, min: 0 })
  memberCount!: number;

  @Prop({ type: [String], default: [] })
  memberIds!: string[];

  @Prop({ type: [EntitlementBaselineSchema], default: [] })
  entitlementBaseline!: EntitlementBaseline[];

  @Prop({ type: [PeerGroupOutlierSchema], default: [] })
  outliers!: PeerGroupOutlier[];

  @Prop({ required: true, type: Date })
  calculatedAt!: Date;
}

export const PeerGroupSchema = SchemaFactory.createForClass(PeerGroup);

PeerGroupSchema.index({ tenantId: 1, groupKey: 1 }, { unique: true });
PeerGroupSchema.index({ tenantId: 1, memberIds: 1 });
