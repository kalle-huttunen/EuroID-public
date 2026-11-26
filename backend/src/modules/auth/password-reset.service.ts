import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import { type AuthConfig, authConfig } from '@infrastructure/config/auth.config';
import {
  SECURITY_STATE_STORE,
  type SecurityStateStore,
} from '@infrastructure/cache/security-state.store';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type {
  AdminUserPasswordResetCompletedPayload,
  AdminUserPasswordResetIssuedPayload,
  AdminUserPasswordResetRequestedPayload,
} from '@infrastructure/events/event-payloads';
import { PasswordResetMailService } from '../notifications/password-reset-mail.service';
import { AdminUser, AdminUserDocument } from './schemas/admin-user.schema';
import { assertNotRecentlyUsed, hashPassword, historyWith } from './password-hashing';

type ResetConfig = Pick<
  AuthConfig,
  | 'PASSWORD_RESET_TOKEN_TTL_MINUTES'
  | 'PASSWORD_RESET_MAX_PER_IP'
  | 'PASSWORD_RESET_MAX_PER_EMAIL'
  | 'PASSWORD_RESET_WINDOW_MINUTES'
>;

const INVALID_TOKEN = 'This reset link or code is invalid, used or expired. Ask for a new one.';

/** A local password account that can be reset: active and not single sign-on. */
const RESETTABLE = { isActive: { $ne: false }, authSource: { $ne: 'saml' } };

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Console admin password reset. A reset token is 32 random bytes (64 hex characters) that the
 * admin receives by email (self-service, when SMTP is on) or from a super-admin (a one-time code).
 * Only its SHA-256 is stored, with its expiry, on the admin: a newer token replaces it, and a
 * reset or a password change removes it. Redeeming it sets the password with the same rules as
 * change-password, ends every session (token version, refresh token) and never signs anyone in or
 * touches MFA. The public routes are rate limited per IP and per address in the shared security
 * state store, which fails closed (503).
 */
@Injectable()
export class PasswordResetService implements OnApplicationShutdown {
  private readonly logger = new Logger(PasswordResetService.name);
  /** Requests whose lookup and mail run after the answer was sent. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @InjectModel(AdminUser.name) private readonly adminModel: Model<AdminUserDocument>,
    @Inject(authConfig.KEY) private readonly conf: ResetConfig,
    @Inject(SECURITY_STATE_STORE) private readonly securityState: SecurityStateStore,
    private readonly mail: PasswordResetMailService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  get tokenTtlMinutes(): number {
    return this.conf.PASSWORD_RESET_TOKEN_TTL_MINUTES;
  }

  /** Whether an admin can get a reset link by email (SMTP is configured). */
  get byEmail(): boolean {
    return this.mail.isEnabled();
  }

  /**
   * Self-service request. Only the rate limits run before the answer, and they are the same for
   * every address, so the answer and its timing say nothing about whether the address has an
   * account; the lookup, the token and the mail run afterwards (drain() waits for them).
   */
  async request(email: string, ip: string): Promise<void> {
    await this.limit(`pwreset:ip:${ip}`, this.conf.PASSWORD_RESET_MAX_PER_IP);
    await this.limit(`pwreset:email:${hashToken(email)}`, this.conf.PASSWORD_RESET_MAX_PER_EMAIL);
    const job = this.mailResetLink(email).finally(() => this.inFlight.delete(job));
    this.inFlight.add(job);
  }

  /** A one-time code for an admin the caller checked (tenant, platform admin, SSO, active). */
  async issue(
    userId: string,
    tenantId: string,
    issuedBy: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const { token, expiresAt } = await this.storeToken(userId);
    const payload: AdminUserPasswordResetIssuedPayload = {
      adminUserId: userId,
      issuedBy,
      expiresAt: expiresAt.toISOString(),
    };
    this.eventEmitter.emit(DomainEventType.ADMIN_USER_PASSWORD_RESET_ISSUED, userId, payload, {
      tenantId,
    });
    return { token, expiresAt };
  }

