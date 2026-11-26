import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jose from 'jose';
import * as OTPAuth from 'otpauth';
import * as QRCode from 'qrcode';
import {
  MemorySecurityStateStore,
  SECURITY_STATE_STORE,
  SecurityStateUnavailableError,
} from '@infrastructure/cache/security-state.store';
import { createUnavailableSecurityStateStore } from '@testing/test-helpers';
import * as bcrypt from 'bcryptjs';
import { MfaService } from './mfa.service';
import { AdminUser } from './schemas/admin-user.schema';
import { EncryptionService } from '@infrastructure/secrets/encryption.service';

// The real otpauth: codes come from the authenticator that scanned setupMfa's QR code, so the
// algorithm, digits, period and window the service checks are the ones the QR code announces.
// The real jose: a pending token past its expiry, or of another issuer, must be refused.
jest.mock('jose', () => jest.requireActual('@testing/real-jose').loadRealJose());

// ── QRCode mock: the test reads the otpauth:// URI the QR code would carry ─────────
jest.mock('qrcode', () => ({
  toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,QRCODE_STUB'),
}));

// ── Test helpers ────────────────────────────────────────────────────────
const TEST_USER_ID = '507f1f77bcf86cd799439011';
const TEST_JWT_SECRET = 'test-jwt-secret-thats-at-least-32chars-long';
const KNOWN_BACKUP_CODE = 'ABCD1234';
/** The clock of the TOTP tests: 15 s into a 30 s step, so no step ends during a test. */
const NOW = 1_800_000_015_000;
const STEP_MS = 30_000;

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => TEST_USER_ID },
    email: 'user@test.com',
    tenantId: 'dev-tenant',
    mfaEnabled: false,
    mfaSecret: undefined as string | undefined,
    mfaBackupCodes: [] as string[],
    ...overrides,
  };
}

/** A six-digit code no step from two before to two after the current one accepts. */
function wrongCode(app: OTPAuth.TOTP): string {
  const valid = new Set(
    [-2, -1, 0, 1, 2].map((step) => app.generate({ timestamp: NOW + step * STEP_MS })),
  );
  let n = 0;
  while (valid.has(String(n).padStart(6, '0'))) n++;
  return String(n).padStart(6, '0');
}

