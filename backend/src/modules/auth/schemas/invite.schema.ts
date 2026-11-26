import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type InviteDocument = Invite & Document;

@Schema({ timestamps: true, collection: 'invites' })
export class Invite {
  @Prop({ required: true, lowercase: true, trim: true })
  email!: string;

  /** SHA-256 hash of invite token (plain token never stored). Legacy: token field supported during migration. */
  @Prop({ required: true })
  tokenHash!: string;

  /** @deprecated Legacy plaintext token; migrated to tokenHash on consume. Do not use for new invites. */
  @Prop()
  token!: string;

  @Prop({ type: [String], default: ['viewer'] })
  roles!: string[];

  /**
   * The inviter's id as their token names it (`sub`): an admin_users id for a password or SAML
   * sign-in, the identity provider's subject for OIDC, `emergency-admin` for the emergency
   * account. Not every inviter has an admin_users row, so this is text, not a reference. Invites
   * created before this held an ObjectId.
   */
  @Prop({ type: String, required: true })
  createdBy!: string;

  @Prop({ type: Date })
  usedAt!: Date;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop({ default: 'dev-tenant' })
  tenantId!: string;
}

export const InviteSchema = SchemaFactory.createForClass(Invite);
InviteSchema.index({ tokenHash: 1 }, { unique: true });
InviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
