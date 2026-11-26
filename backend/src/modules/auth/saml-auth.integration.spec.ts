/**
 * The SAML callback on in-memory MongoDB with the real AdminUser and Tenant models (only the IdP
 * response is stubbed): a first SAML sign-in provisions an admin that has no EuroID password,
 * a password sign-in or change for that admin is refused without comparing anything, and a SAML
 * sign-in passes the same MFA gate as a password sign-in.
 */
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { closeTestDb, testDbUri } from '@testing/test-db';
import { Model } from 'mongoose';
import * as argon2 from 'argon2';
import {
  MemorySecurityStateStore,
  SECURITY_STATE_STORE,
} from '@infrastructure/cache/security-state.store';
import { Tenant, TenantSchema } from '@infrastructure/multi-tenancy/schemas/tenant.schema';
import { MachineIdentitySyncService } from '../identity/machine-identity-sync.service';
import { AuthLocalService } from './auth-local.service';
import { InviteService } from './invite.service';
import { MfaService } from './mfa.service';
import * as passwordHashing from './password-hashing';
import { SamlAuthService } from './saml-auth.service';
import { AdminUser, AdminUserDocument, AdminUserSchema } from './schemas/admin-user.schema';

const mockValidatePostResponse = jest.fn();
jest.mock('@node-saml/node-saml', () => ({
  SAML: jest.fn().mockImplementation(() => ({
    validatePostResponseAsync: (body: unknown) => mockValidatePostResponse(body),
    getAuthorizeUrlAsync: async (relayState: string) =>
      `https://idp.example.com/sso?RelayState=${relayState}`,
  })),
}));

const TENANT = 'tenant-a';
const EMAIL_ATTR = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress';
const PASSWORD = 'ValidPass1!xx';

/** The claims of a token this test's jose stand-in signed (header.payload.signature). */
const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as Record<string, unknown>;