describe('MfaService', () => {
  let service: MfaService;
  let adminModel: {
    findById: jest.Mock;
    updateOne: jest.Mock;
  };
  let cacheStore: {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
    increment: jest.Mock;
  };
  let clock: jest.SpyInstance;

  beforeEach(async () => {
    clock = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    adminModel = {
      findById: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    };

    // The lockout counter in a real in-memory store, its calls observable.
    const store = new MemorySecurityStateStore();
    cacheStore = {
      get: jest.fn((key: string) => store.get(key)),
      set: jest.fn((key: string, value: unknown, ttlMs: number) => store.set(key, value, ttlMs)),
      del: jest.fn((key: string) => store.del(key)),
      increment: jest.fn((key: string, windowMs: number) => store.increment(key, windowMs)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MfaService,
        {
          provide: getModelToken(AdminUser.name),
          useValue: adminModel,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'JWT_SECRET') return TEST_JWT_SECRET;
              return undefined;
            }),
          },
        },
        {
          provide: EncryptionService,
          useValue: {
            encrypt: jest.fn((value: string) => `enc:${value}`),
            decrypt: jest.fn((value: string) =>
              value.startsWith('enc:') ? value.slice(4) : value,
            ),
          },
        },
        {
          provide: SECURITY_STATE_STORE,
          useValue: cacheStore,
        },
      ],
    }).compile();

    service = module.get(MfaService);
  });

  afterEach(() => clock.mockRestore());

  /**
   * MFA setup as the admin does it: setupMfa, then the authenticator app scans the QR code.
   * Returns the app, the key shown for manual entry, and the user as stored afterwards.
   */
  async function enroll() {
    adminModel.findById.mockResolvedValue(makeUser());
    const { qrCodeDataUrl, manualEntryKey } = await service.setupMfa(TEST_USER_ID);
    const qrCalls = (QRCode.toDataURL as jest.Mock).mock.calls;
    const app = OTPAuth.URI.parse(qrCalls[qrCalls.length - 1][0]) as OTPAuth.TOTP;
    const setCalls = adminModel.updateOne.mock.calls;
    const mfaSecret = setCalls[setCalls.length - 1][1].$set.mfaSecret as string;
    return { app, qrCodeDataUrl, manualEntryKey, user: makeUser({ mfaSecret }) };
  }

  /** An admin with MFA on, and the authenticator app that has its secret. */
  async function enrolled(overrides: Record<string, unknown> = {}) {
    const { app, user } = await enroll();
    adminModel.findById.mockResolvedValue({ ...user, mfaEnabled: true, ...overrides });
    return app;
  }

  // ── Test 1 ──────────────────────────────────────────────────────────
  it('setupMfa — generates TOTP secret, returns QR code data URL and manual entry key', async () => {
    const { app, qrCodeDataUrl, manualEntryKey, user } = await enroll();

    expect(qrCodeDataUrl).toBe('data:image/png;base64,QRCODE_STUB');
    expect(manualEntryKey).toMatch(/^[A-Z2-7]{32}$/); // 20 random bytes in base32
    expect(user.mfaSecret).toBe(`enc:${manualEntryKey}`);
    expect(adminModel.updateOne).toHaveBeenCalledWith(
      { _id: TEST_USER_ID },
      { $set: { mfaSecret: `enc:${manualEntryKey}`, mfaEnabled: false } },
    );
    // What the authenticator app is told: the codes validateCode and verifySetup expect.
    expect(app).toMatchObject({
      issuer: 'EuroID',
      label: 'user@test.com',
      algorithm: 'SHA256',
      digits: 6,
      period: 30,
    });
    expect(app.secret.base32).toBe(manualEntryKey);
  });

  // ── Test 2 ──────────────────────────────────────────────────────────
  it('setupMfa — throws BadRequestException if MFA is already enabled', async () => {
    adminModel.findById.mockResolvedValue(makeUser({ mfaEnabled: true }));

    await expect(service.setupMfa(TEST_USER_ID)).rejects.toThrow(BadRequestException);
    await expect(service.setupMfa(TEST_USER_ID)).rejects.toThrow('MFA is already enabled');
  });

  // ── Test 3 ──────────────────────────────────────────────────────────
  it('verifySetup — valid TOTP code enables MFA and returns backup codes array', async () => {
    const { app, user } = await enroll();
    adminModel.findById.mockResolvedValue(user);

    const result = await service.verifySetup(TEST_USER_ID, app.generate());

    expect(result.backupCodes).toBeDefined();
    expect(Array.isArray(result.backupCodes)).toBe(true);
    expect(result.backupCodes).toHaveLength(10);

    // Verify MFA was enabled and hashed backup codes were persisted
    const calls = adminModel.updateOne.mock.calls;
    const [filter, update] = calls[calls.length - 1];
    expect(filter).toEqual({ _id: TEST_USER_ID });
    expect(update).toEqual({
      $set: {
        mfaEnabled: true,
        mfaBackupCodes: expect.arrayContaining([expect.any(String)]),
        // The setup code's step is used up: it cannot pass the first sign-in's MFA step too.
        mfaLastTotpStep: Math.floor(NOW / STEP_MS),
      },
    });

    // 10 characters of A-Z and 2-7, each of 32 equally likely (50 bits), all different
    for (const code of result.backupCodes) expect(code).toMatch(/^[A-Z2-7]{10}$/);
    expect(new Set(result.backupCodes).size).toBe(10);

    // The stored hashes should be valid bcrypt hashes of the plain backup codes
    const storedHashes = update.$set.mfaBackupCodes as string[];
    expect(storedHashes).toHaveLength(10);
    expect(await bcrypt.compare(result.backupCodes[0], storedHashes[0])).toBe(true);
  });

  it('verifySetup: a wrong code leaves MFA off', async () => {
    const { app, user } = await enroll();
    adminModel.findById.mockResolvedValue(user);
    adminModel.updateOne.mockClear();

    await expect(service.verifySetup(TEST_USER_ID, wrongCode(app))).rejects.toThrow(
      'Invalid verification code',
    );
    expect(adminModel.updateOne).not.toHaveBeenCalled();
  });

  // ── Test 4 ──────────────────────────────────────────────────────────
  it('validateCode — correct 6-digit TOTP code returns true', async () => {
    const app = await enrolled();

    const result = await service.validateCode(TEST_USER_ID, app.generate());
    expect(result).toBe(true);

    // The attempt counter is cleared on success
    expect(cacheStore.del).toHaveBeenCalledWith(`mfa:attempts:${TEST_USER_ID}`);
  });

  it('validateCode: accepts the code of the previous 30-second step, not of two steps back', async () => {
    const app = await enrolled();

    // An authenticator clock up to one step behind is accepted (window 1).
    const previous = app.generate({ timestamp: NOW - STEP_MS });
    await expect(service.validateCode(TEST_USER_ID, previous)).resolves.toBe(true);

    const twoStepsBack = app.generate({ timestamp: NOW - 2 * STEP_MS });
    await expect(service.validateCode(TEST_USER_ID, twoStepsBack)).resolves.toBe(false);
  });

  // ── Test 5 ──────────────────────────────────────────────────────────
  it('validateCode — wrong code returns false and counts the attempt', async () => {
    const app = await enrolled({ mfaBackupCodes: [] });

    const result = await service.validateCode(TEST_USER_ID, wrongCode(app));
    expect(result).toBe(false);

    // Counted atomically, in a 15-minute window, before the code was checked
    expect(cacheStore.increment).toHaveBeenCalledWith(
      `mfa:attempts:${TEST_USER_ID}`,
      15 * 60 * 1000,
    );
    expect(cacheStore.del).not.toHaveBeenCalled();
  });

  // ── Test 6 ──────────────────────────────────────────────────────────
  it('validateCode — 5 wrong attempts triggers lockout (throws HttpException 429)', async () => {
    const app = await enrolled({ mfaBackupCodes: [] });

    for (let attempt = 1; attempt <= 5; attempt++) {
      await expect(service.validateCode(TEST_USER_ID, wrongCode(app))).resolves.toBe(false);
    }
    adminModel.findById.mockClear();

    // Locked out: a correct code too, and the admin is not even read.
    await expect(service.validateCode(TEST_USER_ID, app.generate())).rejects.toBeInstanceOf(
      HttpException,
    );
    await expect(service.validateCode(TEST_USER_ID, app.generate())).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      message: 'Too many MFA attempts. Try again later.',
    });
    expect(adminModel.findById).not.toHaveBeenCalled();
  });

  it('validateCode: 4 wrong attempts do not lock a correct code out', async () => {
    const app = await enrolled({ mfaBackupCodes: [] });

    for (let attempt = 1; attempt <= 4; attempt++) {
      await service.validateCode(TEST_USER_ID, wrongCode(app));
    }

    await expect(service.validateCode(TEST_USER_ID, app.generate())).resolves.toBe(true);
  });

  // ── Test 7 ──────────────────────────────────────────────────────────
  it('validateCode — valid backup code succeeds and is consumed (removed from mfaBackupCodes)', async () => {
    // Hash the known backup code with real bcrypt
    const hashedBackupCode = await bcrypt.hash(KNOWN_BACKUP_CODE, 10);

    adminModel.findById.mockResolvedValue(
      makeUser({
        mfaEnabled: true,
        mfaSecret: 'enc:JBSWY3DPEHPK3PXP',
        mfaBackupCodes: [hashedBackupCode],
      }),
    );

    const result = await service.validateCode(TEST_USER_ID, KNOWN_BACKUP_CODE);
    expect(result).toBe(true);

    // Removed only while still stored, so two requests with one code cannot both use it
    expect(adminModel.updateOne).toHaveBeenCalledWith(
      { _id: TEST_USER_ID, mfaBackupCodes: hashedBackupCode },
      { $pull: { mfaBackupCodes: hashedBackupCode } },
    );

    // The attempt counter is cleared
    expect(cacheStore.del).toHaveBeenCalledWith(`mfa:attempts:${TEST_USER_ID}`);
  });

  // ── Test 8 ──────────────────────────────────────────────────────────
  it('issueMfaPendingToken + verifyMfaPendingToken — round-trip returns correct sub/email/tenantId', async () => {
    const mockUser = makeUser({ mfaEnabled: true });

    // Issue a pending MFA token
    const token = await service.issueMfaPendingToken(
      mockUser as Parameters<typeof service.issueMfaPendingToken>[0],
    );
    // Five minutes to finish the MFA step.
    const { iat, exp } = jose.decodeJwt(token);
    expect(exp! - iat!).toBe(5 * 60);

    // Verify the pending token round-trips correctly
    const decoded = await service.verifyMfaPendingToken(token);
    expect(decoded.sub).toBe(TEST_USER_ID);
    expect(decoded.email).toBe('user@test.com');
    expect(decoded.tenantId).toBe('dev-tenant');
  });

  describe('verifyMfaPendingToken refuses with 401', () => {
    const secret = new TextEncoder().encode(TEST_JWT_SECRET);
    const claims = { sub: TEST_USER_ID, email: 'user@test.com', tenantId: 'dev-tenant' };

    it.each<[string, () => Promise<string>]>([
      [
        // What AuthLocalService.signJwt issues after a completed sign-in.
        'an access token',
        () =>
          new jose.SignJWT({ ...claims, roles: ['super-admin'], tokenVersion: 0 })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('1h')
            .setIssuer('euroid-local')
            .setAudience('euroid-api')
            .sign(secret),
      ],
      [
        // What AuthLocalService.signScopedJwt issues when the tenant requires MFA setup.
        'an MFA enrollment token',
        () =>
          new jose.SignJWT({ ...claims, roles: [], scope: 'mfa-enrollment', tokenVersion: 0 })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('5m')
            .setIssuer('euroid-local')
            .setAudience('euroid-api')
            .sign(secret),
      ],
      [
        'a pending token past its five minutes',
        () =>
          new jose.SignJWT({ ...claims, mfaPending: true })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt(1_000_000_000)
            .setExpirationTime(1_000_000_300)
            .setIssuer('euroid-mfa')
            .sign(secret),
      ],
    ])('%s', async (_name, tokenOf) => {
      await expect(service.verifyMfaPendingToken(await tokenOf())).rejects.toThrow(
        new UnauthorizedException('MFA token expired or invalid'),
      );
    });

    it('a token of the MFA issuer that is not a pending token', async () => {
      const token = await new jose.SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('5m')
        .setIssuer('euroid-mfa')
        .sign(secret);

      await expect(service.verifyMfaPendingToken(token)).rejects.toThrow('Invalid MFA token');
    });
  });

  // ── Lockout counter unavailable (Redis down) ─────────────────────────
  describe('while the lockout counter store is down', () => {
    const down = createUnavailableSecurityStateStore();
    let app: OTPAuth.TOTP;

    beforeEach(async () => {
      app = await enrolled({ mfaBackupCodes: [] });
      adminModel.findById.mockClear();
    });

    it('denies with 503 before checking any code when the attempt cannot be counted', async () => {
      cacheStore.increment.mockImplementation((key: string, ms: number) => down.increment(key, ms));

      // A correct code too: without the counter there is no lockout, so nothing is checked.
      await expect(service.validateCode(TEST_USER_ID, app.generate())).rejects.toBeInstanceOf(
        SecurityStateUnavailableError,
      );
      await expect(service.validateCode(TEST_USER_ID, app.generate())).rejects.toMatchObject({
        status: HttpStatus.SERVICE_UNAVAILABLE,
      });
      expect(adminModel.findById).not.toHaveBeenCalled();
    });

    it('denies with 503 a wrong code too when its attempt cannot be counted', async () => {
      cacheStore.increment.mockImplementation((key: string, ms: number) => down.increment(key, ms));

      await expect(service.validateCode(TEST_USER_ID, wrongCode(app))).rejects.toBeInstanceOf(
        SecurityStateUnavailableError,
      );
    });

    it('accepts a correct code when only clearing the counter fails (it expires on its own)', async () => {
      cacheStore.del.mockImplementation((key: string) => down.del(key));

      await expect(service.validateCode(TEST_USER_ID, app.generate())).resolves.toBe(true);
    });
  });
});
