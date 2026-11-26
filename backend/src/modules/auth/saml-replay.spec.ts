import { MemorySecurityStateStore } from '@infrastructure/cache/security-state.store';
import { assertionIdOf, SecurityStateSamlCache } from './saml-replay';

/**
 * node-saml keeps the ids of the AuthnRequests it sent so a response can be matched to one
 * (InResponseTo). Kept in the security state store, they are shared by every API instance: the
 * callback may reach another instance than the login.
 */
describe('SecurityStateSamlCache', () => {
  it('keeps a request id for its lifetime, shared through the store, and forgets it on remove', async () => {
    const store = new MemorySecurityStateStore();
    const login = new SecurityStateSamlCache(store, 60_000);
    const callback = new SecurityStateSamlCache(store, 60_000); // another instance, same store

    const saved = await login.saveAsync('_req1', '2026-11-25T10:00:00.000Z');

    expect(saved).toEqual({ value: '2026-11-25T10:00:00.000Z', createdAt: expect.any(Number) });
    await expect(callback.getAsync('_req1')).resolves.toBe('2026-11-25T10:00:00.000Z');
    await expect(callback.removeAsync('_req1')).resolves.toBe('_req1');
    await expect(login.getAsync('_req1')).resolves.toBeNull();
    await expect(callback.getAsync('_unknown')).resolves.toBeNull();
    await expect(callback.removeAsync(null)).resolves.toBeNull();
  });
});

describe('assertionIdOf', () => {
  it('reads the ID of the assertion, prefixed or not', () => {
    expect(
      assertionIdOf({
        getAssertionXml: () =>
          '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" Version="2.0" ID="_abc123" IssueInstant="2026-11-25T10:00:00Z">',
      }),
    ).toBe('_abc123');
    expect(
      assertionIdOf({ getAssertionXml: () => '<Assertion ID="_x9"><Issuer/></Assertion>' }),
    ).toBe('_x9');
  });

  it('is null without an assertion or an ID', () => {
    expect(assertionIdOf({})).toBeNull();
    expect(assertionIdOf({ getAssertionXml: () => '<saml:Assertion Version="2.0">' })).toBeNull();
  });
});
