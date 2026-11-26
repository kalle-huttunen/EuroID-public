import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import {
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  HttpStatus,
} from '@nestjs/common';
import {
  MemorySecurityStateStore,
  SECURITY_STATE_STORE,
} from '@infrastructure/cache/security-state.store';
import * as bcrypt from 'bcryptjs';
import * as argon2 from 'argon2';
import { createHash } from 'crypto';
import { AuthLocalService } from './auth-local.service';
import { AdminUser, AdminUserDocument } from './schemas/admin-user.schema';
import { Tenant } from '@infrastructure/multi-tenancy/schemas/tenant.schema';
import { MachineIdentitySyncService } from '../identity/machine-identity-sync.service';
import { MfaService } from './mfa.service';
import { InviteService } from './invite.service';

/** Minimum 12 chars, upper, lower, digit, special — satisfies STRONG_PASSWORD_SCHEMA */
const VALID_PASSWORD = 'ValidPass1!xx';
const VALID_PASSWORD_ALT = 'AnotherPass2@x';

const JWT_SECRET = 'test-jwt-secret-thats-at-least-32chars-long';
const JWT_EXPIRY = '1h';

/**
 * Build a realistic AdminUserDocument shape for testing.
 * Uses real bcrypt hashes so password comparison tests are accurate.
 */
async function createMockAdminUser(
  overrides: Partial<Record<string, unknown>> = {},
): Promise<AdminUserDocument> {
  const passwordHash = await bcrypt.hash(VALID_PASSWORD, 12);
  return {
    _id: { toString: () => 'user-id-123' },
    email: 'admin@euroid.test',
    passwordHash,
    name: 'Test Admin',
    role: 'super-admin',
    tenantId: 'dev-tenant',
    isActive: true,
    tokenVersion: 0,
    passwordHistory: [passwordHash],
    mfaEnabled: false,
    mfaBackupCodes: [],
    authSource: 'local',
    ...overrides,
  } as unknown as AdminUserDocument;
}

