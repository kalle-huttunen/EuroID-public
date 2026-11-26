import { trustProxySetting } from './trust-proxy';

/**
 * Express's `trust proxy` decides which X-Forwarded-For hops request.ip believes, and the IP rate
 * limits (sign-in, break-glass, password reset) key on request.ip. Trusting a proxy that is not
 * there lets a client pick its own address; TRUST_PROXY sets it per deployment.
 */
describe('trustProxySetting', () => {
  it('trusts one proxy when TRUST_PROXY is unset (the documented reverse proxy setup)', () => {
    expect(trustProxySetting(undefined)).toBe(1);
    expect(trustProxySetting('')).toBe(1);
  });

  it('trusts no proxy for false or 0, so a client cannot choose its address', () => {
    expect(trustProxySetting('false')).toBe(false);
    expect(trustProxySetting('0')).toBe(false);
  });

  it('takes a hop count or a list of proxy addresses', () => {
    expect(trustProxySetting('2')).toBe(2);
    expect(trustProxySetting('10.0.0.0/8, 192.168.1.10')).toBe('10.0.0.0/8, 192.168.1.10');
  });
});
