import { THROTTLER_KEY_GENERATOR } from '@nestjs/throttler/dist/throttler.constants';
import { sharedThrottleKey } from '@infrastructure/cache/shared-throttler.storage';
import { SamlAuthController } from './saml-auth.controller';

/**
 * The SAML callback signs people in, like POST /auth/login, so its rate limit is counted across
 * instances (sharedThrottleKey): per-instance counters let a client multiply its attempts by the
 * number of API instances.
 */
describe('SamlAuthController throttling', () => {
  it.each(['short', 'medium'])('counts the callback %s limit across instances', (name) => {
    const handler = SamlAuthController.prototype.callback;
    expect(Reflect.getMetadata(`${THROTTLER_KEY_GENERATOR}${name}`, handler)).toBe(
      sharedThrottleKey,
    );
  });
});

/**
 * The browser's half of a SAML sign-in's binding (saml-login-state.ts): the login sets it as an
 * HttpOnly SameSite cookie on the SAML routes, the exchange hands it to the service and clears it.
 */
describe('SamlAuthController sign-in binding cookie', () => {
  const service = {
    isConfigured: () => true,
    startLogin: jest.fn(async () => ({
      url: 'https://idp.example/sso?RelayState=r',
      binding: 'b1',
    })),
    exchangeCode: jest.fn(async () => ({ mfa_required: true, mfa_token: 'm' })),
  };
  const controller = new SamlAuthController(service as never, { get: () => undefined } as never);
  const response = () => ({
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    redirect: jest.fn(),
  });

  it('sets the binding as an HttpOnly SameSite cookie of the SAML routes at the login', async () => {
    const res = response();

    await controller.login('/identities/x', res as never);

    expect(service.startLogin).toHaveBeenCalledWith('/identities/x');
    expect(res.cookie).toHaveBeenCalledWith(
      'saml_binding',
      'b1',
      expect.objectContaining({ httpOnly: true, sameSite: 'strict', path: '/api/v1/auth/saml' }),
    );
    expect(res.redirect).toHaveBeenCalledWith('https://idp.example/sso?RelayState=r');
  });

  it('hands the cookie to the exchange and clears it', async () => {
    const res = response();

    await controller.exchange(
      { code: 'c1' },
      { cookies: { saml_binding: 'b1' } } as never,
      res as never,
    );

    expect(service.exchangeCode).toHaveBeenCalledWith('c1', 'b1');
    expect(res.clearCookie).toHaveBeenCalledWith(
      'saml_binding',
      expect.objectContaining({ path: '/api/v1/auth/saml' }),
    );
  });
});
