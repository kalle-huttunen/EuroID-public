import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import {
  MemorySecurityStateStore,
  SECURITY_STATE_STORE,
  SecurityStateUnavailableError,
} from '@infrastructure/cache/security-state.store';
import { createUnavailableSecurityStateStore } from '@testing/test-helpers';
import { SamlAuthService, SamlExchangePayload } from './saml-auth.service';
import { AuthLocalService } from './auth-local.service';
import { MfaService } from './mfa.service';
import { AdminUser, AdminUserDocument } from './schemas/admin-user.schema';
import { Tenant } from '@infrastructure/multi-tenancy/schemas/tenant.schema';

jest.mock('@node-saml/node-saml', () => ({
  SAML: jest.fn().mockImplementation(() => ({
    validatePostResponseAsync: jest.fn(),
    getAuthorizeUrlAsync: jest.fn(),
    generateServiceProviderMetadata: jest.fn(),
  })),
}));

// Re-import after mock so we can access the mocked constructor
import { SAML } from '@node-saml/node-saml';

type MockModel = {
  findOne: jest.Mock;
  create: jest.Mock;
};

type MockCache = {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  take: jest.Mock;
  increment: jest.Mock;
};

let assertionSeq = 0;
/** getAssertionXml of a validated profile: an assertion with an ID of its own. */
const nextAssertion = () => {
  const xml = `<saml:Assertion Version="2.0" ID="_assertion-${++assertionSeq}">`;
  return () => xml;
};

