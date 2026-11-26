import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { UserStatus, EmploymentType, UserPriority } from '@shared/dtos/standard-user.dto';
import type { AccessBaseline } from '@shared/utils/access-baseline';
import type { ManualOverrides } from '../manual-contract-overrides';
import {
  EMAIL_CONFLICT_INDEX_KEY,
  EMAIL_CONFLICT_INDEX_OPTIONS,
} from '../identity-email-case-conflict';
import { EMPLOYEE_ID_INDEX_KEY, EMPLOYEE_ID_INDEX_OPTIONS } from '../identity-employee-id';
import type { AttributeControlInfo } from '../attribute-controls';

// ========================================
// SUB-SCHEMA: LinkedAccount (Layer 2 - Raw per source)
// ========================================

/** Contract type for multi-HR: primary = main employment, secondary = concurrent. */
export type ContractType = 'primary' | 'secondary';

/** Source role: HR sources vs target systems (Entra, AD). */
export type SourceRole = 'primary-hr' | 'secondary-hr' | 'target';

@Schema({ _id: false })
export class LinkedAccount {
  @Prop({ required: true })
  sourceName!: string; // e.g. 'workday-prod', 'bamboohr-subsidiary', 'ad'

  @Prop({ required: true })
  externalId!: string;

  @Prop({ default: () => new Date() })
  lastSync!: Date;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  rawData!: Record<string, unknown>;

  /** Contract semantics: HR payload can declare primary vs secondary. */
  @Prop({ enum: ['primary', 'secondary'] })
  contractType?: ContractType;

  /** Source role from connector config (primary-hr, secondary-hr, or target). */
  @Prop({ enum: ['primary-hr', 'secondary-hr', 'target'] })
  sourceRole?: SourceRole;
}

export const LinkedAccountSchema = SchemaFactory.createForClass(LinkedAccount);

// ========================================
// SUB-SCHEMA: ProvisioningState (Layer 4 - Per-target status)
// ========================================

@Schema({ _id: false })
export class ProvisioningState {
  @Prop({ required: true })
  targetSystem!: string; // e.g. 'entra-tenant-1', 'entra'

  @Prop({ enum: ['PENDING', 'SYNCING', 'SYNCED', 'ERROR', 'DEPROVISIONED'], default: 'PENDING' })
  status!: 'PENDING' | 'SYNCING' | 'SYNCED' | 'ERROR' | 'DEPROVISIONED';

  @Prop()
  errorMsg?: string;

  @Prop()
  lastSync?: Date;

  /** True after first writeback. Prevents circular writeback on re-sync. */
  @Prop({ default: false })
  writebackComplete?: boolean;

  /**
   * When the target first reported the account provisioned (SYNCED): the system has an account,
   * also while a later run there is in ERROR. Null after a deprovision until the next SYNCED.
   * Absent on entries no write has touched since 2.0dq (IdentityProvisioningService
   * hasProvisionedAccount reads those from status, writebackComplete and the account id).
   */
  @Prop({ type: Date })
  provisionedAt?: Date | null;

  /** Time-bound access: when this provisioning entry expires. */
  @Prop()
  expiresAt?: Date;

  /** Time-bound access: when this provisioning entry becomes active. */
  @Prop()
  activeFrom?: Date;

  /** How the access was granted: policy, request, or manual. */
  @Prop({ enum: ['policy', 'request', 'manual'], default: 'policy' })
  grantedBy?: string;

  /**
   * Expiry warnings entitlementExpiryWorkflow emitted (7 days, 1 day): the expiresAt each was for.
   * One stored for another day than the current expiresAt counts as not emitted.
   */
  @Prop(raw({ soon: { type: Date }, tomorrow: { type: Date } }))
  expiryWarnings?: { soon?: Date; tomorrow?: Date };

  /**
   * The last failed deprovision of this entry by entitlementExpiryWorkflow, for the expiresAt it
   * was for (one for another expiresAt counts as none). With nextAttemptAt the entry is tried
   * again from then on; without it (not retryable) later runs skip the entry.
   */
  @Prop(
    raw({
      expiresAt: { type: Date },
      failedAt: { type: Date },
      reason: { type: String },
      retryable: { type: Boolean },
      attempts: { type: Number },
      nextAttemptAt: { type: Date },
    }),
  )
  expiryFailure?: {
    expiresAt: Date;
    failedAt: Date;
    reason: string;
    retryable: boolean;
    attempts: number;
    nextAttemptAt?: Date;
  };
}

