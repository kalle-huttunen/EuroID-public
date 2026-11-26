/**
 * Console admin password reset over HTTP on in-memory MongoDB, with the mail module's test
 * transport (nothing leaves the process). An admin who forgot the password asks for a link by
 * email (answered the same for every address, before any lookup or mail), or gets a one-time code
 * from a super-admin of the tenant; either token sets a new password once, ends every session,
 * signs nobody in and leaves MFA as it is. Tokens are 32 random bytes stored only as a hash, a
 * newer token or a password change voids the earlier one, and the public routes are rate limited
 * in the shared security state store, which fails closed. No token, code or password reaches an
 * event.
 */

import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  NestMiddleware,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { ZodValidationPipe } from '@anatine/zod-nestjs';
import mongoose, { Model, Types } from 'mongoose';
import type { NextFunction, Request, Response } from 'express';
import * as request from 'supertest';
import * as argon2 from 'argon2';
import { createHash } from 'crypto';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { TenantContextInterceptor } from '@infrastructure/multi-tenancy/tenant-context.interceptor';
import { CorrelationMiddleware } from '@infrastructure/middleware/correlation.middleware';
import { RolesGuard } from '@infrastructure/auth/roles.guard';
import { TenantGuard } from '@infrastructure/auth/tenant.guard';
import { authConfig } from '@infrastructure/config/auth.config';
import { type MailConfig, mailConfig } from '@infrastructure/config/mail.config';
import {
  MemorySecurityStateStore,
  SECURITY_STATE_STORE,
  type SecurityStateStore,
} from '@infrastructure/cache/security-state.store';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { getEventSchema } from '@infrastructure/events/event-payload-schemas';
import { DomainEventType } from '@infrastructure/events/event-types';
import { Tenant, TenantSchema } from '@infrastructure/multi-tenancy/schemas/tenant.schema';
import {
  createMockEventEmitter,
  createUnavailableSecurityStateStore,
  closeTestDb,
  testDbUri,
} from '@testing';
import { MachineIdentitySyncService } from '../identity/machine-identity-sync.service';
import {
  MAIL_SENDER,
  MailTransportService,
  type OutgoingMail,
} from '../notifications/mail-transport.service';
import { PasswordResetMailService } from '../notifications/password-reset-mail.service';
import { AdminUsersService } from './admin-users.service';
import { AuthLocalController } from './auth-local.controller';
import { AuthLocalService } from './auth-local.service';
import { InviteService } from './invite.service';
import { MfaService } from './mfa.service';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetService } from './password-reset.service';
import { AdminUser, AdminUserDocument, AdminUserSchema } from './schemas/admin-user.schema';

mongoose.plugin(tenantPlugin);

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const OLD_PASSWORD = 'OldPassword1!x';
const NEW_PASSWORD = 'NewPassword2@y';
const PLATFORM_ADMIN_ID = new Types.ObjectId().toString();
const MFA_SECRET = 'euroid:v2:key-1:VE9UUC1TRUNSRVQtQ0lQSEVSVEVYVA';
const BACKUP_CODES = ['$2b$10$backupcodehashbackupcodehashbackupcodehashbac'];
const LIMITS = {
  PASSWORD_RESET_TOKEN_TTL_MINUTES: 30,
  PASSWORD_RESET_MAX_PER_IP: 6,
  PASSWORD_RESET_MAX_PER_EMAIL: 3,
  PASSWORD_RESET_WINDOW_MINUTES: 15,
};
const MAIL_CONF: MailConfig = {
  enabled: true,
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  requireTls: true,
  from: 'EuroID <no-reply@example.com>',
  timeoutMs: 1000,
  frontendUrl: 'https://euroid.example.com',
};

@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const header = req.headers['x-test-user'];
    if (typeof header === 'string') req.user = JSON.parse(header);
    return true;
  }
}

