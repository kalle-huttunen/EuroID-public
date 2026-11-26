import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type TenantDocument = HydratedDocument<Tenant>;

@Schema({ collection: 'tenants', timestamps: true })
export class Tenant {
  @Prop({ required: true, unique: true })
  tenantId!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ enum: ['active', 'suspended', 'deprovisioned'], default: 'active' })
  status!: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  settings!: {
    maxIdentities?: number;
    retentionDays?: number;
    allowedConnectors?: string[];
    features?: Record<string, boolean>;
    mfaRequired?: boolean;
  };

  @Prop({ default: 'system' })
  createdBy!: string;

  /**
   * Set while the tenant has more live identities than settings.maxIdentities, once
   * tenant.identity_limit_exceeded was raised for it; cleared when a check finds the count within
   * the limit (modules/identity/identity-limit.ts).
   */
  @Prop()
  identityLimitExceededAt?: Date;
}

export const TenantSchema = SchemaFactory.createForClass(Tenant);

// Exempt from tenant plugin - tenants collection is tenant-agnostic
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose schema options do not expose custom keys; cast required for plugin bypass flag
TenantSchema.set('skipTenantPlugin' as any, true);
