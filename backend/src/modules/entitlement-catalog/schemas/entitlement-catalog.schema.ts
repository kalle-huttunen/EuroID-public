import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EntitlementOrigin = 'POLICY' | 'EXTERNAL';
export type EntitlementGovernanceLevel = 'STRICT' | 'OPEN';

export type EntitlementCatalogDocument = HydratedDocument<EntitlementCatalog>;

@Schema({
  timestamps: true,
  collection: 'entitlement_catalog',
})
export class EntitlementCatalog {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, index: true })
  system!: string;

  @Prop({ index: true })
  nativeId?: string;

  @Prop({ required: true, index: true })
  name!: string;

  @Prop({ required: true })
  type!: 'Group' | 'License' | 'DirectoryRole';

  @Prop({ required: true, enum: ['POLICY', 'EXTERNAL'], default: 'EXTERNAL' })
  origin!: EntitlementOrigin;

  @Prop({ required: true, enum: ['STRICT', 'OPEN'], default: 'OPEN' })
  governanceLevel!: EntitlementGovernanceLevel;

  @Prop({ type: Object })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose Mixed type for dynamic connector metadata; shape varies per system
  metadata?: Record<string, any>;

  @Prop({ type: [String], default: [] })
  governanceTags!: string[];

  /**
   * A license's units as the target reported them at the last discovery (Entra ID
   * subscribedSkus: consumedUnits, prepaidUnits.enabled), and when. Unset until discovery has
   * read them: the license forecast then says its consumption is unknown.
   */
  @Prop(raw({ consumed: { type: Number }, enabled: { type: Number }, observedAt: { type: Date } }))
  licenseUnits?: { consumed: number; enabled: number; observedAt: Date };

  /** Email or identity ID of the person who owns/certifies this entitlement. */
  @Prop()
  owner?: string;

  @Prop({ enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], default: 'MEDIUM' })
  riskLevel?: string;

  /** PAM: Admin tier when requiresAdminAccount is true. */
  @Prop({ enum: ['TIER_0', 'TIER_1', 'TIER_2'] })
  adminTier?: string;

  /** PAM: When true, assign to linked admin identity instead of primary. */
  @Prop({ default: false })
  requiresAdminAccount?: boolean;

  /** Access Request Portal: shown in self-service catalog when true. */
  @Prop({ default: false })
  requestable?: boolean;

  /** Access Request Portal: requires approval workflow before provisioning. */
  @Prop({ default: true })
  approvalRequired?: boolean;

  /** Access Request Portal: who approves, in order. */
  @Prop({
    type: [
      {
        type: { type: String, enum: ['MANAGER', 'OWNER', 'ROLE', 'SPECIFIC_USER'] },
        value: String,
      },
    ],
    default: [],
  })
  approvalChain?: Array<{ type: 'MANAGER' | 'OWNER' | 'ROLE' | 'SPECIFIC_USER'; value?: string }>;

  /** Access Request Portal: max time-bound duration in days. */
  @Prop()
  maxDurationDays?: number;

  /** Access Request Portal: category for catalog browsing. */
  @Prop()
  category?: string;

  /** Access Request Portal: user-facing description for catalog browsing. */
  @Prop()
  userDescription?: string;
}

export const EntitlementCatalogSchema = SchemaFactory.createForClass(EntitlementCatalog);

EntitlementCatalogSchema.index({ tenantId: 1, system: 1, type: 1 });
EntitlementCatalogSchema.index({ tenantId: 1, requestable: 1, category: 1 });
EntitlementCatalogSchema.index({ tenantId: 1, governanceTags: 1 });
// A native id is unique per tenant and system. Rows without one (a group a policy names before
// discovery has found it, EntitlementCatalogService.registerPolicyGroup) are left out: a sparse
// compound index still indexes them as nativeId null, so a second such row on the system failed.
// Existing databases get it from migrations/20261122000001-entitlement-catalog-native-id-index.
EntitlementCatalogSchema.index(
  { tenantId: 1, system: 1, nativeId: 1 },
  { unique: true, partialFilterExpression: { nativeId: { $type: 'string' } } },
);
EntitlementCatalogSchema.index({ tenantId: 1, system: 1, name: 1 });
// One SCIM group per tenant and display name: the insert is the claim of a POST /scim/v2/Groups,
// so an IdP retrying a create makes no duplicate. Existing databases get it from
// migrations/20261125000004-scim-group-unique-name, which merges duplicates first.
EntitlementCatalogSchema.index(
  { tenantId: 1, name: 1 },
  {
    name: 'scim_group_name_unique',
    unique: true,
    partialFilterExpression: { system: 'scim-inbound', type: 'Group' },
  },
);