@Injectable()
class RequestContextMiddleware implements NestMiddleware {
  private readonly inner = new CorrelationMiddleware();
  use(req: Request, res: Response, next: NextFunction): void {
    this.inner.use(req, res, next);
  }
}

/** The shared security state store; a test swaps in a fresh or an unavailable one. */
class SwappableStore implements SecurityStateStore {
  current: SecurityStateStore = new MemorySecurityStateStore();
  get<T>(key: string) {
    return this.current.get<T>(key);
  }
  set(key: string, value: unknown, ttlMs: number) {
    return this.current.set(key, value, ttlMs);
  }
  del(key: string) {
    return this.current.del(key);
  }
  take<T>(key: string) {
    return this.current.take<T>(key);
  }
  increment(key: string, windowMs: number) {
    return this.current.increment(key, windowMs);
  }
  health() {
    return this.current.health();
  }
}

type Caller = { sub: string; email: string; roles: string[]; tenantId: string };

describe('Admin password reset (HTTP + in-memory MongoDB)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let adminModel: Model<AdminUserDocument>;
  let events: ReturnType<typeof createMockEventEmitter>;
  const store = new SwappableStore();
  /** Mails the test transport took; `hold` keeps the next sends waiting until released. */
  const sent: OutgoingMail[] = [];
  let hold: Promise<void> | null = null;
  let ownerA: Caller;
  let ownerB: Caller;
  let aliceId: string;

  beforeAll(async () => {
    events = createMockEventEmitter();
    const sender = {
      sendMail: async (message: OutgoingMail & { from: string }) => {
        if (hold) await hold;
        sent.push(message);
      },
    };

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_SECRET: 'test-jwt-secret-thats-at-least-32chars-long' })],
        }),
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: AdminUser.name, schema: AdminUserSchema },
          { name: Tenant.name, schema: TenantSchema },
        ]),
      ],
      controllers: [AuthLocalController, PasswordResetController],
      providers: [
        AuthLocalService,
        AdminUsersService,
        PasswordResetService,
        PasswordResetMailService,
        MailTransportService,
        { provide: mailConfig.KEY, useValue: MAIL_CONF },
        { provide: MAIL_SENDER, useValue: sender },
        { provide: SECURITY_STATE_STORE, useValue: store },
        { provide: DomainEventEmitterService, useValue: events },
        { provide: InviteService, useValue: {} },
        { provide: MachineIdentitySyncService, useValue: {} },
        {
          provide: MfaService,
          useValue: { issueMfaPendingToken: jest.fn().mockResolvedValue('mfa-pending') },
        },
        {
          provide: authConfig.KEY,
          useValue: { PLATFORM_ADMIN_USER_IDS: PLATFORM_ADMIN_ID, ...LIMITS },
        },
        { provide: APP_GUARD, useClass: TestAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: TenantGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    const contextMiddleware = new RequestContextMiddleware();
    app.use((req: Request, res: Response, next: NextFunction) =>
      contextMiddleware.use(req, res, next),
    );
    app.useGlobalInterceptors(new TenantContextInterceptor());
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();

    adminModel = moduleRef.get(getModelToken(AdminUser.name));
  });

  beforeEach(async () => {
    const passwordHash = await argon2.hash(OLD_PASSWORD, { type: argon2.argon2id });
    const seed = async (fields: Partial<AdminUser> & { _id?: string }) => {
      const doc = await adminModel.create({
        passwordHash,
        passwordHistory: [passwordHash],
        role: 'operator',
        tenantId: TENANT_A,
        ...fields,
      });
      return String(doc._id);
    };
    const owner = async (email: string, tenantId: string): Promise<Caller> => ({
      sub: await seed({ email, name: email, role: 'super-admin', tenantId }),
      email,
      roles: ['super-admin'],
      tenantId,
    });
    ownerA = await owner('owner@tenant-a.example', TENANT_A);
    ownerB = await owner('owner@tenant-b.example', TENANT_B);
    aliceId = await seed({
      email: 'alice@tenant-a.example',
      name: 'Alice',
      mfaEnabled: true,
      mfaSecret: MFA_SECRET,
      mfaBackupCodes: BACKUP_CODES,
      refreshTokenHash: 'a'.repeat(64),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
      tokenVersion: 3,
    });
    // A single sign-on account, here even with a hash that matches OLD_PASSWORD: it is excluded
    // by how it signs in, not by a missing hash.
    await seed({ email: 'sso@tenant-a.example', name: 'Sso', authSource: 'saml' });
    await seed({ email: 'gone@tenant-a.example', name: 'Gone', isActive: false });
    await seed({
      _id: PLATFORM_ADMIN_ID,
      email: 'platform@tenant-a.example',
      name: 'Platform',
      role: 'super-admin',
    });
    store.current = new MemorySecurityStateStore();
    sent.length = 0;
    hold = null;
  });

  afterEach(async () => {
    await moduleRef.get(PasswordResetService).drain();
    jest.restoreAllMocks();
    await adminModel.deleteMany({});
    events.emit.mockClear();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const as = (user: object) => ({ 'x-test-user': JSON.stringify(user) });
  const server = () => app.getHttpServer();
  const askForLink = (email: string) =>
    request(server()).post('/api/v1/auth/password-reset/request').send({ email });
  const confirm = (token: string, newPassword = NEW_PASSWORD) =>
    request(server()).post('/api/v1/auth/password-reset/confirm').send({ token, newPassword });
  const issue = (caller: Caller, id: string) =>
    request(server()).post(`/api/v1/auth/users/${id}/password-reset`).set(as(caller));
  const signIn = (email: string, password: string) =>
    request(server()).post('/api/v1/auth/login').send({ email, password });
  const settled = () => moduleRef.get(PasswordResetService).drain();
  const stored = (id: string) => adminModel.findById(id).lean();
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  const linkToken = (mail: OutgoingMail) => {
    const match = /\/reset-password#token=([0-9a-f]{64})/.exec(mail.text);
    if (!match) throw new Error('no reset link in the mail');
    return match[1];
  };
  const emitted = (type: DomainEventType) =>
    events.emit.mock.calls.filter(([t]) => t === type).map(([, id, payload]) => ({ id, payload }));
  const mailOff = () =>
    jest.spyOn(moduleRef.get(MailTransportService), 'isEnabled').mockReturnValue(false);

  describe('POST /auth/password-reset/request', () => {
    it('answers an unknown address exactly as a known one, before any mail is sent', async () => {
      let release!: () => void;
      hold = new Promise((resolve) => (release = resolve));

      const known = await askForLink('alice@tenant-a.example').expect(202);
      const unknown = await askForLink('nobody@tenant-a.example').expect(202);

      expect(unknown.body).toEqual(known.body);
      expect(known.body.message).toMatch(/valid for 30 minutes/);
      // Both answers came while the SMTP send was still waiting.
      expect(sent).toHaveLength(0);
      release();
      await settled();
      expect(sent.map((m) => m.to)).toEqual(['alice@tenant-a.example']);
    });

    it('mails a link with a 32-byte token that is stored only as its hash, for the configured time', async () => {
      const before = Date.now();
      await askForLink('Alice@Tenant-A.example ').expect(202);
      await settled();

      expect(sent).toHaveLength(1);
      const token = linkToken(sent[0]);
      expect(sent[0].text).toContain(`https://euroid.example.com/reset-password#token=${token}`);
      expect(sent[0].subject).toBe('Reset your EuroID password');
      const after = await stored(aliceId);
      expect(after?.passwordResetTokenHash).toBe(sha256(token));
      expect(JSON.stringify(after)).not.toContain(token);
      const expiresAt = after!.passwordResetExpiresAt!.getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 1000);
    });

    it('audits the request with the admin id only, never the token or the address', async () => {
      await askForLink('alice@tenant-a.example').expect(202);
      await settled();

      const requested = emitted(DomainEventType.ADMIN_USER_PASSWORD_RESET_REQUESTED);
      expect(requested).toEqual([
        { id: aliceId, payload: { adminUserId: aliceId, mailSent: true } },
      ]);
      expect(
        getEventSchema(DomainEventType.ADMIN_USER_PASSWORD_RESET_REQUESTED).safeParse(
          requested[0].payload,
        ).success,
      ).toBe(true);
      const all = JSON.stringify(events.emit.mock.calls);
      expect(all).not.toContain(linkToken(sent[0]));
      expect(all).not.toContain('alice@tenant-a.example');
    });

    it('sends nothing to a single sign-on or deactivated account, and answers the same', async () => {
      const known = await askForLink('alice@tenant-a.example').expect(202);
      for (const email of ['sso@tenant-a.example', 'gone@tenant-a.example']) {
        const res = await askForLink(email).expect(202);
        expect(res.body).toEqual(known.body);
      }
      await settled();

      expect(sent.map((m) => m.to)).toEqual(['alice@tenant-a.example']);
      const tokens = await adminModel.countDocuments({ passwordResetTokenHash: { $exists: true } });
      expect(tokens).toBe(1);
    });

    it('sends nothing and stores no token while email is off, and answers the same', async () => {
      const on = await askForLink('alice@tenant-a.example').expect(202);
      await settled();
      sent.length = 0;
      await adminModel.updateMany({}, { $unset: { passwordResetTokenHash: 1 } });
      mailOff();

      const off = await askForLink('alice@tenant-a.example').expect(202);
      await settled();

      expect(off.body).toEqual(on.body);
      expect(sent).toHaveLength(0);
      expect((await stored(aliceId))?.passwordResetTokenHash).toBeUndefined();
    });

    it('limits requests per address, an unknown one too', async () => {
      for (const email of ['alice@tenant-a.example', 'nobody@tenant-a.example']) {
        // A fresh store per address, so the per-IP limit (6) does not answer first.
        store.current = new MemorySecurityStateStore();
        for (let i = 0; i < LIMITS.PASSWORD_RESET_MAX_PER_EMAIL; i++) {
          await askForLink(email).expect(202);
        }
        const refused = await askForLink(email).expect(429);
        expect(refused.body.message).toMatch(/^Too many password reset attempts\. Try again in/);
      }
    });

    it('limits requests per IP whatever the addresses', async () => {
      for (let i = 0; i < LIMITS.PASSWORD_RESET_MAX_PER_IP; i++) {
        await askForLink(`someone${i}@tenant-a.example`).expect(202);
      }
      await askForLink('alice@tenant-a.example').expect(429);
      await settled();
      expect(sent).toHaveLength(0);
    });

    it('refuses (503) and sends nothing while the security state store is down', async () => {
      store.current = createUnavailableSecurityStateStore();

      await askForLink('alice@tenant-a.example').expect(503);
      await settled();

      expect(sent).toHaveLength(0);
      expect((await stored(aliceId))?.passwordResetTokenHash).toBeUndefined();
    });

    it('needs an email address', async () => {
      for (const body of [{}, { email: 'not-an-address' }, { email: 42 }]) {
        await request(server()).post('/api/v1/auth/password-reset/request').send(body).expect(400);
      }
    });
  });

  describe('POST /auth/users/:id/password-reset', () => {
    it('issues a one-time code for an admin of the tenant, stored only as a hash and audited without it', async () => {
      const res = await issue(ownerA, aliceId).expect(201);

      expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
      expect((await stored(aliceId))?.passwordResetTokenHash).toBe(sha256(res.body.token));
      const issued = emitted(DomainEventType.ADMIN_USER_PASSWORD_RESET_ISSUED);
      expect(issued).toEqual([
        {
          id: aliceId,
          payload: { adminUserId: aliceId, issuedBy: ownerA.sub, expiresAt: res.body.expiresAt },
        },
      ]);
      expect(
        getEventSchema(DomainEventType.ADMIN_USER_PASSWORD_RESET_ISSUED).safeParse(
          issued[0].payload,
        ).success,
      ).toBe(true);
      expect(JSON.stringify(events.emit.mock.calls)).not.toContain(res.body.token);
      // The admin still signs in with the old password until the code is used.
      await signIn('alice@tenant-a.example', OLD_PASSWORD).expect(201);
    });

    it('works while email is off', async () => {
      mailOff();

      await issue(ownerA, aliceId).expect(201);
    });

    it("answers 404 for another tenant's admin, a platform admin's account included", async () => {
      await issue(ownerB, aliceId).expect(404);
      await issue(ownerB, PLATFORM_ADMIN_ID).expect(404);

      expect(await adminModel.countDocuments({ passwordResetTokenHash: { $exists: true } })).toBe(
        0,
      );
    });

    it('refuses a platform admin (403), your own account (400), single sign-on and deactivated accounts (409)', async () => {
      const ssoId = String((await adminModel.findOne({ email: 'sso@tenant-a.example' }))!._id);
      const goneId = String((await adminModel.findOne({ email: 'gone@tenant-a.example' }))!._id);
      const platform = { ...ownerA, sub: PLATFORM_ADMIN_ID, email: 'platform@tenant-a.example' };

      expect((await issue(ownerA, PLATFORM_ADMIN_ID).expect(403)).body.message).toMatch(
        /PLATFORM_ADMIN_USER_IDS/,
      );
      await issue(platform, PLATFORM_ADMIN_ID).expect(403);
      expect((await issue(ownerA, ownerA.sub).expect(400)).body.message).toMatch(
        /Change your password under Account security/,
      );
      expect((await issue(ownerA, ssoId).expect(409)).body.message).toMatch(/single sign-on/);
      expect((await issue(ownerA, goneId).expect(409)).body.message).toMatch(/deactivated/);
      expect(await adminModel.countDocuments({ passwordResetTokenHash: { $exists: true } })).toBe(
        0,
      );
    });

    it('needs super-admin and an admin id', async () => {
      await issue({ ...ownerA, roles: ['operator'] }, aliceId).expect(403);
      await issue(ownerA, 'not-an-id').expect(400);
    });
  });

  describe('POST /auth/password-reset/confirm', () => {
    const mailedToken = async () => {
      await askForLink('alice@tenant-a.example').expect(202);
      await settled();
      return linkToken(sent[sent.length - 1]);
    };
    const issuedCode = async () => (await issue(ownerA, aliceId).expect(201)).body.token as string;

    it('sets the new password from the mailed link, ends every session, signs nobody in, keeps MFA', async () => {
      const token = await mailedToken();

      const res = await confirm(token).expect(200);

      expect(res.body).toEqual({
        success: true,
        message: 'Password changed. Sign in with your new password.',
      });
      expect(res.headers['set-cookie']).toBeUndefined();
      const after = await stored(aliceId);
      expect(after).toMatchObject({
        tokenVersion: 4,
        mfaEnabled: true,
        mfaSecret: MFA_SECRET,
        mfaBackupCodes: BACKUP_CODES,
      });
      expect(after?.refreshTokenHash).toBeUndefined();
      expect(after?.passwordResetTokenHash).toBeUndefined();
      expect(after?.passwordHistory).toHaveLength(2);
      expect(await argon2.verify(after!.passwordHistory[0], NEW_PASSWORD)).toBe(true);
      await signIn('alice@tenant-a.example', OLD_PASSWORD).expect(401);
      const signedIn = await signIn('alice@tenant-a.example', NEW_PASSWORD).expect(201);
      expect(signedIn.body).toEqual({ mfa_required: true, mfa_token: 'mfa-pending' });
    });

    it("accepts a super-admin's code the same way, and audits the reset without it", async () => {
      const code = await issuedCode();

      await confirm(code.toUpperCase()).expect(200);

      await signIn('alice@tenant-a.example', NEW_PASSWORD).expect(201);
      const completed = emitted(DomainEventType.ADMIN_USER_PASSWORD_RESET_COMPLETED);
      expect(completed).toEqual([{ id: aliceId, payload: { adminUserId: aliceId } }]);
      const all = JSON.stringify(events.emit.mock.calls);
      expect(all).not.toContain(code);
      expect(all).not.toContain(NEW_PASSWORD);
    });

    it('works once', async () => {
      const token = await mailedToken();
      await confirm(token).expect(200);

      const again = await confirm(token, 'ThirdPassword3#z').expect(400);

      expect(again.body.message).toBe(
        'This reset link or code is invalid, used or expired. Ask for a new one.',
      );
      await signIn('alice@tenant-a.example', NEW_PASSWORD).expect(201);
    });

    it('refuses an expired token and an unknown one', async () => {
      const code = await issuedCode();
      await adminModel.updateOne(
        { _id: aliceId },
        { $set: { passwordResetExpiresAt: new Date(Date.now() - 1000) } },
      );

      await confirm(code).expect(400);
      await confirm('f'.repeat(64)).expect(400);
      await signIn('alice@tenant-a.example', OLD_PASSWORD).expect(201);
    });

    it('lets only the newest token work', async () => {
      const code = await issuedCode();
      const mailed = await mailedToken();

      await confirm(code).expect(400);
      await confirm(mailed).expect(200);
    });

    it('is void once the password is changed', async () => {
      const code = await issuedCode();
      await request(server())
        .post('/api/v1/auth/change-password')
        .set(
          as({
            sub: aliceId,
            email: 'alice@tenant-a.example',
            roles: ['operator'],
            tenantId: TENANT_A,
          }),
        )
        .send({ currentPassword: OLD_PASSWORD, newPassword: 'Changed3#Password' })
        .expect(201);

      await confirm(code).expect(400);
    });

    it('applies the password rules and history, and keeps the token for another try', async () => {
      const code = await issuedCode();

      await confirm(code, 'short').expect(400);
      const reused = await confirm(code, OLD_PASSWORD).expect(400);
      expect(reused.body.message).toMatch(/Password was used recently/);

      await confirm(code).expect(200);
    });

    it('refuses the token of an account deactivated meanwhile, with the same message', async () => {
      const code = await issuedCode();
      await adminModel.updateOne({ _id: aliceId }, { $set: { isActive: false } });

      const res = await confirm(code).expect(400);

      expect(res.body.message).toBe(
        'This reset link or code is invalid, used or expired. Ask for a new one.',
      );
    });

    it('needs a 64-character code and a password', async () => {
      await confirm('abc').expect(400);
      await request(server())
        .post('/api/v1/auth/password-reset/confirm')
        .send({ token: 'f'.repeat(64) })
        .expect(400);
    });

    it('limits attempts per IP and refuses (503) while the store is down', async () => {
      for (let i = 0; i < LIMITS.PASSWORD_RESET_MAX_PER_IP; i++) {
        await confirm('e'.repeat(64)).expect(400);
      }
      await confirm('e'.repeat(64)).expect(429);

      store.current = createUnavailableSecurityStateStore();
      await confirm('e'.repeat(64)).expect(503);
    });
  });

  describe('GET /auth/password-reset/config', () => {
    it('says whether a link can be mailed and how long a token works', async () => {
      const on = await request(server()).get('/api/v1/auth/password-reset/config').expect(200);
      expect(on.body).toEqual({ byEmail: true, tokenTtlMinutes: 30 });

      mailOff();
      const off = await request(server()).get('/api/v1/auth/password-reset/config').expect(200);
      expect(off.body).toEqual({ byEmail: false, tokenTtlMinutes: 30 });
    });
  });
});
