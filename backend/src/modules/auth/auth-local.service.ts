import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as jose from 'jose';
import { randomBytes, createHash } from 'crypto';
import {
  assertNotRecentlyUsed,
  hashPassword,
  historyWith,
  isLegacyBcryptHash,
  verifyPassword,
} from './password-hashing';
import { AdminUser, AdminUserDocument } from './schemas/admin-user.schema';
import { Tenant, TenantDocument } from '@infrastructure/multi-tenancy/schemas/tenant.schema';
import {
  TENANT_INACTIVE_MESSAGE,
  tenantAllowsUse,
} from '@infrastructure/multi-tenancy/tenant-status.service';
import { parsePlatformAdminIds } from '@infrastructure/auth/platform-admin';
import { LoginDto } from './dtos/login.dto';
import { RegisterDto } from './dtos/register.dto';
import { MachineIdentitySyncService } from '../identity/machine-identity-sync.service';
import { MfaService } from './mfa.service';
import { InviteService } from './invite.service';
import { assertFirstAdminSetupAllowed } from './first-admin-setup';
import {
  SECURITY_STATE_STORE,
  SecurityStateUnavailableError,
  type SecurityStateStore,
} from '@infrastructure/cache/security-state.store';

export interface AdminUserSafe {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string;
}

/**
 * What a sign-in answers (completeSignIn): the MFA step (`mfa_required`, `mfa_token`), a token
 * that can only set up MFA (`mfa_enrollment_required`, `mfa_enrollment_token`), or a session.
 */
export type SignInResult = {
  mfa_required?: boolean;
  mfa_token?: string;
  mfa_enrollment_required?: boolean;
  message?: string;
  mfa_enrollment_token?: string;
  access_token?: string;
  refresh_token?: string;
  user?: AdminUserSafe;
};

/** One admin in GET /auth/users: nothing that signs anyone in or proves a second factor. */
export interface AdminUserListItem {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  mfaEnabled: boolean;
  authSource: string;
  isPlatformAdmin: boolean;
  createdAt?: Date;
  /** When a sign-in last issued the admin a session; null if none has since this was recorded. */
  lastLoginAt: Date | null;
}

/** An admin who can run the deployment; first-admin setup is open while there is none. */
const ACTIVE_SUPER_ADMIN = { role: 'super-admin', isActive: true };

/** The only admin fields the list reads (password, MFA, session and token fields never). */
const ADMIN_LIST_FIELDS = 'email name role isActive mfaEnabled authSource createdAt lastLoginAt';

/**
 * Local email/password authentication for EuroID administrators.
 * Stores admin users in admin_users collection; separate from Identity Hub.
 */
@Injectable()
export class AuthLocalService {
  private readonly logger = new Logger(AuthLocalService.name);

  constructor(
    @InjectModel(AdminUser.name) private adminModel: Model<AdminUserDocument>,
    @InjectModel(Tenant.name) private tenantModel: Model<TenantDocument>,
    private config: ConfigService,
    private machineIdentitySync: MachineIdentitySyncService,
    private mfaService: MfaService,
    private inviteService: InviteService,
    @Inject(SECURITY_STATE_STORE) private readonly securityState: SecurityStateStore,
  ) {}

