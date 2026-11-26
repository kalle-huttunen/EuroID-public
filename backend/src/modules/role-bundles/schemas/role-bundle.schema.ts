import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ _id: false })
export class RoleBundleAction {
  @Prop({ required: true })
  id!: string;

  @Prop({ required: true })
  type!: string;

  @Prop({ required: true })
  target!: string;

  @Prop({ type: Object, default: {} })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose Mixed type for dynamic action parameters; shape varies per action type
  params!: Record<string, any>;

  @Prop()
  label?: string;

  @Prop()
  description?: string;

  /** The id the action names its entitlement by, when the client gives one (RoleBundleActionSchema). */
  @Prop()
  targetId?: string;

  /** Time-bound access: the engine passes it on to the operation (PolicyEngineService pushAction). */
  @Prop({ type: Object })
  timeConstraint?: { durationDays?: number; expiresAt?: Date };
}

export type RoleBundleDocument = HydratedDocument<RoleBundle>;

@Schema({
  timestamps: true,
  collection: 'role_bundles',
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class RoleBundle {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ default: '' })
  description!: string;

  @Prop({ default: 'UserOutlined' })
  icon!: string;

  @Prop({ default: '#1890ff' })
  color!: string;

  @Prop({ type: [RoleBundleAction], default: [] })
  actions!: RoleBundleAction[];

  @Prop({ type: [String], default: [] })
  inheritance!: string[]; // Parent bundle IDs

  @Prop({ type: [String], default: [] })
  tags!: string[];

  @Prop({ default: 0 })
  usedByPolicies!: number;
}

export const RoleBundleSchema = SchemaFactory.createForClass(RoleBundle);