describe('SAML sign-in (in-memory MongoDB, real models)', () => {
  let moduleRef: TestingModule;
  let saml: SamlAuthService;
  let authLocal: AuthLocalService;
  let adminModel: Model<AdminUserDocument>;
  let tenantModel: Model<Tenant>;
  const mfa = { issueMfaPendingToken: jest.fn(async () => 'mfa-pending-token') };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_SECRET: 'test-jwt-secret-thats-at-least-32chars-long',
              NODE_ENV: 'test',
              APP_BASE_URL: 'http://localhost:3001',
              SAML_ENTRY_POINT: 'https://idp.example.com/sso',
              SAML_CERT: 'MIIC-test-cert',
              SAML_AUTO_CREATE_USER: 'true',
              SAML_DEFAULT_TENANT_ID: TENANT,
            }),
          ],
        }),
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: AdminUser.name, schema: AdminUserSchema },
          { name: Tenant.name, schema: TenantSchema },
        ]),
      ],
      providers: [
        SamlAuthService,
        AuthLocalService,
        { provide: MfaService, useValue: mfa },
        { provide: MachineIdentitySyncService, useValue: {} },
        { provide: InviteService, useValue: {} },
        { provide: SECURITY_STATE_STORE, useValue: new MemorySecurityStateStore() },
      ],
    }).compile();

    saml = moduleRef.get(SamlAuthService);
    authLocal = moduleRef.get(AuthLocalService);
    adminModel = moduleRef.get(getModelToken(AdminUser.name));
    tenantModel = moduleRef.get(getModelToken(Tenant.name));
  });

  afterEach(async () => {
    await adminModel.deleteMany({});
    await tenantModel.deleteMany({});
    mfa.issueMfaPendingToken.mockClear();
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  /** A SAML login, its callback for `email`, then the code exchange the frontend makes. */
  async function samlSignIn(email: string) {
    const { url, binding } = await saml.startLogin();
    const relayState = new URL(url).searchParams.get('RelayState') ?? '';
    mockValidatePostResponse.mockResolvedValueOnce({
      profile: {
        [EMAIL_ATTR]: email,
        nameID: email,
        getAssertionXml: () => `<saml:Assertion ID="_${Math.random().toString(36).slice(2)}">`,
      },
    });
    const { redirectParams } = await saml.handleCallback({
      SAMLResponse: 'signed-response',
      RelayState: relayState,
    });
    return saml.exchangeCode(redirectParams.code, binding);
  }

  const stored = (email: string) => adminModel.findOne({ email }).lean();

  describe('first SAML sign-in (JIT provisioning)', () => {
    it('creates a single sign-on admin without any password hash and signs them in', async () => {
      const payload = await samlSignIn('new.sso@tenant-a.example');

      expect(payload.access_token).toEqual(expect.any(String));
      expect(payload.refresh_token).toEqual(expect.any(String));
      const admin = await stored('new.sso@tenant-a.example');
      expect(admin).toMatchObject({ authSource: 'saml', tenantId: TENANT, role: 'viewer' });
      expect(admin).not.toHaveProperty('passwordHash');
      expect(admin?.passwordHistory).toEqual([]);
    });

    it('the next SAML sign-in finds the same admin', async () => {
      await samlSignIn('again.sso@tenant-a.example');
      await samlSignIn('again.sso@tenant-a.example');

      expect(await adminModel.countDocuments({ email: 'again.sso@tenant-a.example' })).toBe(1);
    });
  });

  describe('a single sign-on admin has no EuroID password', () => {
    it('refuses a password sign-in and compares no password', async () => {
      await samlSignIn('pw.sso@tenant-a.example');
      const verify = jest.spyOn(passwordHashing, 'verifyPassword');

      const error = await authLocal
        .login({ email: 'pw.sso@tenant-a.example', password: PASSWORD })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as Error).message).toMatch(/uses SSO/);
      expect(verify).not.toHaveBeenCalled();
      verify.mockRestore();
    });

    it('refuses a password change (409) and stores no password', async () => {
      await samlSignIn('change.sso@tenant-a.example');
      const id = String((await stored('change.sso@tenant-a.example'))!._id);

      const error = await authLocal.changePassword(id, PASSWORD, `${PASSWORD}2`).catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toMatch(/single sign-on/);
      expect(await stored('change.sso@tenant-a.example')).not.toHaveProperty('passwordHash');
    });
  });

  describe('the MFA gate', () => {
    it('a tenant that requires MFA: the admin without MFA gets the setup-only token, no session', async () => {
      await tenantModel.create({
        tenantId: TENANT,
        name: 'Tenant A',
        settings: { mfaRequired: true },
      });

      const payload = await samlSignIn('enrol.sso@tenant-a.example');

      expect(payload.mfa_enrollment_required).toBe(true);
      expect(payload.access_token).toBeUndefined();
      expect(payload.refresh_token).toBeUndefined();
      expect(claimsOf(payload.mfa_enrollment_token as string)).toMatchObject({
        scope: 'mfa-enrollment',
        roles: [],
      });
      const admin = await stored('enrol.sso@tenant-a.example');
      expect(admin?.refreshTokenHash).toBeUndefined();
      expect(admin?.lastLoginAt).toBeUndefined();
    });

    it('answers the same fields as a password sign-in of the same tenant', async () => {
      await tenantModel.create({
        tenantId: TENANT,
        name: 'Tenant A',
        settings: { mfaRequired: true },
      });
      await adminModel.create({
        email: 'local@tenant-a.example',
        name: 'Local Admin',
        passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
        tenantId: TENANT,
      });

      const password = await authLocal.login({
        email: 'local@tenant-a.example',
        password: PASSWORD,
      });
      const sso = await samlSignIn('same.sso@tenant-a.example');

      expect(Object.keys(sso).sort()).toEqual(Object.keys(password).sort());
    });

    it('an admin with MFA on gets the MFA step, no session', async () => {
      await samlSignIn('mfa.sso@tenant-a.example');
      await adminModel.updateOne({ email: 'mfa.sso@tenant-a.example' }, { mfaEnabled: true });

      const payload = await samlSignIn('mfa.sso@tenant-a.example');

      expect(payload).toEqual({ mfa_required: true, mfa_token: 'mfa-pending-token' });
    });
  });
});