describe('SamlAuthService', () => {
  let service: SamlAuthService;
  let configService: jest.Mocked<Pick<ConfigService, 'get'>>;
  let adminModel: MockModel;
  let tenantModel: MockModel;
  let authLocalService: jest.Mocked<Pick<AuthLocalService, 'issueTokensForUser'>>;
  let mfaService: jest.Mocked<Pick<MfaService, 'issueMfaPendingToken'>>;
  let cache: MockCache;

  const defaultConfigMap: Record<string, string | undefined> = {
    SAML_ENTRY_POINT: 'https://idp.example.com/sso',
    SAML_CERT: 'MIIC...fake-cert',
    SAML_ISSUER: 'euroid-sp',
    SAML_CALLBACK_URL: 'http://localhost:3001/api/v1/auth/saml/callback',
    SAML_EMAIL_ATTR: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    SAML_NAME_ATTR: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
    SAML_ROLE_ATTR: '',
    SAML_TENANT_ATTR: '',
    SAML_AUTO_CREATE_USER: 'true',
    SAML_DEFAULT_ROLE: 'viewer',
    SAML_DEFAULT_TENANT_ID: 'test-tenant',
    DEFAULT_TENANT_ID: 'dev-tenant',
    APP_BASE_URL: 'http://localhost:3001',
    NODE_ENV: 'test',
    SAML_WANT_ASSERTIONS_SIGNED: undefined,
    SAML_ACCEPTED_CLOCK_SKEW_MS: '30000',
    SAML_SIGNATURE_ALGORITHM: undefined,
  };

  beforeEach(async () => {
    configService = {
      get: jest.fn((key: string) => defaultConfigMap[key]) as any,
    } as any;

    adminModel = {
      findOne: jest.fn(),
      create: jest.fn(),
    };

    tenantModel = {
      // No tenants document: the default tenant of a single-tenant deployment
      findOne: jest.fn(() => ({ lean: async () => null })),
      create: jest.fn(),
    };

    authLocalService = {
      issueTokensForUser: jest.fn(),
    };

    mfaService = {
      issueMfaPendingToken: jest.fn(),
    };

    // The replay check counts assertion ids in a real in-memory store.
    const replayStore = new MemorySecurityStateStore();
    cache = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      take: jest.fn(),
      increment: jest.fn((key: string, ms: number) => replayStore.increment(key, ms)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SamlAuthService,
        { provide: ConfigService, useValue: configService },
        { provide: getModelToken(AdminUser.name), useValue: adminModel },
        { provide: getModelToken(Tenant.name), useValue: tenantModel },
        { provide: AuthLocalService, useValue: authLocalService },
        { provide: MfaService, useValue: mfaService },
        { provide: SECURITY_STATE_STORE, useValue: cache },
      ],
    }).compile();

    service = module.get<SamlAuthService>(SamlAuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------
  // isConfigured
  // ---------------------------------------------------------------
  describe('isConfigured', () => {
    it('should return true when both SAML_ENTRY_POINT and SAML_CERT are configured', () => {
      const result = service.isConfigured();

      expect(result).toBe(true);
      expect(configService.get).toHaveBeenCalledWith('SAML_ENTRY_POINT');
      expect(configService.get).toHaveBeenCalledWith('SAML_CERT');
    });

    it('should return false when SAML_ENTRY_POINT is missing', () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'SAML_ENTRY_POINT') return undefined;
        return defaultConfigMap[key];
      });

      const result = service.isConfigured();

      expect(result).toBe(false);
    });

    it('should return false when SAML_CERT is missing', () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'SAML_CERT') return undefined;
        return defaultConfigMap[key];
      });

      const result = service.isConfigured();

      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // validateCallback
  // ---------------------------------------------------------------
  describe('validateCallback', () => {
    it('should extract email from SAML profile using configured attribute mapping', async () => {
      const mockSamlInstance = (SAML as jest.Mock).mock.results[0]?.value ?? {
        validatePostResponseAsync: jest.fn(),
      };

      // We need to get the SAML instance that the service creates internally.
      // Since SAML is mocked, each `new SAML(...)` returns the same mock prototype.
      // We override the mock to return a controlled instance for this test.
      const mockValidate = jest.fn().mockResolvedValue({
        profile: {
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'user@example.com',
          nameID: 'user@example.com',
          nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
          getAssertionXml: nextAssertion(),
        },
      });

      (SAML as jest.Mock).mockImplementation(() => ({
        validatePostResponseAsync: mockValidate,
        getAuthorizeUrlAsync: jest.fn(),
        generateServiceProviderMetadata: jest.fn(),
      }));

      const result = await service.validateCallback({ SAMLResponse: 'base64-encoded-response' });

      expect(result.email).toBe('user@example.com');
      expect(result.nameID).toBe('user@example.com');
      expect(mockValidate).toHaveBeenCalledWith({ SAMLResponse: 'base64-encoded-response' });
    });

    it('should throw UnauthorizedException when no email attribute is present in profile', async () => {
      const mockValidate = jest.fn().mockResolvedValue({
        profile: {
          // No email attribute, no nameID, no email field
          someOtherAttr: 'irrelevant',
          nameID: '',
        },
      });

      (SAML as jest.Mock).mockImplementation(() => ({
        validatePostResponseAsync: mockValidate,
        getAuthorizeUrlAsync: jest.fn(),
        generateServiceProviderMetadata: jest.fn(),
      }));

      await expect(
        service.validateCallback({ SAMLResponse: 'base64-encoded-response' }),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        service.validateCallback({ SAMLResponse: 'base64-encoded-response' }),
      ).rejects.toThrow('SAML assertion missing email attribute');
    });

    it('should throw UnauthorizedException when profile is null', async () => {
      const mockValidate = jest.fn().mockResolvedValue({ profile: null });

      (SAML as jest.Mock).mockImplementation(() => ({
        validatePostResponseAsync: mockValidate,
        getAuthorizeUrlAsync: jest.fn(),
        generateServiceProviderMetadata: jest.fn(),
      }));

      await expect(
        service.validateCallback({ SAMLResponse: 'base64-encoded-response' }),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        service.validateCallback({ SAMLResponse: 'base64-encoded-response' }),
      ).rejects.toThrow('SAML assertion validation failed: no profile returned');
    });
  });

  // A captured SAMLResponse was accepted again until NotOnOrAfter; node-saml validated no
  // InResponseTo and kept no assertion ids.
  describe('replay protection', () => {
    const response = (assertionId: string) => ({
      profile: {
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'user@example.com',
        getAssertionXml: () => `<saml2:Assertion ID="${assertionId}" Version="2.0">`,
      },
    });
    const withResponses = (...responses: unknown[]) => {
      const validate = jest.fn();
      responses.forEach((r) => validate.mockResolvedValueOnce(r));
      (SAML as jest.Mock).mockImplementation(() => ({ validatePostResponseAsync: validate }));
    };

    it('refuses an assertion it has accepted before', async () => {
      withResponses(response('_once'), response('_once'), response('_other'));

      await expect(service.validateCallback({ SAMLResponse: 'r' })).resolves.toMatchObject({
        email: 'user@example.com',
      });
      await expect(service.validateCallback({ SAMLResponse: 'r' })).rejects.toThrow(
        'SAML assertion has already been used',
      );
      await expect(service.validateCallback({ SAMLResponse: 'r' })).resolves.toBeDefined();
    });

    it('refuses an assertion without an ID', async () => {
      withResponses({
        profile: { email: 'user@example.com', getAssertionXml: () => '<Assertion Version="2.0">' },
      });

      await expect(service.validateCallback({ SAMLResponse: 'r' })).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('hands node-saml InResponseTo checks against a shared request cache and a maximum assertion age', () => {
      samlInstance();

      service.generateMetadata();

      expect(SAML).toHaveBeenCalledWith(
        expect.objectContaining({
          validateInResponseTo: 'always',
          cacheProvider: expect.any(Object),
          requestIdExpirationPeriodMs: 15 * 60 * 1000,
          maxAssertionAgeMs: 10 * 60 * 1000,
        }),
      );
    });

    it('accepts unsolicited (IdP-initiated) responses only with SAML_VALIDATE_IN_RESPONSE_TO=ifPresent', () => {
      samlInstance();
      configure({ SAML_VALIDATE_IN_RESPONSE_TO: 'ifPresent' });
      service.generateMetadata();
      configure({ SAML_VALIDATE_IN_RESPONSE_TO: 'never' });
      service.generateMetadata();

      const modes = (SAML as jest.Mock).mock.calls.map(([options]) => options.validateInResponseTo);
      expect(modes.slice(-2)).toEqual(['ifPresent', 'always']);
    });
  });

  // ---------------------------------------------------------------
  // findOrCreateUser
  // ---------------------------------------------------------------
  describe('findOrCreateUser', () => {
    const samlProfile = {
      email: 'saml-user@example.com',
      name: 'SAML User',
      nameID: 'saml-user@example.com',
      nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    };

    it('should return existing SAML user when found in database', async () => {
      const existingUser = {
        _id: { toString: () => 'user-id-123' },
        email: 'saml-user@example.com',
        name: 'SAML User',
        role: 'viewer',
        tenantId: 'test-tenant',
        authSource: 'saml',
        isActive: true,
        mfaEnabled: false,
      } as unknown as AdminUserDocument;

      adminModel.findOne.mockResolvedValueOnce(existingUser);

      const result = await service.findOrCreateUser(samlProfile);

      expect(result).toBe(existingUser);
      expect(adminModel.findOne).toHaveBeenCalledWith({
        email: 'saml-user@example.com',
        authSource: 'saml',
      });
      expect(adminModel.create).not.toHaveBeenCalled();
    });

    it('should throw UnauthorizedException when existing SAML user is inactive', async () => {
      const inactiveUser = {
        _id: { toString: () => 'user-id-inactive' },
        email: 'saml-user@example.com',
        authSource: 'saml',
        isActive: false,
      } as unknown as AdminUserDocument;

      // Mock must be set for each findOrCreateUser call since mockResolvedValueOnce is consumed per call
      adminModel.findOne.mockResolvedValueOnce(inactiveUser);
      adminModel.findOne.mockResolvedValueOnce(inactiveUser);

      await expect(service.findOrCreateUser(samlProfile)).rejects.toThrow(UnauthorizedException);
      await expect(service.findOrCreateUser(samlProfile)).rejects.toThrow(
        'Account is disabled. Contact your administrator.',
      );
    });

    it('should JIT provision new user when SAML_AUTO_CREATE_USER is enabled and no existing user found', async () => {
      // First findOne (saml user) returns null
      adminModel.findOne.mockResolvedValueOnce(null);
      // Second findOne (local user check) returns null
      adminModel.findOne.mockResolvedValueOnce(null);

      const createdUser = {
        _id: { toString: () => 'new-user-id' },
        email: 'saml-user@example.com',
        name: 'SAML User',
        role: 'viewer',
        tenantId: 'test-tenant',
        authSource: 'saml',
        isActive: true,
      } as unknown as AdminUserDocument;

      adminModel.create.mockResolvedValueOnce(createdUser);

      const result = await service.findOrCreateUser(samlProfile);

      expect(result).toBe(createdUser);
      // No password hash: a single sign-on admin has no EuroID password.
      expect(adminModel.create).toHaveBeenCalledWith({
        email: 'saml-user@example.com',
        name: 'SAML User',
        role: 'viewer',
        tenantId: 'test-tenant',
        authSource: 'saml',
        isActive: true,
      });
    });

    it('should throw UnauthorizedException when a local user exists with the same email', async () => {
      const localUser = {
        _id: { toString: () => 'local-user-id' },
        email: 'saml-user@example.com',
        authSource: 'local',
        isActive: true,
      } as unknown as AdminUserDocument;

      // Set up mocks for both findOrCreateUser calls (each consumes 2 findOne calls)
      // Call 1: saml lookup → null, local lookup → localUser
      adminModel.findOne.mockResolvedValueOnce(null);
      adminModel.findOne.mockResolvedValueOnce(localUser);
      // Call 2: saml lookup → null, local lookup → localUser
      adminModel.findOne.mockResolvedValueOnce(null);
      adminModel.findOne.mockResolvedValueOnce(localUser);

      await expect(service.findOrCreateUser(samlProfile)).rejects.toThrow(UnauthorizedException);
      await expect(service.findOrCreateUser(samlProfile)).rejects.toThrow(
        'An account with this email already exists with local authentication',
      );

      // Verify the second findOne checked for local auth
      expect(adminModel.findOne).toHaveBeenCalledWith({
        email: 'saml-user@example.com',
        authSource: 'local',
      });
    });

    it('should throw UnauthorizedException when SAML_AUTO_CREATE_USER is disabled and no user exists', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'SAML_AUTO_CREATE_USER') return 'false';
        if (key === 'NODE_ENV') return 'test';
        return defaultConfigMap[key];
      });

      // First findOne (saml user) returns null
      adminModel.findOne.mockResolvedValueOnce(null);
      // Second findOne (local user check) returns null
      adminModel.findOne.mockResolvedValueOnce(null);

      await expect(service.findOrCreateUser(samlProfile)).rejects.toThrow(UnauthorizedException);
      await expect(service.findOrCreateUser(samlProfile)).rejects.toThrow(
        'Automatic user provisioning is disabled for SAML',
      );
      expect(adminModel.create).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // exchangeCode
  // ---------------------------------------------------------------
  describe('exchangeCode', () => {
    it('should return the cached payload for a valid code, read and deleted in one step', async () => {
      const expectedPayload: SamlExchangePayload = {
        access_token: 'at-123',
        refresh_token: 'rt-456',
        user: {
          id: 'user-id',
          email: 'user@example.com',
          name: 'Test User',
          role: 'viewer',
          tenantId: 'test-tenant',
        },
      };

      // An unbound code (an IdP-initiated sign-in); the binding: saml-login-binding.spec.ts
      cache.take.mockResolvedValueOnce({ payload: expectedPayload });

      const result = await service.exchangeCode('valid-code-hex');

      expect(result).toEqual(expectedPayload);
      expect(cache.take).toHaveBeenCalledWith('saml:auth:valid-code-hex');
      // No separate read and delete: between them a second exchange could read the code too.
      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('should throw UnauthorizedException for invalid or expired code', async () => {
      cache.take.mockResolvedValue(undefined);

      await expect(service.exchangeCode('expired-code')).rejects.toThrow(UnauthorizedException);
      await expect(service.exchangeCode('expired-code')).rejects.toThrow(
        'Auth code invalid or expired',
      );
    });

    it('should throw UnauthorizedException when code is empty string', async () => {
      await expect(service.exchangeCode('')).rejects.toThrow(UnauthorizedException);
      await expect(service.exchangeCode('')).rejects.toThrow('Invalid or missing auth code');
    });

    it('should return MFA-required payload when cached payload contains mfa_required', async () => {
      const mfaPayload: SamlExchangePayload = {
        mfa_required: true,
        mfa_token: 'mfa-pending-jwt',
      };

      cache.take.mockResolvedValueOnce({ payload: mfaPayload });

      const result = await service.exchangeCode('mfa-code');

      expect(result).toEqual(mfaPayload);
      expect(result.mfa_required).toBe(true);
      expect(result.mfa_token).toBe('mfa-pending-jwt');
      expect(cache.take).toHaveBeenCalledWith('saml:auth:mfa-code');
    });

    it('redeems a code once when two exchanges of it run at the same time (no replay)', async () => {
      // The real in-process store behind every store call the service could make.
      const store = new MemorySecurityStateStore();
      cache.get.mockImplementation((key: string) => store.get(key));
      cache.del.mockImplementation((key: string) => store.del(key));
      cache.take.mockImplementation((key: string) => store.take(key));
      await store.set('saml:auth:raced-code', { payload: { access_token: 'at-123' } }, 60_000);

      const results = await Promise.allSettled([
        service.exchangeCode('raced-code'),
        service.exchangeCode('raced-code'),
      ]);

      const redeemed = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r) => r.status === 'rejected');
      expect(redeemed).toEqual([{ status: 'fulfilled', value: { access_token: 'at-123' } }]);
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(UnauthorizedException);
    });

    describe('while the code store is down', () => {
      const down = createUnavailableSecurityStateStore();

      it('refuses with 503, never handing out tokens for a code it could not use up', async () => {
        cache.take.mockImplementation((key: string) => down.take(key));

        await expect(service.exchangeCode('valid-code-hex')).rejects.toBeInstanceOf(
          SecurityStateUnavailableError,
        );
      });
    });
  });

  /** The configuration of the test with `overrides` (a key set to undefined is unset). */
  const configure = (overrides: Record<string, string | undefined>) =>
    configService.get.mockImplementation((key: string) =>
      key in overrides ? overrides[key] : defaultConfigMap[key],
    );

  const samlInstance = (profile: Record<string, string> = {}) =>
    (SAML as jest.Mock).mockImplementation(() => ({
      validatePostResponseAsync: jest
        .fn()
        .mockResolvedValue({ profile: { ...profile, getAssertionXml: nextAssertion() } }),
      getAuthorizeUrlAsync: jest
        .fn()
        .mockResolvedValue('https://idp.example.com/sso?SAMLRequest=x'),
      generateServiceProviderMetadata: jest.fn().mockReturnValue('<EntityDescriptor/>'),
    }));

  /** A first SAML sign-in whose assertion carries `attributes`: the admin it creates. */
  async function provision(attributes: Record<string, string>) {
    samlInstance({
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'new@idp.example',
      nameID: 'new@idp.example',
      ...attributes,
    });
    adminModel.findOne.mockResolvedValue(null);
    adminModel.create.mockImplementation(async (doc: object) => doc);

    await service.findOrCreateUser(await service.validateCallback({ SAMLResponse: 'signed' }));
    expect(adminModel.create).toHaveBeenCalledTimes(1);
    return adminModel.create.mock.calls[0][0] as { role: string; tenantId: string };
  }

  // ---------------------------------------------------------------
  // IdP attributes of a JIT-provisioned admin: the deployment decides whether the IdP names the
  // role (SAML_ROLE_ATTR) and the tenant (SAML_TENANT_ATTR)
  // ---------------------------------------------------------------
  describe('the role and tenant of a JIT-provisioned admin', () => {
    it('takes the role from the attribute SAML_ROLE_ATTR names, up to SAML_JIT_MAX_ROLE', async () => {
      configure({ SAML_ROLE_ATTR: 'role', SAML_JIT_MAX_ROLE: 'connector-admin' });

      expect((await provision({ role: 'operator' })).role).toBe('operator');
    });

    it('never creates a super-admin, whatever the IdP asserts (saml-jit-policy.spec.ts)', async () => {
      configure({ SAML_ROLE_ATTR: 'role', SAML_JIT_MAX_ROLE: 'connector-admin' });

      expect((await provision({ role: 'super-admin' })).role).toBe('connector-admin');
    });

    it('ignores a role attribute while SAML_ROLE_ATTR is not set', async () => {
      configure({
        SAML_ROLE_ATTR: undefined,
        SAML_DEFAULT_ROLE: 'operator',
        SAML_JIT_MAX_ROLE: 'operator',
      });

      expect((await provision({ role: 'super-admin' })).role).toBe('operator');
    });

    it.each(['root', 'platform-admin', 'Super-Admin', ''])(
      'gives SAML_DEFAULT_ROLE for the role %j, which is not a tenant role',
      async (role) => {
        configure({
          SAML_ROLE_ATTR: 'role',
          SAML_DEFAULT_ROLE: 'operator',
          SAML_JIT_MAX_ROLE: 'operator',
        });

        expect((await provision({ role })).role).toBe('operator');
      },
    );

    it('takes the tenant from the attribute SAML_TENANT_ATTR names when it is allow-listed and active', async () => {
      configure({ SAML_TENANT_ATTR: 'tenant', SAML_ALLOWED_TENANT_IDS: 'tenant-x' });
      tenantModel.findOne.mockReturnValue({ lean: async () => ({ status: 'active' }) });

      expect((await provision({ tenant: 'tenant-x' })).tenantId).toBe('tenant-x');
      expect(tenantModel.findOne).toHaveBeenCalledWith({ tenantId: 'tenant-x' }, 'status');
    });

    it.each<[string, string | undefined, { status: string } | null]>([
      ['not allow-listed', undefined, { status: 'active' }],
      ['not a tenant', 'tenant-x', null],
      ['suspended', 'tenant-x', { status: 'suspended' }],
    ])('creates no admin in a tenant the assertion names that is %s', async (_c, list, doc) => {
      configure({ SAML_TENANT_ATTR: 'tenant', SAML_ALLOWED_TENANT_IDS: list });
      tenantModel.findOne.mockReturnValue({ lean: async () => doc });

      await expect(provision({ tenant: 'tenant-x' })).rejects.toThrow(UnauthorizedException);
      expect(adminModel.create).not.toHaveBeenCalled();
    });

    it("never raises an existing admin's role from the assertion", async () => {
      configure({ SAML_ROLE_ATTR: 'role', SAML_JIT_MAX_ROLE: 'connector-admin' });
      samlInstance({ email: 'known@idp.example', role: 'connector-admin' });
      const existing = {
        email: 'known@idp.example',
        role: 'viewer',
        isActive: true,
        save: jest.fn(),
      };
      adminModel.findOne.mockResolvedValue(existing);

      const user = await service.findOrCreateUser(
        await service.validateCallback({ SAMLResponse: 'signed' }),
      );

      expect(user.role).toBe('viewer');
      expect(existing.save).not.toHaveBeenCalled();
      expect(adminModel.create).not.toHaveBeenCalled();
    });

    it('ignores a tenant attribute while SAML_TENANT_ATTR is not set', async () => {
      configure({ SAML_TENANT_ATTR: undefined });

      expect((await provision({ tenant: 'tenant-x' })).tenantId).toBe('test-tenant');
    });
  });

  // ---------------------------------------------------------------
  // Outside development and test (production, staging, an unset NODE_ENV): signed assertions,
  // SHA-2 signatures, JIT only by opt-in
  // ---------------------------------------------------------------
  describe.each<[string, string | undefined]>([
    ['production', 'production'],
    ['staging', 'staging'],
    ['an unset NODE_ENV', undefined],
  ])('in %s', (_name, nodeEnv) => {
    const production = (overrides: Record<string, string | undefined> = {}) =>
      configure({ NODE_ENV: nodeEnv, ...overrides });

    beforeEach(() => {
      samlInstance();
      (SAML as jest.Mock).mockClear();
    });

    it('refuses SAML_WANT_ASSERTIONS_SIGNED=false before talking to any IdP', async () => {
      production({ SAML_WANT_ASSERTIONS_SIGNED: 'false' });

      await expect(service.startLogin()).rejects.toThrow(
        'SAML_WANT_ASSERTIONS_SIGNED cannot be false outside development and test',
      );
      await expect(service.validateCallback({ SAMLResponse: 'signed' })).rejects.toThrow(
        'SAML_WANT_ASSERTIONS_SIGNED cannot be false outside development and test',
      );
      expect(SAML).not.toHaveBeenCalled();
    });

    it.each<[string | undefined, string]>([
      [undefined, 'sha256'],
      ['sha1', 'sha256'],
      ['sha512', 'sha512'],
    ])(
      'hands node-saml signed assertions and, for SAML_SIGNATURE_ALGORITHM %s, %s',
      (configured, used) => {
        production({
          SAML_WANT_ASSERTIONS_SIGNED: undefined,
          SAML_SIGNATURE_ALGORITHM: configured,
        });

        service.generateMetadata();

        expect(SAML).toHaveBeenCalledWith(
          expect.objectContaining({ wantAssertionsSigned: true, signatureAlgorithm: used }),
        );
      },
    );

    it.each<[string | undefined]>([[undefined], ['false']])(
      'creates no admin on a first sign-in when SAML_AUTO_CREATE_USER is %s',
      async (autoCreate) => {
        production({ SAML_AUTO_CREATE_USER: autoCreate });

        await expect(provision({})).rejects.toThrow(
          'Automatic user provisioning is disabled for SAML',
        );
        expect(adminModel.create).not.toHaveBeenCalled();
      },
    );

    it('creates the admin on a first sign-in when SAML_AUTO_CREATE_USER=true', async () => {
      production({ SAML_AUTO_CREATE_USER: 'true' });

      expect(await provision({})).toMatchObject({ role: 'viewer', tenantId: 'test-tenant' });
    });
  });
});
