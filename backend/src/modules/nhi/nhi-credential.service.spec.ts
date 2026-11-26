import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from 'crypto';
import { ConflictException, BadRequestException } from '@nestjs/common';

import { NhiCredentialService, canonicalCredentialPayload } from './nhi-credential.service';
import { DomainEventType } from '@infrastructure/events/event-types';

function makeKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

function makeConfig(env: Record<string, string | undefined>) {
  return { get: jest.fn((key: string) => env[key]) } as any;
}

function makeDoc(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    agentId: 'agent-a',
    tenantId: 't',
    scope: ['hr:read', 'entra:read'],
    status: 'active' as string,
    killSwitchEngaged: false,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    credentialFingerprint: undefined as string | undefined,
    lastRotatedAt: undefined as Date | undefined,
    save: jest.fn().mockImplementation(function (this: unknown) {
      return Promise.resolve(this);
    }),
    ...overrides,
  };
}

/** NhiService as the credential service uses it: get() answers the agent as stored (or null). */
function makeNhi(doc: ReturnType<typeof makeDoc> | null) {
  return {
    mustGet: jest.fn().mockResolvedValue(doc),
    get: jest.fn().mockResolvedValue(doc),
  } as any;
}

function makeEvents() {
  return { emit: jest.fn() } as any;
}

function signingService(doc = makeDoc(), privatePem = makeKeypair().privatePem) {
  const nhi = makeNhi(doc);
  const svc = new NhiCredentialService(
    makeConfig({ NHI_SIGNING_PRIVATE_KEY: privatePem }),
    nhi,
    makeEvents(),
  );
  return { svc, nhi, doc };
}

