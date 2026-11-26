import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ScimTokenDocument = HydratedDocument<ScimToken>;

@Schema({ collection: 'scim_tokens', timestamps: true })
export class ScimToken {
  @Prop({ required: true, index: true })
  tenantId!: string;

  /** SHA-256 hash of the bearer token — NEVER store plaintext */
  @Prop({ required: true, unique: true })
  tokenHash!: string;

  /** Human-readable label (e.g., "Workday SCIM", "Okta Inbound") */
  @Prop({ required: true })
  name!: string;

  /** Who generated this token (admin user ID) */
  @Prop({ required: true })
  createdBy!: string;

  /** When the token was last used for a successful auth */
  @Prop()
  lastUsedAt?: Date;

  /** Optional expiration date */
  @Prop()
  expiresAt?: Date;

  /** Token status */
  @Prop({ required: true, enum: ['active', 'revoked'], default: 'active' })
  status!: 'active' | 'revoked';

  /**
   * Scopes: which SCIM operations are allowed.
   * Values: 'Users:read', 'Users:write', 'Groups:read', 'Groups:write'
   */
  @Prop({
    type: [String],
    default: ['Users:read', 'Users:write', 'Groups:read', 'Groups:write'],
  })
  scopes!: string[];
}

export const ScimTokenSchema = SchemaFactory.createForClass(ScimToken);
