/**
 * Credential Inventory Schema
 *
 * Tracks credential state per identity per target system.
 * Sub-documents: password expiry/status, MFA enrollment, passkeys, certificates.
 * Written by the nightly credential rotation run, which reads each SYNCED Entra ID and AD account
 * (activities/credential-inventory-refresh.ts); read by the credential lifecycle API.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

// ── Sub-schemas ──────────────────────────────────────────────────────────

export type PasswordStatus = 'COMPLIANT' | 'EXPIRING_SOON' | 'EXPIRED' | 'UNKNOWN';

@Schema({ _id: false })
export class PasswordState {
  @Prop({ type: Date })
  lastRotated?: Date;

  @Prop({ type: Date })
  nextRotation?: Date;

  @Prop({
    type: String,
    enum: ['COMPLIANT', 'EXPIRING_SOON', 'EXPIRED', 'UNKNOWN'],
    default: 'UNKNOWN',
  })
  status!: PasswordStatus;

  @Prop({ type: Number, default: 0 })
  rotationCount?: number;

  /** Why the status is UNKNOWN (not configured, not readable, no policy, no date); else absent. */
  @Prop({ type: String })
  statusReason?: string;
}

export const PasswordStateSchema = SchemaFactory.createForClass(PasswordState);

@Schema({ _id: false })
export class MfaState {
  @Prop({ type: Boolean, default: false })
  enrolled!: boolean;

  @Prop({ type: [String], default: [] })
  methods!: string[];

  @Prop({ type: Date })
  lastVerified?: Date;
}

export const MfaStateSchema = SchemaFactory.createForClass(MfaState);

@Schema({ _id: false })
export class PasskeyState {
  @Prop({ type: Number, default: 0 })
  count!: number;

  @Prop({ type: [String], default: [] })
  devices!: string[];

  @Prop({ type: Date })
  lastUsed?: Date;
}

export const PasskeyStateSchema = SchemaFactory.createForClass(PasskeyState);

export type CertificateStatus = 'ACTIVE' | 'EXPIRING_SOON' | 'EXPIRED' | 'REVOKED';

@Schema({ _id: false })
export class CertificateEntry {
  @Prop({ required: true })
  thumbprint!: string;

  @Prop({ type: Date })
  notBefore?: Date;

  @Prop({ type: Date })
  notAfter?: Date;

  @Prop({
    type: String,
    enum: ['ACTIVE', 'EXPIRING_SOON', 'EXPIRED', 'REVOKED'],
    default: 'ACTIVE',
  })
  status!: CertificateStatus;
}

export const CertificateEntrySchema = SchemaFactory.createForClass(CertificateEntry);

// ── Main schema ──────────────────────────────────────────────────────────

@Schema({ timestamps: true, collection: 'credential_inventory' })
export class CredentialInventory {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, index: true })
  identityId!: string;

  @Prop({ required: true })
  targetSystem!: string;

  @Prop({ required: true })
  externalId!: string;

  @Prop({ type: PasswordStateSchema })
  password?: PasswordState;

  @Prop({ type: MfaStateSchema })
  mfa?: MfaState;

  @Prop({ type: PasskeyStateSchema })
  passkeys?: PasskeyState;

  @Prop({ type: [CertificateEntrySchema], default: [] })
  certificates!: CertificateEntry[];

  /** When the nightly run last read this account from the target (CredentialInventoryRefresh). */
  @Prop({ type: Date })
  observedAt?: Date;

  /**
   * When the nightly run last reported this credential as due (credential.expiring_soon); each
   * run reports the ones reported longest ago, or never, first. Absent until first reported.
   */
  @Prop({ type: Date })
  dueReportedAt?: Date;
}

export type CredentialInventoryDocument = HydratedDocument<CredentialInventory>;
export const CredentialInventorySchema = SchemaFactory.createForClass(CredentialInventory);

CredentialInventorySchema.index({ tenantId: 1, identityId: 1, targetSystem: 1 }, { unique: true });
CredentialInventorySchema.index({ tenantId: 1, 'password.nextRotation': 1 }, { sparse: true });
CredentialInventorySchema.index({ tenantId: 1, 'password.status': 1 });
