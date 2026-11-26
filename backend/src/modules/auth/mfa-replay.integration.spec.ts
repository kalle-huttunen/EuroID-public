/**
 * MFA codes on in-memory MongoDB with the real AdminUser model: a code proves the second factor
 * once. A TOTP code (and any code of an earlier step) is refused after it was used, a backup code
 * works once even when two requests present it at the same moment, and a burst of parallel
 * guesses gets no more code checks than the lockout allows.
 */
import mongoose, { Model } from 'mongoose';
import * as OTPAuth from 'otpauth';
import * as bcrypt from 'bcryptjs';
import type { ConfigService } from '@nestjs/config';
import { HttpStatus } from '@nestjs/common';
import { MemorySecurityStateStore } from '@infrastructure/cache/security-state.store';
import type { EncryptionService } from '@infrastructure/secrets/encryption.service';
import { connectTestDb, clearTestDb, closeTestDb } from '@testing';
import { AdminUser, AdminUserDocument, AdminUserSchema } from './schemas/admin-user.schema';
import { MfaService } from './mfa.service';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const BACKUP_CODE = 'ABCDEFGHJK';
const app = new OTPAuth.TOTP({
  issuer: 'EuroID',
  algorithm: 'SHA256',
  digits: 6,
  period: 30,
  secret: OTPAuth.Secret.fromBase32(SECRET),
});

describe('MFA codes are single-use (in-memory MongoDB)', () => {
  let adminModel: Model<AdminUserDocument>;
  let service: MfaService;
  let userId: string;
  let clock: jest.SpyInstance;

  beforeAll(async () => {
    await connectTestDb();
    adminModel = mongoose.model(
      AdminUser.name,
      AdminUserSchema,
    ) as unknown as Model<AdminUserDocument>;
  });

  beforeEach(async () => {
    // 10 s into a 30 s step, so no step ends during a test.
    clock = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_010_000);
    service = new MfaService(
      adminModel,
      { get: () => undefined } as unknown as ConfigService,
      { decrypt: (value: string) => value } as unknown as EncryptionService,
      new MemorySecurityStateStore(),
    );
    const admin = await adminModel.create({
      email: 'mfa@tenant-a.example',
      name: 'Mia',
      passwordHash: 'not-used',
      role: 'operator',
      tenantId: 'tenant-a',
      mfaEnabled: true,
      mfaSecret: SECRET,
      mfaBackupCodes: [await bcrypt.hash(BACKUP_CODE, 4)],
    });
    userId = String(admin._id);
  });

  afterEach(async () => {
    clock.mockRestore();
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('refuses a TOTP code the second time, and a code of an earlier step after it', async () => {
    const now = app.generate({ timestamp: Date.now() });
    const previous = app.generate({ timestamp: Date.now() - 30_000 });

    await expect(service.validateCode(userId, now)).resolves.toBe(true);
    await expect(service.validateCode(userId, now)).resolves.toBe(false);
    await expect(service.validateCode(userId, previous)).resolves.toBe(false);

    // The next step's code works.
    clock.mockReturnValue(Date.now() + 30_000);
    await expect(
      service.validateCode(userId, app.generate({ timestamp: Date.now() })),
    ).resolves.toBe(true);
  });

  it('lets only one of two simultaneous uses of one TOTP code through', async () => {
    const code = app.generate({ timestamp: Date.now() });

    const results = await Promise.all([
      service.validateCode(userId, code),
      service.validateCode(userId, code),
    ]);

    expect(results.sort()).toEqual([false, true]);
  });

  it('lets only one of two simultaneous uses of one backup code through, and removes it', async () => {
    const results = await Promise.all([
      service.validateCode(userId, BACKUP_CODE),
      service.validateCode(userId, BACKUP_CODE),
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect((await adminModel.findById(userId).lean())!.mfaBackupCodes).toEqual([]);
  });

  it('accepts a backup code typed in lower case', async () => {
    await expect(service.validateCode(userId, ` ${BACKUP_CODE.toLowerCase()} `)).resolves.toBe(
      true,
    );
  });

  it('checks at most five codes of a burst of parallel guesses, and refuses the rest with 429', async () => {
    const guesses = Array.from({ length: 12 }, (_, i) => String(100000 + i));
    const valid = new Set(
      [-1, 0, 1].map((s) => app.generate({ timestamp: Date.now() + s * 30_000 })),
    );

    const results = await Promise.allSettled(
      guesses
        .filter((g) => !valid.has(g))
        .slice(0, 10)
        .map((g) => service.validateCode(userId, g)),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(5);
    refused.forEach((r) => expect(r.reason.status).toBe(HttpStatus.TOO_MANY_REQUESTS));
  });
});
