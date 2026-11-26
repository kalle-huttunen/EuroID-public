/**
 * A SAML sign-in from GET /auth/saml/login to POST /auth/saml/exchange (saml-login-state.ts):
 * the one-time code answers only to the browser that started the sign-in (login CSRF: a victim
 * sent `/auth/saml-callback?code=<attacker's code>` must not be signed in as the attacker), and
 * the page asked for travels through RelayState to the console.
 */
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import {
  MemorySecurityStateStore,
  SECURITY_STATE_STORE,
} from '@infrastructure/cache/security-state.store';
import { Tenant } from '@infrastructure/multi-tenancy/schemas/tenant.schema';
import { AuthLocalService } from './auth-local.service';
import { SamlAuthService } from './saml-auth.service';
import { AdminUser } from './schemas/admin-user.schema';
import { hashBinding, safeReturnPath } from './saml-login-state';

const authorize = jest.fn();
const validate = jest.fn();
jest.mock('@node-saml/node-saml', () => ({
  SAML: jest.fn().mockImplementation(() => ({
    getAuthorizeUrlAsync: (...args: unknown[]) => authorize(...args),
    validatePostResponseAsync: (...args: unknown[]) => validate(...args),
  })),
}));

const SESSION = { access_token: 'at', refresh_token: 'rt' };
let assertionSeq = 0;

describe('SAML sign-in binding and RelayState', () => {
  let service: SamlAuthService;
  let store: MemorySecurityStateStore;
  let config: Record<string, string | undefined>;

  beforeEach(async () => {
    config = {
      SAML_ENTRY_POINT: 'https://idp.example.com/sso',
      SAML_CERT: 'MIIC-test',
      APP_BASE_URL: 'http://localhost:3001',
      NODE_ENV: 'test',
      SAML_AUTO_CREATE_USER: 'true',
      SAML_DEFAULT_TENANT_ID: 'tenant-a',
    };
    store = new MemorySecurityStateStore();
    authorize.mockImplementation(
      async (relayState: string) =>
        `https://idp.example.com/sso?SAMLRequest=x&RelayState=${relayState}`,
    );
    validate.mockImplementation(async () => ({
      profile: {
        email: 'ada@tenant-a.example',
        getAssertionXml: () => `<saml:Assertion ID="_a${++assertionSeq}">`,
      },
    }));
    const existingAdmin = { email: 'ada@tenant-a.example', isActive: true, role: 'viewer' };
    const moduleRef = await Test.createTestingModule({
      providers: [
        SamlAuthService,
        { provide: ConfigService, useValue: { get: (key: string) => config[key] } },
        {
          provide: getModelToken(AdminUser.name),
          useValue: { findOne: async () => existingAdmin },
        },
        {
          provide: getModelToken(Tenant.name),
          useValue: { findOne: () => ({ lean: async () => null }) },
        },
        { provide: AuthLocalService, useValue: { completeSignIn: async () => SESSION } },
        { provide: SECURITY_STATE_STORE, useValue: store },
      ],
    }).compile();
    service = moduleRef.get(SamlAuthService);
  });

  /** The login, then the IdP posting its response back with the RelayState the login sent. */
  async function signIn(returnUrl?: string) {
    const { url, binding } = await service.startLogin(returnUrl);
    const relayState = new URL(url).searchParams.get('RelayState') ?? '';
    const { redirectParams } = await service.handleCallback({
      SAMLResponse: 'signed',
      RelayState: relayState,
    });
    return { binding, relayState, redirectParams };
  }

  describe('the one-time code', () => {
    it('signs in the browser that started the sign-in', async () => {
      const { binding, redirectParams } = await signIn();

      await expect(service.exchangeCode(redirectParams.code, binding)).resolves.toEqual(SESSION);
    });

    it('signs nobody in from a browser without the binding cookie, and is used up', async () => {
      const { binding, redirectParams } = await signIn();

      await expect(service.exchangeCode(redirectParams.code, undefined)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.exchangeCode(redirectParams.code, binding)).rejects.toThrow(
        'Auth code invalid or expired',
      );
    });

    it("signs nobody in from a browser with another sign-in's cookie", async () => {
      const attacker = await signIn();
      const victim = await service.startLogin();

      await expect(
        service.exchangeCode(attacker.redirectParams.code, victim.binding),
      ).rejects.toThrow(/started in another browser/);
    });

    it('keeps only the hash of the binding value in the store', async () => {
      const { url, binding } = await service.startLogin();
      const relayState = new URL(url).searchParams.get('RelayState');

      expect(await store.get(`saml:relay:${relayState}`)).toEqual({
        bindingHash: hashBinding(binding),
      });
    });
  });

  describe('a response without a RelayState this deployment issued', () => {
    it.each([undefined, '', 'not-issued', 'a'.repeat(32)])(
      'is refused for RelayState %j (SP-initiated only, the default)',
      async (relayState) => {
        await expect(
          service.handleCallback({
            SAMLResponse: 'signed',
            ...(relayState !== undefined && { RelayState: relayState }),
          }),
        ).rejects.toThrow(UnauthorizedException);
      },
    );

    it('is refused when its RelayState was used before', async () => {
      const { relayState } = await signIn();

      await expect(
        service.handleCallback({ SAMLResponse: 'signed', RelayState: relayState }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('gets an unbound code with SAML_VALIDATE_IN_RESPONSE_TO=ifPresent (IdP-initiated)', async () => {
      config.SAML_VALIDATE_IN_RESPONSE_TO = 'ifPresent';

      const { redirectParams } = await service.handleCallback({ SAMLResponse: 'signed' });

      await expect(service.exchangeCode(redirectParams.code, undefined)).resolves.toEqual(SESSION);
      expect(redirectParams).not.toHaveProperty('returnUrl');
    });
  });

  describe('the page to return to', () => {
    it('sends node-saml a RelayState id, never the path itself', async () => {
      await service.startLogin('/identities/abc?tab=access');

      const [relayState] = authorize.mock.calls[0];
      expect(relayState).toMatch(/^[0-9a-f]{32}$/);
    });

    it('hands a same-origin path back with the code', async () => {
      const { redirectParams } = await signIn('/identities/abc?tab=access');

      expect(redirectParams.returnUrl).toBe('/identities/abc?tab=access');
    });

    it.each([
      'https://evil.example/x',
      '//evil.example',
      '/\\evil.example',
      '/javascript:alert(1)',
      'identities',
      '/a\nb',
    ])('drops the unsafe return URL %j', async (returnUrl) => {
      const { redirectParams } = await signIn(returnUrl);

      expect(redirectParams).not.toHaveProperty('returnUrl');
    });
  });

  it('safeReturnPath refuses a path longer than 2048 characters', () => {
    expect(safeReturnPath(`/${'a'.repeat(2047)}`)).toBeDefined();
    expect(safeReturnPath(`/${'a'.repeat(2048)}`)).toBeUndefined();
  });
});
