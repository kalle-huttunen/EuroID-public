import type { CacheItem, CacheProvider } from '@node-saml/node-saml';
import type { SecurityStateStore } from '@infrastructure/cache/security-state.store';

/**
 * node-saml's request id cache (InResponseTo) in the security state store, so the callback
 * finds a request an AuthnRequest of another API instance sent. node-saml's default keeps them
 * in the process. A store failure rejects, so the response is refused (fails closed).
 */
export class SecurityStateSamlCache implements CacheProvider {
  constructor(
    private readonly store: SecurityStateStore,
    private readonly ttlMs: number,
  ) {}

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    await this.store.set(`saml:request:${key}`, value, this.ttlMs);
    return { value, createdAt: Date.now() };
  }

  async getAsync(key: string): Promise<string | null> {
    return (await this.store.get<string>(`saml:request:${key}`)) ?? null;
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (!key) return null;
    await this.store.del(`saml:request:${key}`);
    return key;
  }
}

/** The ID attribute of the assertion node-saml validated, or null. */
export function assertionIdOf(profile: { getAssertionXml?: () => string }): string | null {
  const xml = profile.getAssertionXml?.() ?? '';
  const match = /<(?:[\w-]+:)?Assertion\b[^>]*?\sID="([^"]+)"/.exec(xml);
  return match ? match[1] : null;
}
