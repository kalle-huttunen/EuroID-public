/**
 * MfaService — TOTP enrollment, validation, backup codes, and MFA pending tokens.
 *
 * The attempt counter (lockout after MFA_MAX_ATTEMPTS) lives in the security state store: when
 * it cannot be written, validateCode denies with 503 instead of skipping the lockout. A code
 * proves the second factor once: a used TOTP step and a used backup code are refused again.
 */

import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  InternalServerErrorException,
  HttpException,
  HttpStatus,
  Logger,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as OTPAuth from 'otpauth';
import * as QRCode from 'qrcode';
import * as bcrypt from 'bcryptjs';
import * as jose from 'jose';
import { randomBytes } from 'crypto';
import { AdminUser, AdminUserDocument } from './schemas/admin-user.schema';
import { EncryptionService } from '@infrastructure/secrets/encryption.service';
import {
  SECURITY_STATE_STORE,
  SecurityStateUnavailableError,
  type SecurityStateStore,
} from '@infrastructure/cache/security-state.store';

const BACKUP_CODE_COUNT = 10;
/** 10 characters of a 32-letter alphabet: 50 bits each. Codes made before 2026-11-25 have 8. */
const BACKUP_CODE_LENGTH = 10;
const BACKUP_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BCRYPT_BACKUP_ROUNDS = 10;
const MFA_MAX_ATTEMPTS = 5;
const MFA_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
/** A counter per admin (security state increment); a new key, so counters of the old format are left to expire. */
const MFA_ATTEMPTS_PREFIX = 'mfa:attempts:';
const TOTP_PERIOD_S = 30;

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    @InjectModel(AdminUser.name) private adminModel: Model<AdminUserDocument>,
    private config: ConfigService,
    private encryption: EncryptionService,
    @Inject(SECURITY_STATE_STORE) private readonly securityState: SecurityStateStore,
  ) {}

  async setupMfa(userId: string): Promise<{ qrCodeDataUrl: string; manualEntryKey: string }> {
    const user = await this.adminModel.findById(userId);
    if (!user) throw new BadRequestException('User not found');
    if (user.mfaEnabled) throw new BadRequestException('MFA is already enabled');

    const totp = new OTPAuth.TOTP({
      issuer: 'EuroID',
      label: user.email,
      algorithm: 'SHA256',
      digits: 6,
      period: 30,
      secret: new OTPAuth.Secret({ size: 20 }),
    });

    const encryptedSecret = this.encryption.encrypt(totp.secret.base32);
    await this.adminModel.updateOne(
      { _id: userId },
      { $set: { mfaSecret: encryptedSecret, mfaEnabled: false } },
    );

    const qrCodeDataUrl = await QRCode.toDataURL(totp.toString());

    return { qrCodeDataUrl, manualEntryKey: totp.secret.base32 };
  }

  async verifySetup(userId: string, code: string): Promise<{ backupCodes: string[] }> {
    const user = await this.adminModel.findById(userId);
    if (!user) throw new BadRequestException('User not found');
    if (user.mfaEnabled) throw new BadRequestException('MFA is already enabled');
    if (!user.mfaSecret)
      throw new BadRequestException('MFA setup not initiated. Call /mfa/setup first.');

    const secret = this.encryption.decrypt(user.mfaSecret);
    const totp = new OTPAuth.TOTP({
      issuer: 'EuroID',
      label: user.email,
      algorithm: 'SHA256',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });

    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) {
      throw new BadRequestException('Invalid verification code');
    }

    const { plainCodes, hashedCodes } = await this.generateBackupCodes();

    // The setup code is used: it cannot also pass the first sign-in's MFA step.
    const mfaLastTotpStep = Math.floor(Date.now() / 1000 / TOTP_PERIOD_S) + delta;
    await this.adminModel.updateOne(
      { _id: userId },
      { $set: { mfaEnabled: true, mfaBackupCodes: hashedCodes, mfaLastTotpStep } },
    );

    this.logger.log(`MFA enabled for user ${user._id.toString()}`);
    return { backupCodes: plainCodes };
  }

  /**
   * Whether `code` is a TOTP code or a backup code of the admin. Every attempt first takes one of
   * MFA_MAX_ATTEMPTS slots of the lockout window (an atomic increment), so parallel guesses get
   * no more code checks than the limit; past it the answer is 429 and nothing is read. A valid
   * code frees the slots. A TOTP code is accepted once (its step, and every earlier one, is
   * refused afterwards) and a backup code is used up, each by a conditional update, so of two
   * requests with one code only one passes.
   */
  async validateCode(userId: string, code: string): Promise<boolean> {
    const { count } = await this.securityState.increment(
      `${MFA_ATTEMPTS_PREFIX}${userId}`,
      MFA_LOCKOUT_MS,
    );
    if (count > MFA_MAX_ATTEMPTS) {
      throw new HttpException(
        'Too many MFA attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.adminModel.findById(userId);
    if (!user || !user.mfaEnabled || !user.mfaSecret) return false;

    // Try TOTP first (6-digit codes)
    if (/^\d{6}$/.test(code)) {
      const step = this.totpStepOf(user.email, this.encryption.decrypt(user.mfaSecret), code);
      if (step !== null && (await this.useTotpStep(userId, step))) {
        await this.clearAttempts(userId);
        return true;
      }
    }

    // Try a backup code: 8 characters (codes made before 2026-11-25) or 10, any case.
    const backupCode = code.trim().toUpperCase();
    if (backupCode.length === 8 || backupCode.length === 10) {
      const backupCodes = user.mfaBackupCodes ?? [];
      for (const hash of backupCodes) {
        if (!(await bcrypt.compare(backupCode, hash))) continue;
        // Used up only if it is still stored: a request that presented it at the same moment
        // and removed it first wins, this one fails.
        const used = await this.adminModel.updateOne(
          { _id: userId, mfaBackupCodes: hash },
          { $pull: { mfaBackupCodes: hash } },
        );
        if (used.matchedCount === 0) return false;
        this.logger.warn(
          `Backup code used by user ${user._id.toString()}. ${backupCodes.length - 1} remaining.`,
        );
        await this.clearAttempts(userId);
        return true;
      }
    }

    return false;
  }

  /** The TOTP step `code` belongs to (the current one or one before or after it), or null. */
  private totpStepOf(email: string, secret: string, code: string): number | null {
    const totp = new OTPAuth.TOTP({
      issuer: 'EuroID',
      label: email,
      algorithm: 'SHA256',
      digits: 6,
      period: TOTP_PERIOD_S,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const delta = totp.validate({ token: code, window: 1 });
    return delta === null ? null : Math.floor(Date.now() / 1000 / TOTP_PERIOD_S) + delta;
  }

  /** Records `step` as used unless it or a later step already was. False for a replayed code. */
  private async useTotpStep(userId: string, step: number): Promise<boolean> {
    const result = await this.adminModel.updateOne(
      {
        _id: userId,
        $or: [{ mfaLastTotpStep: { $exists: false } }, { mfaLastTotpStep: { $lt: step } }],
      },
      { $set: { mfaLastTotpStep: step } },
    );
    return result.matchedCount > 0;
  }

  /**
   * After a valid code. A counter the store fails to delete stays until it expires: that only
   * brings a later lockout sooner, so the valid code is not refused (the store logged the error).
   */
  private async clearAttempts(userId: string): Promise<void> {
    try {
      await this.securityState.del(`${MFA_ATTEMPTS_PREFIX}${userId}`);
    } catch (error: unknown) {
      if (!(error instanceof SecurityStateUnavailableError)) throw error;
    }
  }

  async issueMfaPendingToken(user: AdminUserDocument): Promise<string> {
    const secretVal = this.config.get('JWT_SECRET');
    if (!secretVal) throw new InternalServerErrorException('JWT_SECRET is not configured');

    const secret = new TextEncoder().encode(secretVal);
    return new jose.SignJWT({
      sub: user._id.toString(),
      email: user.email,
      tenantId: user.tenantId,
      mfaPending: true,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .setIssuer('euroid-mfa')
      .sign(secret);
  }

  async verifyMfaPendingToken(
    token: string,
  ): Promise<{ sub: string; email: string; tenantId: string }> {
    const secretVal = this.config.get('JWT_SECRET');
    if (!secretVal) throw new InternalServerErrorException('JWT_SECRET is not configured');

    const secret = new TextEncoder().encode(secretVal);
    try {
      const { payload } = await jose.jwtVerify(token, secret, {
        issuer: 'euroid-mfa',
      });
      if (!payload.mfaPending) throw new UnauthorizedException('Invalid MFA token');
      return {
        sub: payload.sub as string,
        email: payload.email as string,
        tenantId: payload.tenantId as string,
      };
    } catch (err: unknown) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('MFA token expired or invalid');
    }
  }

  async disableMfa(userId: string, code: string): Promise<void> {
    const valid = await this.validateCode(userId, code);
    if (!valid) throw new BadRequestException('Invalid verification code');

    await this.adminModel.updateOne(
      { _id: userId },
      { $set: { mfaEnabled: false, mfaBackupCodes: [] }, $unset: { mfaSecret: 1 } },
    );
    this.logger.log(`MFA disabled for user ${userId}`);
  }

  async regenerateBackupCodes(userId: string, code: string): Promise<{ backupCodes: string[] }> {
    const user = await this.adminModel.findById(userId);
    if (!user || !user.mfaEnabled) throw new BadRequestException('MFA is not enabled');

    const valid = await this.validateCode(userId, code);
    if (!valid) throw new BadRequestException('Invalid verification code');

    const { plainCodes, hashedCodes } = await this.generateBackupCodes();
    await this.adminModel.updateOne({ _id: userId }, { $set: { mfaBackupCodes: hashedCodes } });

    return { backupCodes: plainCodes };
  }

  async getMfaStatus(
    userId: string,
  ): Promise<{ mfaEnabled: boolean; backupCodesRemaining: number }> {
    const user = await this.adminModel.findById(userId);
    if (!user) throw new BadRequestException('User not found');
    return {
      mfaEnabled: user.mfaEnabled ?? false,
      backupCodesRemaining: (user.mfaBackupCodes ?? []).length,
    };
  }

  private async generateBackupCodes(): Promise<{ plainCodes: string[]; hashedCodes: string[] }> {
    const plainCodes: string[] = [];
    const hashedCodes: string[] = [];

    for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
      let code: string;
      do {
        // 256 is a multiple of 32, so each character is uniform.
        code = Array.from(
          randomBytes(BACKUP_CODE_LENGTH),
          (b) => BACKUP_CODE_ALPHABET[b & 31],
        ).join('');
      } while (plainCodes.includes(code));
      plainCodes.push(code);
      hashedCodes.push(await bcrypt.hash(code, BCRYPT_BACKUP_ROUNDS));
    }

    return { plainCodes, hashedCodes };
  }
}
