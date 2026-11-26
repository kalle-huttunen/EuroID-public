/**
 * Consent Schema (GDPR Article 6 — Lawfulness of Processing)
 *
 * Tracks per-identity, per-purpose processing consent.
 * Each record represents one consent grant or revocation.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ConsentStatus = 'granted' | 'revoked' | 'expired';

export type ConsentDocument = HydratedDocument<Consent>;

@Schema({ timestamps: true, collection: 'consents' })
export class Consent {
  @Prop({ required: true, index: true })
  identityId!: string;

  @Prop({ required: true })
  purpose!: string; // e.g., 'data_processing', 'analytics', 'marketing', 'provisioning_to_entra'

  @Prop({ required: true, enum: ['granted', 'revoked', 'expired'] })
  status!: ConsentStatus;

  @Prop()
  grantedAt!: Date;

  @Prop()
  revokedAt!: Date;

  @Prop({ required: true })
  grantedBy!: string; // actor who recorded consent

  @Prop()
  method!: string; // 'web-form', 'api', 'email', 'contract'

  @Prop()
  expiresAt!: Date; // past it the consent reads `expired` (ConsentService marks it on each read)

  @Prop({ required: true, index: true })
  tenantId!: string;
}

export const ConsentSchema = SchemaFactory.createForClass(Consent);

// One record per identity and purpose: a grant upserts it, so two grants at once must not make two
// (migration 20261126000001 removed the duplicates and made the index unique)
ConsentSchema.index({ tenantId: 1, identityId: 1, purpose: 1 }, { unique: true });
ConsentSchema.index({ tenantId: 1, status: 1 });
ConsentSchema.index({ expiresAt: 1 }, { sparse: true });