export const ProvisioningStateSchema = SchemaFactory.createForClass(ProvisioningState);

// ========================================
// SUB-SCHEMA: Golden Record (Layer 1 - Flat profile)
// ========================================

@Schema({ _id: false })
export class IdentityProfile {
  @Prop({ required: true })
  firstName!: string;

  @Prop()
  middleName?: string;

  @Prop({ required: true })
  lastName!: string;

  @Prop()
  preferredName?: string;

  @Prop()
  displayName?: string;

  @Prop({ required: true })
  email!: string;

  @Prop()
  personalEmail?: string;

  @Prop()
  mobilePhone?: string;

  @Prop()
  workPhone?: string;

  @Prop()
  officeExtension?: string;

  @Prop()
  jobTitle?: string;

  @Prop()
  departmentCode?: string;

  @Prop()
  departmentName?: string;

  @Prop()
  division?: string;

  @Prop()
  costCenter?: string;

  @Prop()
  employeeId?: string;

  @Prop({ type: String, enum: EmploymentType })
  employmentType?: EmploymentType;

  @Prop()
  managerEmail?: string;

  @Prop()
  managerId?: string;

  @Prop()
  startDate?: Date;

  @Prop()
  endDate?: Date;

  @Prop()
  location?: string;

  @Prop()
  officeName?: string;

  @Prop()
  officeLocation?: string;

  @Prop()
  countryCode?: string;

  @Prop()
  stateProvince?: string;

  @Prop()
  city?: string;

  @Prop()
  address?: string;

  @Prop()
  postalCode?: string;

  @Prop()
  timezone?: string;

  @Prop({ type: String, enum: UserStatus, default: UserStatus.PENDING })
  status!: UserStatus;

  @Prop({ type: String, enum: UserPriority, default: UserPriority.STANDARD })
  priority?: UserPriority;

  @Prop()
  userPrincipalName?: string;

  @Prop()
  samAccountName?: string;

  @Prop()
  employeeNumber?: string;

  @Prop({ default: false })
  requiresBackgroundCheck?: boolean;

  @Prop({ default: false })
  backgroundCheckCompleted?: boolean;

  @Prop()
  securityClearance?: string;

  @Prop()
  dataClassification?: string;

  @Prop({ type: Object, default: {} })
  customAttributes?: Record<string, unknown>;

  @Prop({ type: [String], default: [] })
  tags?: string[];

  // Identifiers used for merge (not stored in profile in DB, set by reconciliation from source)
  @Prop()
  sourceSystem?: string;

  @Prop()
  sourceUserId?: string;

  /** @deprecated Use root-level tenantId on Identity instead. Kept for backward compat during migration. */
  @Prop()
  tenantId?: string;

  /** HMAC hash of national ID (HETU, SSN) for correlation. Never store raw PII. */
  @Prop({ sparse: true })
  correlationId?: string;
}

export const IdentityProfileSchema = SchemaFactory.createForClass(IdentityProfile);

// ========================================
// SUB-SCHEMA: Controls (Layer 3 - Admin overrides)
// ========================================

/**
 * Reason, author, time and optional expiry of an attribute control (attribute-controls.ts). Nested
 * paths (raw), not a subschema.
 */
const attributeControlInfo = () =>
  raw({
    reason: { type: String },
    setBy: { type: String },
    setAt: { type: Date },
    expiresAt: { type: Date },
  });

@Schema({ _id: false })
export class IdentityControls {
  /** When true, login is disabled (e.g. "Teacher blocks student") */
  @Prop({ default: false })
  isLoginDisabled!: boolean;

  /**
   * Department override (PATCH /identity/v2/:id/controls): reconcile writes it into
   * profile.departmentName and the policy contracts take it, until it is removed or expires.
   * Set before 2026-11-24 it may have no reason.
   */
  @Prop()
  manualDepartment?: string;

  @Prop(attributeControlInfo())
  manualDepartmentInfo?: AttributeControlInfo;

  /** Job title override, as manualDepartment for profile.jobTitle. */
  @Prop()
  manualJobTitle?: string;

  @Prop(attributeControlInfo())
  manualJobTitleInfo?: AttributeControlInfo;

  /** Optional overrides (e.g. email). Use Mixed so Mongoose can determine the type. */
  @Prop({ type: MongooseSchema.Types.Mixed })
  overrides?: { email?: string };
}