  /**
   * Redeem a token: the new password replaces the old one and every session ends. An unknown,
   * used or expired token, or one whose account was deactivated or is single sign-on, is 400 with
   * the same message. A password that breaks the history rule is 400 and leaves the token usable.
   */
  async confirm(token: string, newPassword: string, ip: string): Promise<void> {
    await this.limit(`pwreset:confirm:ip:${ip}`, this.conf.PASSWORD_RESET_MAX_PER_IP);
    const tokenHash = hashToken(token);
    const valid = {
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { $gt: new Date() },
    };
    const admin = await this.adminModel.findOne(
      { ...valid, ...RESETTABLE },
      'tenantId passwordHistory',
    );
    if (!admin) throw new BadRequestException(INVALID_TOKEN);

    const history = admin.passwordHistory ?? [];
    await assertNotRecentlyUsed(newPassword, history);
    const passwordHash = await hashPassword(newPassword);
    // Conditional on the token, so of two redemptions racing for it only one sets a password.
    const result = await this.adminModel.updateOne(
      { _id: admin._id, ...valid, ...RESETTABLE },
      {
        $set: { passwordHash, passwordHistory: historyWith(passwordHash, history) },
        $inc: { tokenVersion: 1 },
        $unset: {
          refreshTokenHash: 1,
          refreshTokenExpiresAt: 1,
          passwordResetTokenHash: 1,
          passwordResetExpiresAt: 1,
        },
      },
    );
    if (result.matchedCount === 0) throw new BadRequestException(INVALID_TOKEN);

    const adminUserId = admin._id.toString();
    const payload: AdminUserPasswordResetCompletedPayload = { adminUserId };
    this.eventEmitter.emit(
      DomainEventType.ADMIN_USER_PASSWORD_RESET_COMPLETED,
      adminUserId,
      payload,
      {
        tenantId: admin.tenantId,
        actor: 'anonymous',
      },
    );
  }

  /** Wait for the requests still being processed (app.close() and tests). */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  onApplicationShutdown(): Promise<void> {
    return this.drain();
  }

  /** After the answer: token and mail for a resettable account while email is on. Never throws. */
  private async mailResetLink(email: string): Promise<void> {
    try {
      if (!this.mail.isEnabled()) return;
      const admin = await this.adminModel.findOne({ email, ...RESETTABLE }, 'email tenantId');
      if (!admin) return;
      const { token } = await this.storeToken(admin._id.toString());
      const sent = await this.mail.send(admin.email, token, this.tokenTtlMinutes);
      const adminUserId = admin._id.toString();
      const payload: AdminUserPasswordResetRequestedPayload = {
        adminUserId,
        mailSent: sent === 'sent',
      };
      this.eventEmitter.emit(
        DomainEventType.ADMIN_USER_PASSWORD_RESET_REQUESTED,
        adminUserId,
        payload,
        { tenantId: admin.tenantId, actor: 'anonymous' },
      );
    } catch (error: unknown) {
      // Neither the address nor a token is logged.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Password reset request not processed: ${message}`);
    }
  }

  /** A new token for the admin: its hash replaces any earlier one, so that one is void. */
  private async storeToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + this.tokenTtlMinutes * 60 * 1000);
    await this.adminModel.updateOne(
      { _id: userId },
      { $set: { passwordResetTokenHash: hashToken(token), passwordResetExpiresAt: expiresAt } },
    );
    return { token, expiresAt };
  }

  /** One more attempt on `key` in the window; 429 above `max`. A store failure rejects (503). */
  private async limit(key: string, max: number): Promise<void> {
    const windowMs = this.conf.PASSWORD_RESET_WINDOW_MINUTES * 60 * 1000;
    const { count, ttlMs } = await this.securityState.increment(key, windowMs);
    if (count > max) {
      const minutes = Math.max(1, Math.ceil(ttlMs / 60_000));
      throw new HttpException(
        `Too many password reset attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
