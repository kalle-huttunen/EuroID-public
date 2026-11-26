import type { Response } from 'express';
import { setAuthCookies } from './auth-cookies';

/** The session cookies go over HTTPS only, everywhere but development and test. */
describe('setAuthCookies', () => {
  const saved = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = saved;
  });

  const secureFlags = () => {
    const cookie = jest.fn();
    setAuthCookies({ cookie } as unknown as Response, 'access', 'refresh');
    return cookie.mock.calls.map(([, , options]) => (options as { secure: boolean }).secure);
  };

  it.each(['production', 'staging', 'pre-prod'])('sets secure cookies in %s', (nodeEnv) => {
    process.env.NODE_ENV = nodeEnv;
    expect(secureFlags()).toEqual([true, true]);
  });

  it('sets secure cookies when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV;
    expect(secureFlags()).toEqual([true, true]);
  });

  it('leaves secure off in development, for http://localhost', () => {
    process.env.NODE_ENV = 'development';
    expect(secureFlags()).toEqual([false, false]);
  });
});