export const IdentityControlsSchema = SchemaFactory.createForClass(IdentityControls);

// ========================================
// SUB-SCHEMA: LinkedAdminAccount (PAM - Linked admin identities)
// ========================================

@Schema({ _id: false })
export class LinkedAdminAccount {
  @Prop({ required: true })
  identityId!: string; // MongoDB ObjectId ref to admin Identity

  @Prop({ required: true, enum: ['TIER_0', 'TIER_1', 'TIER_2'] })
  adminTier!: string;

  /**
   * The privileged session (privilegedSessionWorkflow): PENDING (never activated), ACTIVATING
   * (enabling the accounts in the target systems), ACTIVE (enabled until `expiresAt`), INACTIVE.
   */
  @Prop({ enum: ['ACTIVE', 'INACTIVE', 'PENDING', 'ACTIVATING'], default: 'PENDING' })
  status!: string;

  @Prop()
  activatedAt?: Date;

  @Prop()
  deactivatedAt?: Date;

  /** Time-bounded sessions: when this admin activation expires. */
  @Prop()
  expiresAt?: Date;

  /** The last session's id (the activation request's); the API waits for its outcome by it. */
  @Prop()
  sessionId?: string;

  /** Why the last activation failed (nothing stays enabled); cleared by the next activation. */
  @Prop()
  activationError?: string;

  /**
   * Why disabling the accounts failed at the end of a session (they may still be enabled; the
   * hourly sweep retries); cleared once a disable succeeds.
   */
  @Prop()
  disableError?: string;

  /**
   * When the hourly sweep raised admin_account.activation_pending for an Okta account still
   * waiting for its owner's activation (pam-okta-activation.ts): one alert per wait; cleared
   * once a disable succeeds.
   */
  @Prop()
  activationPendingAlertedAt?: Date;
}

export const LinkedAdminAccountSchema = SchemaFactory.createForClass(LinkedAdminAccount);

// ========================================
// MAIN SCHEMA: Identity (The Onion Document)
// ========================================

export type IdentityDocument = HydratedDocument<Identity>;

@Schema({
  timestamps: true,
  collection: 'identities',
  optimisticConcurrency: true,
})
export class Identity {
  /** Tenant identifier for multi-tenancy (required at root level) */
  @Prop({ required: true, index: true })
  tenantId!: string;

  // Layer 1: Golden Record (computed by ReconciliationService)
  @Prop({ type: IdentityProfileSchema, required: true })
  profile!: IdentityProfile;

  // Layer 2: Raw data per source (connectors write here)
  @Prop({
    type: [LinkedAccountSchema],
    default: [],
    validate: {
      validator: (v: LinkedAccount[]) => (v?.length ?? 0) <= 50,
      message: 'Identity sources array exceeds maximum of 50 entries',
    },
  })
  sources!: LinkedAccount[];

  // Layer 3: Admin overrides (above source data in priority)
  @Prop({ type: IdentityControlsSchema, default: () => ({}) })
  controls!: IdentityControls;

  // Layer 4: Per-target provisioning status
  @Prop({ type: [ProvisioningStateSchema], default: [] })
  provisioning!: ProvisioningState[];

  /**
   * The profile values policy access was last applied with (shared/utils/access-baseline.ts):
   * recorded at the first SYNCED target, advanced by each completed mover run. The access preview
   * and re-evaluation compare the current profile with it. Names and contact data are left out.
   */
  @Prop({ type: MongooseSchema.Types.Mixed })
  accessBaseline?: AccessBaseline;

  /** Soft-delete: set when identity is offboarded. Excluded from queries by default. */
  @Prop()
  deletedAt?: Date;

  @Prop()
  deletedBy?: string;

  /** PAM: Linked admin accounts (on primary identities only). */
  @Prop({ type: [LinkedAdminAccountSchema], default: [] })
  linkedAdminAccounts?: LinkedAdminAccount[];

  /** PAM: Set on admin identities — refs primary identity. */
  @Prop()
  parentIdentityId?: string;

  /** PAM: Set on admin identities — tier classification. */
  @Prop({ enum: ['TIER_0', 'TIER_1', 'TIER_2'] })
  adminTier?: string;

  /**
   * PAM: on admin identities, the last known state of its accounts in the target systems, as a
   * privileged session left them: `enabled` (a session is active, or its disable failed) or
   * `disabled`. Unset (unknown) for admin identities from before sessions existed: the hourly
   * sweep disables those (PrivilegedAccessService.convergeStandingState).
   */
  @Prop({ enum: ['enabled', 'disabled'] })
  pamTargetState?: string;