  async register(dto: RegisterDto): Promise<{ user: AdminUserSafe }> {
    // TenantId derived server-side only — never from user input
    const tenantId = this.config.get('DEFAULT_TENANT_ID') || 'dev-tenant';

    // First-admin setup stays open until an active super-admin exists: a viewer that SAML JIT
    // created (it never grants super-admin) or a deactivated super-admin does not close it, or
    // nobody could ever invite an admin
    const activeSuperAdmins = await this.adminModel.countDocuments(ACTIVE_SUPER_ADMIN);
    if (activeSuperAdmins === 0) {
      // First-user setup: SETUP_TOKEN, or development and test only (first-admin-setup.ts)
      assertFirstAdminSetupAllowed({
        setupToken: this.config.get<string>('SETUP_TOKEN'),
        nodeEnv: this.config.get<string>('NODE_ENV'),
        provided: dto.inviteToken,
      });
      // Atomic upsert to prevent TOCTOU race: inserts only while no active super-admin exists
      const passwordHash = await hashPassword(dto.password);
      const result = await this.adminModel
        .findOneAndUpdate(
          ACTIVE_SUPER_ADMIN,
          {
            $setOnInsert: {
              email: dto.email,
              passwordHash,
              name: dto.name,
              role: 'super-admin',
              passwordHistory: [passwordHash],
              tenantId,
              isActive: true,
            },
          },
          { upsert: true, new: true },
        )
        .catch((err: unknown) => {
          // The address is an admin account already (a JIT-created viewer, a deactivated admin)
          if ((err as { code?: unknown } | null)?.code === 11000) {
            throw new ConflictException(
              'This email address already has an admin account. Register with another address.',
            );
          }
          throw err;
        });
      // The schema lowercases the stored address; another address means another admin won.
      if (result.email !== dto.email.trim().toLowerCase()) {
        throw new ConflictException('An administrator account already exists');
      }
      await this.machineIdentitySync.syncAdminToIdentity(result).catch((err) => {
        this.logger.error(
          `syncAdminToIdentity failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return { user: this.sanitize(result) };
    }

    if (!dto.inviteToken?.trim()) {
      throw new ForbiddenException('Registration requires an invite. Contact your administrator.');
    }
    // The invite is used up only if the admin is created: a bad token (401), a wrong email (400)
    // or a failed create leaves it as it was. The password is hashed only for a valid invite.
    const user = await this.inviteService.redeemInvite(
      dto.inviteToken,
      dto.email,
      async (invite) => {
        // Checked only for the holder of a valid invite for this address, so the public route
        // tells nobody else which addresses have an account. Also an invite for an address that
        // has an account in another tenant: the inviter is not told (that would reveal another
        // tenant's accounts), the invitee is, and the invite stays (redeemInvite releases it).
        if (await this.adminModel.exists({ email: invite.email })) {
          throw new ConflictException(
            'This email address already has an admin account. Sign in with it instead.',
          );
        }
        const passwordHash = await hashPassword(dto.password);
        return this.adminModel.create({
          email: dto.email,
          passwordHash,
          name: dto.name,
          role: invite.roles[0] || 'viewer',
          passwordHistory: [passwordHash],
          // The inviting tenant, from the stored (server-issued) invite; never from the request.
          tenantId: invite.tenantId,
        });
      },
    );

    await this.machineIdentitySync.syncAdminToIdentity(user).catch((err) => {
      this.logger.error(
        `syncAdminToIdentity failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    return { user: this.sanitize(user) };
  }

  /** `clientIp`: the request's client address (request.ip), which the lockout counts with. */
  async login(dto: LoginDto, clientIp = 'unknown'): Promise<SignInResult> {
    const lockoutKey = await this.takeLoginAttempt(dto.email, clientIp);
    const result = await this.checkPassword(dto);
    // Only a correct password frees the account's attempts (the MFA step counts its own).
    try {
      await this.securityState.del(lockoutKey);
    } catch (error: unknown) {
      if (!(error instanceof SecurityStateUnavailableError)) throw error;
    }
    return result;
  }

  /**
   * One sign-in attempt of the account `email` from `clientIp`, taken before any password is
   * checked: an atomic increment per address and client IP (hashed, so the store holds neither)
   * in a window of LOGIN_LOCKOUT_MINUTES. Past LOGIN_MAX_FAILURES_PER_ACCOUNT the answer is 429
   * until the window ends, for an unknown address the same as for an account, so it tells nothing
   * about accounts. Counting per client too means a third party guessing from its own address
   * cannot lock the account out for its owner, who signs in from another; the per-IP throttle
   * (AUTH_THROTTLE_*) still bounds guesses spread over many addresses from one client.
   */
  private async takeLoginAttempt(email: string, clientIp: string): Promise<string> {
    const max = this.config.get<number>('auth.LOGIN_MAX_FAILURES_PER_ACCOUNT') ?? 10;
    const minutes = this.config.get<number>('auth.LOGIN_LOCKOUT_MINUTES') ?? 15;
    const subject = `${email.trim().toLowerCase()}|${clientIp}`;
    const key = `login:failures:${createHash('sha256').update(subject).digest('hex')}`;
    const { count } = await this.securityState.increment(key, minutes * 60_000);
    if (count > max) {
      if (count === max + 1)
        this.logger.warn(`Sign-in locked for an account after ${max} failures`);
      throw new HttpException(
        'Too many failed sign-ins for this account. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return key;
  }

  private async checkPassword(dto: LoginDto): Promise<SignInResult> {
    const user = await this.adminModel.findOne({ email: dto.email, isActive: true });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    // A single sign-on admin has no EuroID password: refused before anything is compared.
    if (user.authSource === 'saml') {
      throw new UnauthorizedException(
        "This account uses SSO. Please sign in with your organization's identity provider.",
      );
    }
    const passwordHash = user.passwordHash;
    if (!passwordHash) throw new UnauthorizedException('Invalid credentials');

    const valid = await verifyPassword(dto.password, passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    if (isLegacyBcryptHash(passwordHash)) {
      const rehashed = await hashPassword(dto.password);
      await this.adminModel.updateOne({ _id: user._id }, { $set: { passwordHash: rehashed } });
      user.passwordHash = rehashed;
    }

    return this.completeSignIn(user);
  }

  /**
   * The step every sign-in ends with, a password and a SAML sign-in alike: an admin with MFA gets
   * the MFA step (POST /auth/mfa/challenge), an admin without MFA in a tenant that requires it
   * gets a 5-minute token that can only set up MFA, and anyone else gets a session.
   */
  async completeSignIn(user: AdminUserDocument): Promise<SignInResult> {
    const tenant = await this.tenantForSignIn(user);

    // MFA enabled: return pending token instead of access token
    if (user.mfaEnabled) {
      const mfaToken = await this.mfaService.issueMfaPendingToken(user);
      return { mfa_required: true, mfa_token: mfaToken };
    }

    // Check tenant MFA policy
    if (tenant?.settings?.mfaRequired) {
      // Issue a scoped MFA-enrollment-only token (not a full access token)
      const mfaEnrollmentToken = await this.signScopedJwt(user, 'mfa-enrollment', '5m');
      return {
        mfa_enrollment_required: true,
        message: 'MFA is required by your organization. Please set up MFA to continue.',
        mfa_enrollment_token: mfaEnrollmentToken,
        user: this.sanitize(user),
      };
    }

    const tokens = await this.issueTokenPair(user);
    return { ...tokens, user: this.sanitize(user) };
  }

  /**
   * A new token pair for a valid refresh token, which is used up. One refresh token per admin: a
   * sign-in on another browser or device replaces it, and the first one's next refresh answers
   * 401 (it signs in again).
   */
  async refresh(refreshToken: string): Promise<{ access_token: string; refresh_token: string }> {
    const hash = createHash('sha256').update(refreshToken).digest('hex');
    const user = await this.adminModel.findOne({
      refreshTokenHash: hash,
      isActive: true,
    });

    if (!user) throw new UnauthorizedException('Invalid refresh token');

    if (user.refreshTokenExpiresAt && new Date() > user.refreshTokenExpiresAt) {
      await this.adminModel.updateOne(
        { _id: user._id },
        { $unset: { refreshTokenHash: 1, refreshTokenExpiresAt: 1 } },
      );
      throw new UnauthorizedException('Refresh token expired');
    }
    await this.tenantForSignIn(user);

    const accessToken = await this.signJwt(user);
    const newRefresh = this.generateRefreshToken();

    // The rotation is the claim: only while the presented token is still the stored one, so of
    // two refreshes with one token (a stolen copy racing its owner) only one gets a session.
    const rotated = await this.adminModel.updateOne(
      { _id: user._id, refreshTokenHash: hash },
      { $set: { refreshTokenHash: newRefresh.hash, refreshTokenExpiresAt: newRefresh.expiresAt } },
    );
    if (rotated.matchedCount === 0) throw new UnauthorizedException('Invalid refresh token');

    return { access_token: accessToken, refresh_token: newRefresh.token };
  }

  /**
   * Sign-out: the refresh token stops working. An unknown or already replaced token changes
   * nothing, so a sign-out with an old token never ends the admin's current session. The access
   * token is not revoked: it ends at JWT_EXPIRY, and the browser drops its cookie.
   */
  async revokeRefreshToken(refreshToken: string): Promise<void> {
    const hash = createHash('sha256').update(refreshToken).digest('hex');
    await this.adminModel.updateOne(
      { refreshTokenHash: hash },
      { $unset: { refreshTokenHash: 1, refreshTokenExpiresAt: 1 } },
    );
  }

  /**
   * `hasAdminUsers`: whether first-admin setup is closed, that is, an active super-admin exists
   * (register). False while only viewers that SAML JIT created, or deactivated admins, exist, so
   * the sign-in page offers the setup.
   */
  async getSetupStatus(): Promise<{ hasAdminUsers: boolean }> {
    const count = await this.adminModel.countDocuments(ACTIVE_SUPER_ADMIN);
    return { hasAdminUsers: count > 0 };
  }

  /**
   * Revoke every session of an admin of `tenantId`. AdminUser is not tenant-scoped by the
   * plugin, so the tenant filter here keeps a tenant super-admin inside its own tenant.
   * False when no admin of that tenant has this id. JwtAuthGuard reads tokenVersion from the
   * database on every request, so the old tokens are refused from the next request on.
   */
  async revokeAllSessions(userId: string, tenantId: string): Promise<boolean> {
    const result = await this.adminModel.updateOne(
      { _id: userId, tenantId },
      { $inc: { tokenVersion: 1 }, $unset: { refreshTokenHash: 1, refreshTokenExpiresAt: 1 } },
    );
    return result.matchedCount > 0;
  }

  /**
   * The admins of `tenantId`, sorted by email. AdminUser is not tenant-scoped by the plugin, so
   * the filter keeps a tenant super-admin inside its own tenant. `platformAdminIds` marks the
   * accounts a tenant role must not act on.
   */
  async listAdmins(
    tenantId: string,
    platformAdminIds: ReadonlySet<string>,
  ): Promise<AdminUserListItem[]> {
    const admins = await this.adminModel
      .find({ tenantId }, ADMIN_LIST_FIELDS)
      .sort({ email: 1 })
      .lean<Array<Partial<AdminUser> & { _id: unknown; createdAt?: Date }>>();
    return admins.map((admin) => ({
      id: String(admin._id),
      email: admin.email ?? '',
      name: admin.name ?? '',
      role: admin.role ?? 'viewer',
      isActive: admin.isActive !== false,
      mfaEnabled: admin.mfaEnabled === true,
      authSource: admin.authSource ?? 'local',
      isPlatformAdmin: platformAdminIds.has(String(admin._id)),
      createdAt: admin.createdAt,
      lastLoginAt: admin.lastLoginAt ?? null,
    }));
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.adminModel.findById(userId);
    if (!user) throw new UnauthorizedException('User not found');
    if (user.authSource === 'saml' || !user.passwordHash) {
      throw new ConflictException(
        'This account signs in through single sign-on and has no EuroID password to change.',
      );
    }
    const valid = await verifyPassword(currentPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid current password');

    const history: string[] = user.passwordHistory ?? [];
    await assertNotRecentlyUsed(newPassword, history);

    const passwordHash = await hashPassword(newPassword);

    // Every session ends, and an unused password reset token stops working.
    await this.adminModel.updateOne(
      { _id: userId },
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
  }

  /** Issue full token pair for a user by ID. Used by the MFA challenge. */
  async issueTokensForUser(
    userId: string,
  ): Promise<{ access_token: string; refresh_token: string; user: AdminUserSafe }> {
    const user = await this.adminModel.findOne({ _id: userId, isActive: true });
    if (!user) throw new UnauthorizedException('User not found or inactive');
    await this.tenantForSignIn(user);
    const tokens = await this.issueTokenPair(user);
    return { ...tokens, user: this.sanitize(user) };
  }

  /**
   * The admin's tenants document, or 403 when the tenant may not use EuroID (suspended or
   * deprovisioned; a tenant without a document is active). Every session starts or continues
   * through it: completeSignIn (password and SAML), the MFA step and refresh. A platform admin
   * (PLATFORM_ADMIN_USER_IDS) passes, so a suspended tenant of theirs never locks out tenant
   * management.
   */
  private async tenantForSignIn(user: AdminUserDocument): Promise<TenantDocument | null> {
    const tenant = await this.tenantModel.findOne({ tenantId: user.tenantId });
    const platformAdminIds = parsePlatformAdminIds(this.config.get('PLATFORM_ADMIN_USER_IDS'));
    if (!tenantAllowsUse(tenant) && !platformAdminIds.has(user._id.toString())) {
      throw new ForbiddenException(TENANT_INACTIVE_MESSAGE);
    }
    return tenant;
  }

  /** A completed sign-in (password with its MFA step, or SAML): a new session, and its time. */
  private async issueTokenPair(
    user: AdminUserDocument,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const accessToken = await this.signJwt(user);
    const { token: refreshToken, hash, expiresAt } = this.generateRefreshToken();
    await this.adminModel.updateOne(
      { _id: user._id },
      {
        $set: { refreshTokenHash: hash, refreshTokenExpiresAt: expiresAt, lastLoginAt: new Date() },
      },
    );
    return { access_token: accessToken, refresh_token: refreshToken };
  }

  private async signJwt(user: AdminUserDocument): Promise<string> {
    const secretVal = this.config.get('JWT_SECRET');
    if (!secretVal) {
      throw new InternalServerErrorException(
        'JWT_SECRET is not configured. Set it in .env when using local auth.',
      );
    }
    const expiry = this.config.get('JWT_EXPIRY') || '1h';
    const audience = this.config.get<string>('JWT_AUDIENCE') || 'euroid-api';
    const secret = new TextEncoder().encode(secretVal);
    return new jose.SignJWT({
      sub: user._id.toString(),
      email: user.email,
      name: user.name,
      roles: [user.role],
      tenantId: user.tenantId,
      tokenVersion: user.tokenVersion ?? 0,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(expiry)
      .setIssuer('euroid-local')
      .setAudience(audience)
      .sign(secret);
  }

  /**
   * Sign a scoped JWT with restricted permissions. Used for MFA enrollment flow
   * where the user has not yet completed MFA setup — the token only permits
   * calls to /mfa/setup and /mfa/verify endpoints.
   */
  private async signScopedJwt(
    user: AdminUserDocument,
    scope: string,
    expiry: string,
  ): Promise<string> {
    const secretVal = this.config.get('JWT_SECRET');
    if (!secretVal) {
      throw new InternalServerErrorException(
        'JWT_SECRET is not configured. Set it in .env when using local auth.',
      );
    }
    const audience = this.config.get<string>('JWT_AUDIENCE') || 'euroid-api';
    const secret = new TextEncoder().encode(secretVal);
    return new jose.SignJWT({
      sub: user._id.toString(),
      email: user.email,
      name: user.name,
      roles: [], // No roles — scoped token cannot access normal endpoints
      tenantId: user.tenantId,
      scope, // 'mfa-enrollment' — checked by MFA controller
      tokenVersion: user.tokenVersion ?? 0,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(expiry)
      .setIssuer('euroid-local')
      .setAudience(audience)
      .sign(secret);
  }

  private generateRefreshToken(): { token: string; hash: string; expiresAt: Date } {
    const token = randomBytes(48).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    const daysStr = this.config.get('REFRESH_TOKEN_EXPIRY_DAYS') || '7';
    const days = parseInt(daysStr, 10) || 7;
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return { token, hash, expiresAt };
  }

  private sanitize(user: AdminUserDocument): AdminUserSafe {
    return {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
    };
  }
}