describe('NhiCredentialService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is disabled when no signing key is configured', () => {
    const svc = new NhiCredentialService(makeConfig({}), makeNhi(makeDoc()), makeEvents());
    expect(svc.isEnabled()).toBe(false);
  });

  it('refuses to issue when disabled', async () => {
    const svc = new NhiCredentialService(makeConfig({}), makeNhi(makeDoc()), makeEvents());
    await expect(svc.issue('t', 'agent-a', 300, 'alice')).rejects.toThrow(ConflictException);
  });

  it('issues a signed credential that verifies while its agent is active', async () => {
    const { privatePem } = makeKeypair();
    const doc = makeDoc();
    const events = makeEvents();
    const svc = new NhiCredentialService(
      makeConfig({ NHI_SIGNING_PRIVATE_KEY: privatePem }),
      makeNhi(doc),
      events,
    );

    const cred = await svc.issue('t', 'agent-a', 300, 'alice');
    expect(cred.algorithm).toBe('ed25519');
    expect(cred.payload.spiffeId).toMatch(
      /^spiffe:\/\/euroid\.local\/tenants\/t\/agents\/agent-a$/,
    );
    expect(cred.signature).toMatch(/^[0-9a-f]+$/);
    expect(await svc.verify('t', cred)).toEqual({
      active: true,
      agentId: 'agent-a',
      scope: cred.payload.scope,
      expiresAt: cred.payload.expiresAt,
    });
    expect(doc.save).toHaveBeenCalled();
    expect(doc.credentialFingerprint).toBeTruthy();
    expect(doc.lastRotatedAt).toBeInstanceOf(Date);
    expect(events.emit).toHaveBeenCalledWith(
      DomainEventType.NHI_CREDENTIAL_ISSUED,
      'agent-a',
      expect.objectContaining({ agentId: 'agent-a' }),
      expect.anything(),
    );
  });

  it('rejects a tampered payload', async () => {
    const { svc } = signingService();
    const cred = await svc.issue('t', 'agent-a', 300, 'alice');
    const tampered = { ...cred, payload: { ...cred.payload, scope: ['admin:*'] } };
    expect(await svc.verify('t', tampered)).toEqual({ active: false, reason: 'invalid signature' });
  });

  it('clamps TTL to the agent expiresAt when shorter', async () => {
    const { privatePem } = makeKeypair();
    const doc = makeDoc({ expiresAt: new Date(Date.now() + 60 * 1000) }); // 60s
    const svc = new NhiCredentialService(
      makeConfig({ NHI_SIGNING_PRIVATE_KEY: privatePem }),
      makeNhi(doc),
      makeEvents(),
    );
    const cred = await svc.issue('t', 'agent-a', 3600, 'alice'); // 1h requested
    const ttl = (new Date(cred.payload.expiresAt).getTime() - Date.now()) / 1000;
    expect(ttl).toBeLessThanOrEqual(60 + 1);
  });

  it('refuses to issue when agent is revoked', async () => {
    const { privatePem } = makeKeypair();
    const doc = makeDoc({ status: 'revoked' });
    const svc = new NhiCredentialService(
      makeConfig({ NHI_SIGNING_PRIVATE_KEY: privatePem }),
      makeNhi(doc),
      makeEvents(),
    );
    await expect(svc.issue('t', 'agent-a', 300, 'alice')).rejects.toThrow(ConflictException);
  });

  it('refuses to issue when kill-switch engaged (even if status appears active)', async () => {
    const { privatePem } = makeKeypair();
    const doc = makeDoc({ killSwitchEngaged: true });
    const svc = new NhiCredentialService(
      makeConfig({ NHI_SIGNING_PRIVATE_KEY: privatePem }),
      makeNhi(doc),
      makeEvents(),
    );
    await expect(svc.issue('t', 'agent-a', 300, 'alice')).rejects.toThrow(/kill-switch/);
  });

  it('refuses zero / over-cap TTL', async () => {
    const { privatePem } = makeKeypair();
    const svc = new NhiCredentialService(
      makeConfig({ NHI_SIGNING_PRIVATE_KEY: privatePem }),
      makeNhi(makeDoc()),
      makeEvents(),
    );
    await expect(svc.issue('t', 'agent-a', 0, 'alice')).rejects.toThrow(BadRequestException);
    await expect(svc.issue('t', 'agent-a', 999999, 'alice')).rejects.toThrow(BadRequestException);
  });

  it('canonical payload is field-order stable', () => {
    const p1 = {
      spiffeId: 'spiffe://x/t/agents/a',
      agentId: 'a',
      tenantId: 't',
      scope: ['a', 'b'],
      issuedAt: '2026-04-17T00:00:00.000Z',
      expiresAt: '2026-04-17T01:00:00.000Z',
    };
    const p2 = {
      issuedAt: p1.issuedAt,
      scope: ['b', 'a'],
      tenantId: p1.tenantId,
      spiffeId: p1.spiffeId,
      agentId: p1.agentId,
      expiresAt: p1.expiresAt,
    };
    expect(canonicalCredentialPayload(p1)).toBe(canonicalCredentialPayload(p2));
  });

  it('refuses verification when expired', async () => {
    const { svc } = signingService();
    const cred = await svc.issue('t', 'agent-a', 300, 'alice');
    // The credential as issued, read 301 seconds later
    const later = Date.now() + 301 * 1000;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    expect(await svc.verify('t', cred)).toEqual({ active: false, reason: 'credential expired' });
  });

  // It verified until its own expiry (at most 1 h), whatever happened to the agent
  it.each([
    ['revoked', { status: 'revoked' }, 'agent revoked'],
    ['killed', { status: 'revoked', killSwitchEngaged: true }, 'kill switch engaged'],
    ['expired', { status: 'expired' }, 'agent expired'],
  ])('refuses the credential of an agent %s after issue', async (_, change, reason) => {
    const { svc, doc, nhi } = signingService();
    const cred = await svc.issue('t', 'agent-a', 300, 'alice');
    Object.assign(doc, change);

    expect(await svc.verify('t', cred)).toEqual({ active: false, reason });
    expect(nhi.get).toHaveBeenCalledWith('t', 'agent-a');
  });

  // HX-G follow-up: an agent whose owner left kept getting credentials. Decision: an ownerless
  // agent gets none until someone gives it a new owner or revokes it, but a credential issued
  // before keeps verifying, so an integration does not break silently.
  it('refuses a new credential for an ownerless agent, and still verifies one issued before', async () => {
    const { svc, doc } = signingService();
    const before = await svc.issue('t', 'agent-a', 300, 'alice');
    Object.assign(doc, { ownerlessSince: new Date(), ownerlessReason: 'offboarded' });

    await expect(svc.issue('t', 'agent-a', 300, 'alice')).rejects.toThrow(
      /has no owner.*new owner or revoke/,
    );
    expect((await svc.verify('t', before)).active).toBe(true);
  });

  it('refuses the credential of an agent that is not found in the tenant', async () => {
    const { svc, nhi } = signingService();
    const cred = await svc.issue('t', 'agent-a', 300, 'alice');
    nhi.get.mockResolvedValue(null);
    expect(await svc.verify('t', cred)).toEqual({ active: false, reason: 'agent not found' });
  });

  it('refuses a credential issued for another tenant without reading its agent', async () => {
    const { svc, nhi } = signingService();
    const cred = await svc.issue('t', 'agent-a', 300, 'alice');

    expect(await svc.verify('u', cred)).toEqual({
      active: false,
      reason: 'issued for another tenant',
    });
    expect(nhi.get).not.toHaveBeenCalled();
  });

  it('refuses what this key did not sign, and anything without a key', async () => {
    const { svc } = signingService();
    const cred = await svc.issue('t', 'agent-a', 300, 'alice');
    const other = signingService().svc;
    const unsigned = new NhiCredentialService(makeConfig({}), makeNhi(makeDoc()), makeEvents());

    expect(await other.verify('t', cred)).toEqual({
      active: false,
      reason: 'signed with another key',
    });
    expect(await unsigned.verify('t', cred)).toEqual({
      active: false,
      reason: 'credential signing is not configured',
    });
    expect(await svc.verify('t', { ...cred, algorithm: 'none' })).toEqual({
      active: false,
      reason: 'unsupported algorithm',
    });
    // Buffer.from(hex) stops at the first non-hex character: the signature must be exact
    expect(await svc.verify('t', { ...cred, signature: `${cred.signature}zz` })).toEqual({
      active: false,
      reason: 'malformed signature',
    });
  });

  it('publishes the public key that checks a credential offline', async () => {
    const { svc } = signingService();
    const cred = await svc.issue('t', 'agent-a', 300, 'alice');

    const published = svc.publicKey();
    expect(published).toMatchObject({
      algorithm: 'ed25519',
      keyFingerprint: cred.keyFingerprint,
      trustDomain: 'euroid.local',
      publicKeyPem: expect.stringMatching(/^-----BEGIN PUBLIC KEY-----/),
      jwk: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: expect.any(String),
        kid: cred.keyFingerprint,
        alg: 'EdDSA',
        use: 'sig',
      },
    });
    expect(JSON.stringify(published)).not.toMatch(/PRIVATE KEY|"d":/);
    const message = Buffer.from(canonicalCredentialPayload(cred.payload), 'utf8');
    const signature = Buffer.from(cred.signature, 'hex');
    for (const key of [
      createPublicKey({ key: published!.publicKeyPem, format: 'pem' }),
      createPublicKey({ key: published!.jwk, format: 'jwk' }),
    ]) {
      expect(cryptoVerify(null, message, key, signature)).toBe(true);
    }
  });

  it('publishes no public key when signing is not configured', () => {
    const svc = new NhiCredentialService(makeConfig({}), makeNhi(makeDoc()), makeEvents());
    expect(svc.publicKey()).toBeNull();
  });
});