  // Layer 5: Metadata
  @Prop({ type: Object, default: {} })
  metadata?: {
    mastery?: Record<string, string>; // e.g. { jobTitle: 'workday', email: 'entra-id' }
    version?: number;
    /** Primary HR source (sourceName) driving provisioning decisions. */
    primaryHrSource?: string;
    /** External ID in the primary HR system. */
    primaryContractExternalId?: string;
    /**
     * While the kill switch (controls.isLoginDisabled) holds the status SUSPENDED: the status the
     * sources and edits gave the identity, which reconcile restores when the switch is turned off
     * (null: none). Unset otherwise, and on identities suspended before 2026-11-25.
     */
    statusUnderKillSwitch?: string | null;
    /** Correlation conflict: demographics differ between matched records. */
    correlationConflict?: boolean;
    /** Requires admin review (merge/split/dismiss). */
    requiresReview?: boolean;
    /** Snapshot of conflicting records for resolution UI. */
    conflictDetails?: {
      matchedBy: string;
      matchedValue?: string;
      confidence: number;
      existingSnapshot?: Record<string, unknown>;
      incomingSnapshot?: Record<string, unknown>;
      /** ID of the identity minted for the incoming record (for merge). */
      incomingIdentityId?: string;
      /**
       * The incoming record itself, when it could not get an identity of its own because an
       * identity already has its email (conflict-held-rows.ts). Merge adds it as a source.
       */
      incomingSource?: LinkedAccount;
    };
    /** Uncorrelated Queue: first-time linking status. */
    correlationStatus?: 'correlated' | 'uncorrelated' | 'ambiguous' | 'manual-review';
    /** When ambiguous: identity IDs of potential matches for manual linking. */
    ambiguousCandidates?: string[];
    /**
     * HR values a manual edit of the department or job title replaced (PATCH /identity/:id), per
     * attribute and source: the policy profile's HR contracts take the edited value while the
     * source still sends that value (manual-contract-overrides.ts).
     */
    manualOverrides?: ManualOverrides;
    /**
     * Rehire: when an HR sync revived this soft-deleted identity, and the source it came from.
     * HR joiner detection records the rehire as a joiner (modules/joiners).
     */
    rehiredAt?: Date;
    rehiredFrom?: string;
  };
}

export const IdentitySchema = SchemaFactory.createForClass(Identity);

// Indexes for the Onion model (tenant-scoped)
// The email is unique among live identities only, so a new hire can take a former employee's
// address. `deletedAt: null` matches a missing deletedAt too ($exists: false is not allowed in a
// partial index). Existing databases get it from
// migrations/20261123000001-identity-email-unique-among-live.
IdentitySchema.index(
  { tenantId: 1, 'profile.email': 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
// The tenant's open correlation conflicts by match: correlation reads the open email conflicts
// before a mint (identity-email-case-conflict.ts). Existing databases get it from
// migrations/20261126000003-identity-open-conflict-index.
IdentitySchema.index(EMAIL_CONFLICT_INDEX_KEY, EMAIL_CONFLICT_INDEX_OPTIONS);
// The tenant's identities by HR employee id: an access review finds a manager named only by
// managerId (identity-employee-id.ts). Existing databases get it from
// migrations/20261126000004-identity-employee-id-index.
IdentitySchema.index(EMPLOYEE_ID_INDEX_KEY, EMPLOYEE_ID_INDEX_OPTIONS);
IdentitySchema.index({ tenantId: 1, 'profile.status': 1 });
IdentitySchema.index({ tenantId: 1, deletedAt: 1 });
IdentitySchema.index({ tenantId: 1, 'sources.sourceName': 1, 'sources.externalId': 1 });
IdentitySchema.index(
  { tenantId: 1, 'profile.correlationId': 1 },
  {
    unique: true,
    // $type, not $exists/$ne: MongoDB rejects $ne in a partial index and skips the index.
    // Existing databases get it from migrations/20261121000000-identity-correlation-id-unique-index.
    partialFilterExpression: { 'profile.correlationId': { $type: 'string' } },
  },
);
IdentitySchema.index({ 'provisioning.expiresAt': 1 }, { sparse: true });
IdentitySchema.index({ tenantId: 1, parentIdentityId: 1 }, { sparse: true });
