import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AdminUserDocument = AdminUser & Document;

/** The tenant roles an admin can hold, highest first. None of them is platform-admin. */
export const ADMIN_ROLES = [
  'super-admin',
  'connector-admin',
  'policy-admin',
  'operator',
  'viewer',
] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

@Schema({ timestamps: true, collection: 'admin_users' })
export class AdminUser {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email!: string;

  /**
   * argon2id hash (older ones bcrypt) of the admin's EuroID password. A single sign-on admin
   * (authSource 'saml') has none: it signs in through its identity provider only.
   */
  @Prop({
    type: String,
    required(this: AdminUser) {
      return this.authSource !== 'saml';
    },
  })
  passwordHash?: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ type: String, enum: ADMIN_ROLES, default: 'viewer' })
  role!: string;

  @Prop({ default: 'dev-tenant' })
  tenantId!: string;

  @Prop({ default: true })
  isActive!: boolean;

  @Prop({ type: Number, default: 0 })
  tokenVersion!: number;

  /** Last 5 password hashes (argon2id, older ones bcrypt) for reuse prevention. */
  @Prop({ type: [String], default: [] })
  passwordHistory!: string[];

  /** Opaque refresh token hash (SHA-256). Null when no active refresh session. */
  @Prop({ type: String })
  refreshTokenHash?: string;

  /** Refresh token expiry date. */
  @Prop({ type: Date })
  refreshTokenExpiresAt?: Date;

  /** Encrypted TOTP secret for MFA (via EncryptionService). */
  @Prop({ type: String })
  mfaSecret?: string;

  @Prop({ default: false })
  mfaEnabled!: boolean;

  /** Bcrypt hashes of single-use backup codes for MFA recovery. */
  @Prop({ type: [String], default: [] })
  mfaBackupCodes!: string[];

  /** The 30-second TOTP step of the last accepted code: that code and earlier ones are refused. */
  @Prop({ type: Number })
  mfaLastTotpStep?: number;

  /**
   * SHA-256 of the current password reset token (password-reset.service.ts), never the token.
   * Replaced by a newer token, removed by a reset or a password change.
   */
  @Prop({ type: String })
  passwordResetTokenHash?: string;

  /** When the current password reset token stops working. */
  @Prop({ type: Date })
  passwordResetExpiresAt?: Date;

  /** When a sign-in last issued this admin a session (password with its MFA step, or SAML). */
  @Prop({ type: Date })
  lastLoginAt?: Date;

  /** How the user was provisioned: local (email/password) or saml (SSO). */
  @Prop({ type: String, enum: ['local', 'saml'], default: 'local' })
  authSource!: string;
}

export const AdminUserSchema = SchemaFactory.createForClass(AdminUser);

// Exempt from tenant plugin — AdminUser lookup is by _id (user identity) before tenant context is set.
// JwtAuthGuard queries AdminUser before TenantContextInterceptor runs; tenant is derived from the user record.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose schema options do not expose custom keys; cast required for plugin bypass flag
AdminUserSchema.set('skipTenantPlugin' as any, true);