describe('AuthLocalService', () => {
  let service: AuthLocalService;
  let mockAdminModel: Record<string, jest.Mock>;
  let mockTenantModel: Record<string, jest.Mock>;
  let mockConfigService: { get: jest.Mock };
  let mockMachineIdentitySync: { syncAdminToIdentity: jest.Mock };
  let mockMfaService: { issueMfaPendingToken: jest.Mock };
  let mockInviteService: { redeemInvite: jest.Mock };
  let securityState: MemorySecurityStateStore;

  beforeEach(async () => {
    mockAdminModel = {
      findOne: jest.fn(),
      findById: jest.fn(),
      countDocuments: jest.fn(),
      create: jest.fn(),
      updateOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findByIdAndUpdate: jest.fn(),
    };

    mockTenantModel = {
      findOne: jest.fn(),
    };

    mockConfigService = {
      get: jest.fn((key: string) => {
        const map: Record<string, string> = {
          JWT_SECRET,
          JWT_EXPIRY,
          DEFAULT_TENANT_ID: 'dev-tenant',
          REFRESH_TOKEN_EXPIRY_DAYS: '7',
          NODE_ENV: 'test', // first-admin setup without SETUP_TOKEN is allowed in test only
        };
        return map[key];
      }),
    };

    mockMachineIdentitySync = {
      syncAdminToIdentity: jest.fn().mockResolvedValue(undefined),
    };

    mockMfaService = {
      issueMfaPendingToken: jest.fn().mockResolvedValue('mfa-pending-token-xyz'),
    };

    mockInviteService = {
      redeemInvite: jest.fn(),
    };

    securityState = new MemorySecurityStateStore();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthLocalService,
        { provide: SECURITY_STATE_STORE, useValue: securityState },
        { provide: getModelToken(AdminUser.name), useValue: mockAdminModel },
        { provide: getModelToken(Tenant.name), useValue: mockTenantModel },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: MachineIdentitySyncService, useValue: mockMachineIdentitySync },
        { provide: MfaService, useValue: mockMfaService },
        { provide: InviteService, useValue: mockInviteService },
      ],
    }).compile();

    service = module.get<AuthLocalService>(AuthLocalService);
  });

  // ---------------------------------------------------------------
  // 1. login — successful login returns JWT tokens + user
  // ---------------------------------------------------------------
  it('should return access_token, refresh_token, and user on successful login', async () => {
    const user = await createMockAdminUser();
    mockAdminModel.findOne.mockResolvedValue(user);
    mockTenantModel.findOne.mockResolvedValue(null); // No tenant MFA policy
    mockAdminModel.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const result = await service.login({ email: 'admin@euroid.test', password: VALID_PASSWORD });

    expect(result).toHaveProperty('access_token');
    expect(result).toHaveProperty('refresh_token');
    expect(result).toHaveProperty('user');
    expect(typeof result.access_token).toBe('string');
    expect(typeof result.refresh_token).toBe('string');
    expect((result.access_token as string).split('.')).toHaveLength(3); // JWT format
    expect(result.user).toEqual({
      id: 'user-id-123',
      email: 'admin@euroid.test',
      name: 'Test Admin',
      role: 'super-admin',
      tenantId: 'dev-tenant',
    });
  });

  // A suspended tenant (DELETE /tenants/:id) gets no session: password and SAML sign-ins end in
  // completeSignIn, the MFA step in issueTokensForUser, and a session lives on through refresh.
  describe('an admin of a suspended tenant', () => {
    const suspended = { tenantId: 'dev-tenant', status: 'suspended', settings: {} };

    it('cannot sign in, with 403 after the password check, not even to the MFA step', async () => {
      const user = await createMockAdminUser({ mfaEnabled: true });
      mockAdminModel.findOne.mockResolvedValue(user);
      mockTenantModel.findOne.mockResolvedValue(suspended);

      await expect(
        service.login({ email: 'admin@euroid.test', password: VALID_PASSWORD }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockMfaService.issueMfaPendingToken).not.toHaveBeenCalled();
      // No session was stored (the legacy password hash may still be upgraded).
      expect(mockAdminModel.updateOne).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          $set: expect.objectContaining({ refreshTokenHash: expect.anything() }),
        }),
      );
      // A wrong password still answers 401: the tenant status is not told to a guesser.
      await expect(
        service.login({ email: 'admin@euroid.test', password: 'WrongPass1!xxx' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('cannot finish the MFA step', async () => {
      mockAdminModel.findOne.mockResolvedValue(await createMockAdminUser());
      mockTenantModel.findOne.mockResolvedValue(suspended);

      await expect(service.issueTokensForUser('user-id-123')).rejects.toThrow(ForbiddenException);
      expect(mockAdminModel.updateOne).not.toHaveBeenCalled();
    });

    it('cannot refresh a session', async () => {
      const raw = 'refresh-token-of-suspended';
      const hash = createHash('sha256').update(raw).digest('hex');
      const user = await createMockAdminUser({
        refreshTokenHash: hash,
        refreshTokenExpiresAt: new Date(Date.now() + 60_000),
      });
      mockAdminModel.findOne.mockResolvedValue(user);
      mockAdminModel.findOneAndUpdate.mockResolvedValue(user);
      mockTenantModel.findOne.mockResolvedValue(suspended);

      await expect(service.refresh(raw)).rejects.toThrow(ForbiddenException);
      expect(mockAdminModel.updateOne).not.toHaveBeenCalled();
      expect(mockAdminModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('signs in when the admin is a platform admin, who manages the tenants', async () => {
      mockConfigService.get.mockImplementation((key: string) =>
        key === 'PLATFORM_ADMIN_USER_IDS'
          ? 'user-id-123'
          : ({ JWT_SECRET, JWT_EXPIRY, REFRESH_TOKEN_EXPIRY_DAYS: '7' } as Record<string, string>)[
              key
            ],
      );
      mockAdminModel.findOne.mockResolvedValue(await createMockAdminUser());
      mockAdminModel.updateOne.mockResolvedValue({ modifiedCount: 1 });
      mockTenantModel.findOne.mockResolvedValue(suspended);

      const result = await service.login({ email: 'admin@euroid.test', password: VALID_PASSWORD });
      expect(result).toHaveProperty('access_token');
    });
  });

  // The login throttle counts per client IP only: a botnet could guess one admin's password
  // from many addresses. Failures now count per account too, in a 15-minute window.
  describe('per-account lockout', () => {
    const login = (email: string, password: string) => service.login({ email, password });
    const status = (p: Promise<unknown>) =>
      p.then(
        () => 201,
        (e: { getStatus?: () => number }) => e.getStatus?.() ?? 500,
      );

    beforeEach(async () => {
      const admin = await createMockAdminUser();
      mockAdminModel.findOne.mockImplementation(async (filter: { email: string }) =>
        filter.email === 'admin@euroid.test' ? { ...admin } : null,
      );
      mockTenantModel.findOne.mockResolvedValue(null);
      mockAdminModel.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    });

    it('refuses even the right password after 10 failures, with 429', async () => {
      for (let i = 0; i < 10; i++) {
        expect(await status(login('admin@euroid.test', 'WrongPass1!xxx'))).toBe(401);
      }

      expect(await status(login('admin@euroid.test', VALID_PASSWORD))).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      // Another account is not affected.
      expect(await status(login('other@euroid.test', VALID_PASSWORD))).toBe(401);
    });

    it('locks an unknown address the same way, so the lockout tells nothing about accounts', async () => {
      for (let i = 0; i < 10; i++) await status(login('ghost@euroid.test', 'WrongPass1!xxx'));

      expect(await status(login('ghost@euroid.test', 'WrongPass1!xxx'))).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
    });

    it('a successful sign-in clears the failures', async () => {
      for (let i = 0; i < 9; i++) await status(login('admin@euroid.test', 'WrongPass1!xxx'));
      expect(await status(login('admin@euroid.test', VALID_PASSWORD))).toBe(201);

      for (let i = 0; i < 9; i++) await status(login('admin@euroid.test', 'WrongPass1!xxx'));
      expect(await status(login('admin@euroid.test', VALID_PASSWORD))).toBe(201);
    });

    // Final review AU2: keyed on the address alone, anyone who knew an admin's email could lock
    // that admin out with 10 wrong passwords every 15 minutes
    it('counts failures per address and client IP: another client is not locked out', async () => {
      for (let i = 0; i < 10; i++) {
        await status(
          service.login({ email: 'admin@euroid.test', password: 'Wrong1!xx' }, '203.0.113.9'),
        );
      }

      expect(
        await status(
          service.login({ email: 'admin@euroid.test', password: VALID_PASSWORD }, '203.0.113.9'),
        ),
      ).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(
        await status(
          service.login({ email: 'admin@euroid.test', password: VALID_PASSWORD }, '198.51.100.7'),
        ),
      ).toBe(201);
    });

    it('checks at most 10 passwords of a parallel burst', async () => {
      const results = await Promise.all(
        Array.from({ length: 14 }, () => status(login('admin@euroid.test', 'WrongPass1!xxx'))),
      );

      expect(results.filter((s) => s === 401)).toHaveLength(10);
      expect(results.filter((s) => s === HttpStatus.TOO_MANY_REQUESTS)).toHaveLength(4);
    });
  });

  // ---------------------------------------------------------------
  // 2. login — wrong password throws UnauthorizedException
  // ---------------------------------------------------------------
  it('should throw UnauthorizedException when password is wrong', async () => {
    const user = await createMockAdminUser();
    mockAdminModel.findOne.mockResolvedValue(user);

    await expect(
      service.login({ email: 'admin@euroid.test', password: 'WrongPassword1!x' }),
    ).rejects.toThrow(UnauthorizedException);

    await expect(
      service.login({ email: 'admin@euroid.test', password: 'WrongPassword1!x' }),
    ).rejects.toThrow('Invalid credentials');
  });

  // ---------------------------------------------------------------
  // 3. login — no matching user throws UnauthorizedException
  // ---------------------------------------------------------------
  it('should throw UnauthorizedException when user email not found', async () => {
    mockAdminModel.findOne.mockResolvedValue(null);

    await expect(
      service.login({ email: 'nobody@euroid.test', password: VALID_PASSWORD }),
    ).rejects.toThrow(UnauthorizedException);

    await expect(
      service.login({ email: 'nobody@euroid.test', password: VALID_PASSWORD }),
    ).rejects.toThrow('Invalid credentials');
  });

  // ---------------------------------------------------------------
  // 4. login — MFA-enabled account returns mfa_required + mfa_token
  // ---------------------------------------------------------------
  it('should return mfa_required and mfa_token when MFA is enabled', async () => {
    const user = await createMockAdminUser({ mfaEnabled: true });
    mockAdminModel.findOne.mockResolvedValue(user);

    const result = await service.login({ email: 'admin@euroid.test', password: VALID_PASSWORD });

    expect(result).toEqual({
      mfa_required: true,
      mfa_token: 'mfa-pending-token-xyz',
    });
    expect(mockMfaService.issueMfaPendingToken).toHaveBeenCalledWith(user);
    // Should NOT issue token pair
    expect(result).not.toHaveProperty('access_token');
  });

  // ---------------------------------------------------------------
  // 5. login — SAML user throws UnauthorizedException with SSO message
  // ---------------------------------------------------------------
  it('should throw UnauthorizedException with SSO message for SAML users', async () => {
    const user = await createMockAdminUser({ authSource: 'saml' });
    mockAdminModel.findOne.mockResolvedValue(user);

    await expect(
      service.login({ email: 'admin@euroid.test', password: VALID_PASSWORD }),
    ).rejects.toThrow(UnauthorizedException);

    await expect(
      service.login({ email: 'admin@euroid.test', password: VALID_PASSWORD }),
    ).rejects.toThrow(/SSO/);
  });

  // ---------------------------------------------------------------
  // 6. register — first user creates super-admin with bcrypt-hashed password
  // ---------------------------------------------------------------
  it('should create a super-admin on first registration (count=0)', async () => {
    mockAdminModel.findOne.mockResolvedValue(null); // no existing email
    mockAdminModel.countDocuments.mockResolvedValue(0);

    // findOneAndUpdate is used for atomic upsert — return the created user
    const createdUser = await createMockAdminUser({
      email: 'first@euroid.test',
      name: 'First Admin',
      role: 'super-admin',
    });
    mockAdminModel.findOneAndUpdate.mockResolvedValue(createdUser);

    const result = await service.register({
      email: 'first@euroid.test',
      password: VALID_PASSWORD,
      name: 'First Admin',
    });

    expect(result.user).toEqual({
      id: 'user-id-123',
      email: 'first@euroid.test',
      name: 'First Admin',
      role: 'super-admin',
      tenantId: 'dev-tenant',
    });

    // Verify findOneAndUpdate was called with upsert for atomic super-admin creation
    // Final review AU3: only an active super-admin closes first-admin setup
    expect(mockAdminModel.findOneAndUpdate).toHaveBeenCalledWith(
      { role: 'super-admin', isActive: true },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          email: 'first@euroid.test',
          name: 'First Admin',
          role: 'super-admin',
        }),
      }),
      { upsert: true, new: true },
    );

    // Verify the password hash in $setOnInsert is a valid argon2id hash
    const callArgs = mockAdminModel.findOneAndUpdate.mock.calls[0];
    const setOnInsert = callArgs[1].$setOnInsert as Record<string, unknown>;
    const storedHash = setOnInsert.passwordHash as string;
    expect(storedHash).toMatch(/^\$argon2id\$/);
    const matches = await argon2.verify(storedHash, VALID_PASSWORD);
    expect(matches).toBe(true);

    expect(mockMachineIdentitySync.syncAdminToIdentity).toHaveBeenCalledWith(createdUser);
  });

  // The schema setter lowercases the stored address, so a first admin registered as
  // Admin@Example.COM was created and then answered 409.
  it('creates the first admin whatever the case of the address', async () => {
    mockAdminModel.countDocuments.mockResolvedValue(0);
    const createdUser = await createMockAdminUser({ email: 'first@euroid.test' });
    mockAdminModel.findOneAndUpdate.mockResolvedValue(createdUser);

    const result = await service.register({
      email: 'First@EuroID.test',
      password: VALID_PASSWORD,
      name: 'First Admin',
    });

    expect(result.user.email).toBe('first@euroid.test');
    expect(mockMachineIdentitySync.syncAdminToIdentity).toHaveBeenCalledWith(createdUser);
  });

  it('refuses the first admin outside development and test while SETUP_TOKEN is not set', async () => {
    mockConfigService.get.mockImplementation((key: string) =>
      key === 'NODE_ENV' ? 'production' : key === 'JWT_SECRET' ? JWT_SECRET : undefined,
    );
    mockAdminModel.countDocuments.mockResolvedValue(0);

    await expect(
      service.register({ email: 'first@euroid.test', password: VALID_PASSWORD, name: 'First' }),
    ).rejects.toThrow(/SETUP_TOKEN/);
    expect(mockAdminModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------
  // 7. register — subsequent user without invite token throws ForbiddenException
  // ---------------------------------------------------------------
  it('should throw ForbiddenException when registering without invite token after first user', async () => {
    mockAdminModel.findOne.mockResolvedValue(null); // no duplicate email
    mockAdminModel.countDocuments.mockResolvedValue(1); // existing admin exists

    await expect(
      service.register({
        email: 'new@euroid.test',
        password: VALID_PASSWORD,
        name: 'New User',
      }),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      service.register({
        email: 'new@euroid.test',
        password: VALID_PASSWORD,
        name: 'New User',
      }),
    ).rejects.toThrow(/invite/i);
  });

  // ---------------------------------------------------------------
  // 8. changePassword — rejects password in last 5 history entries (real bcrypt)
  // ---------------------------------------------------------------
  it('should reject a password that appears in the last 5 password history entries', async () => {
    // Build a real password history with bcrypt hashes
    const oldPassword = 'OldPassword1!xx';
    const reusedPassword = 'ReusedPass99!xx';
    const currentHash = await bcrypt.hash(oldPassword, 12);
    const reusedHash = await bcrypt.hash(reusedPassword, 12);

    const user = await createMockAdminUser({
      passwordHash: currentHash,
      passwordHistory: [currentHash, reusedHash],
    });
    mockAdminModel.findById.mockResolvedValue(user);

    // Attempt to change to a password already in history
    await expect(
      service.changePassword('user-id-123', oldPassword, reusedPassword),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.changePassword('user-id-123', oldPassword, reusedPassword),
    ).rejects.toThrow(/used recently/i);
  });

  // ---------------------------------------------------------------
  // 9. changePassword — accepts new password not in history, updates hash
  // ---------------------------------------------------------------
  it('should accept a new password not in history and update the hash', async () => {
    const currentPassword = VALID_PASSWORD;
    const currentHash = await bcrypt.hash(currentPassword, 12);

    const user = await createMockAdminUser({
      passwordHash: currentHash,
      passwordHistory: [currentHash],
    });
    mockAdminModel.findById.mockResolvedValue(user);
    mockAdminModel.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await service.changePassword('user-id-123', currentPassword, VALID_PASSWORD_ALT);

    expect(mockAdminModel.updateOne).toHaveBeenCalledWith(
      { _id: expect.anything() },
      expect.objectContaining({
        $set: expect.objectContaining({
          passwordHash: expect.any(String),
          passwordHistory: expect.any(Array),
        }),
        $inc: { tokenVersion: 1 },
        // Every session ends, and an unused password reset token stops working.
        $unset: {
          refreshTokenHash: 1,
          refreshTokenExpiresAt: 1,
          passwordResetTokenHash: 1,
          passwordResetExpiresAt: 1,
        },
      }),
    );

    // Verify the new hash actually verifies with the new password (argon2id)
    const updateCall = mockAdminModel.updateOne.mock.calls[0];
    const setData = updateCall[1].$set as Record<string, unknown>;
    const newHash = setData.passwordHash as string;
    expect(newHash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(newHash, VALID_PASSWORD_ALT)).toBe(true);
    expect(await argon2.verify(newHash, currentPassword)).toBe(false);

    // Verify password history was prepended and sliced
    const updatedHistory = setData.passwordHistory as string[];
    expect(updatedHistory[0]).toBe(newHash);
    expect(updatedHistory).toHaveLength(2); // new + 1 existing
  });

  // ---------------------------------------------------------------
  // 10. refresh — valid refresh token returns new access token pair
  // ---------------------------------------------------------------
  it('should return new access_token and refresh_token for a valid refresh token', async () => {
    const rawRefreshToken = 'valid-refresh-token-base64url';
    const refreshHash = createHash('sha256').update(rawRefreshToken).digest('hex');
    const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const user = await createMockAdminUser({
      refreshTokenHash: refreshHash,
      refreshTokenExpiresAt: futureExpiry,
    });

    // First findOne for refresh lookup, then updateOne for new refresh storage
    mockAdminModel.findOne.mockResolvedValue(user);
    mockAdminModel.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

    const result = await service.refresh(rawRefreshToken);

    expect(result).toHaveProperty('access_token');
    expect(result).toHaveProperty('refresh_token');
    expect(typeof result.access_token).toBe('string');
    expect(typeof result.refresh_token).toBe('string');
    // The access token should be a valid JWT (3 dot-separated segments)
    expect(result.access_token.split('.')).toHaveLength(3);
    // New refresh token should differ from the old one (rotation)
    expect(result.refresh_token).not.toBe(rawRefreshToken);
    // The model should have been updated with the new refresh token hash
    // ...only while the presented token is still the stored one (the rotation is the claim)
    expect(mockAdminModel.updateOne).toHaveBeenCalledWith(
      { _id: user._id, refreshTokenHash: refreshHash },
      {
        $set: {
          refreshTokenHash: expect.any(String),
          refreshTokenExpiresAt: expect.any(Date),
        },
      },
    );
  });

  // ---------------------------------------------------------------
  // Admin management stays inside the caller's tenant: AdminUser is not tenant-scoped by the
  // plugin, and every tenant has its own super-admin.
  // ---------------------------------------------------------------
  it("revokes sessions only of the caller tenant's admin", async () => {
    mockAdminModel.updateOne.mockResolvedValueOnce({ matchedCount: 0 });

    await expect(service.revokeAllSessions('other-tenant-admin', 'tenant-a')).resolves.toBe(false);

    expect(mockAdminModel.updateOne).toHaveBeenCalledWith(
      { _id: 'other-tenant-admin', tenantId: 'tenant-a' },
      expect.objectContaining({ $inc: { tokenVersion: 1 } }),
    );
  });

  it('revokes the sessions in the database, where the guard reads tokenVersion on every request', async () => {
    mockAdminModel.updateOne.mockResolvedValueOnce({ matchedCount: 1 });

    await expect(service.revokeAllSessions('user-id-123', 'tenant-a')).resolves.toBe(true);

    // No cache to drop: session-revocation.spec.ts shows the old token refused at once.
    expect(mockAdminModel.updateOne).toHaveBeenCalledWith(
      { _id: 'user-id-123', tenantId: 'tenant-a' },
      { $inc: { tokenVersion: 1 }, $unset: { refreshTokenHash: 1, refreshTokenExpiresAt: 1 } },
    );
  });
});
