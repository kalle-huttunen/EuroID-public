import { generateKeyPairSync } from 'crypto';
import { AuditAnchorService, canonicalPayload } from './audit-anchor.service';
import type { AuditMerkleRootDocument } from './schemas/audit-merkle-root.schema';

function makeKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

function makeCheckpoint(overrides: Partial<AuditMerkleRootDocument> = {}): AuditMerkleRootDocument {
  return {
    checkpointId: 'chkpt-1',
    tenantId: 'tenant-a',
    rootHash: 'a'.repeat(64),
    eventCount: 3,
    treeDepth: 2,
    firstEventTimestamp: new Date('2026-04-17T00:00:00Z'),
    lastEventTimestamp: new Date('2026-04-17T00:05:00Z'),
    eventHashes: ['h1', 'h2', 'h3'],
    previousRootHash: undefined,
    archived: false,
    set: jest.fn(),
    ...overrides,
  } as unknown as AuditMerkleRootDocument;
}

function makeService(env: Record<string, string | undefined> = {}) {
  const config = {
    get: jest.fn((key: string) => env[key]),
  } as any;
  return new AuditAnchorService(config);
}

describe('AuditAnchorService', () => {
  it('is disabled when no private key is configured', () => {
    const svc = makeService({});
    expect(svc.isEnabled()).toBe(false);
    expect(svc.signCheckpoint(makeCheckpoint())).toBeNull();
  });

  it('loads a keypair from env and is enabled', () => {
    const { privatePem } = makeKeypair();
    const svc = makeService({ AUDIT_ANCHOR_PRIVATE_KEY: privatePem });
    expect(svc.isEnabled()).toBe(true);
  });

  it('signs a checkpoint and produces a valid, verifiable envelope', () => {
    const { privatePem, publicPem } = makeKeypair();
    const svc = makeService({ AUDIT_ANCHOR_PRIVATE_KEY: privatePem });
    const envelope = svc.signCheckpoint(makeCheckpoint())!;

    expect(envelope).not.toBeNull();
    expect(envelope.algorithm).toBe('ed25519');
    expect(envelope.signature).toMatch(/^[0-9a-f]+$/);
    expect(envelope.keyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(svc.verify(envelope)).toBe(true);
    expect(svc.verify(envelope, publicPem)).toBe(true);
  });

  it('rejects a tampered payload (different rootHash)', () => {
    const { privatePem } = makeKeypair();
    const svc = makeService({ AUDIT_ANCHOR_PRIVATE_KEY: privatePem });
    const envelope = svc.signCheckpoint(makeCheckpoint())!;
    const tampered = {
      ...envelope,
      payload: { ...envelope.payload, rootHash: 'b'.repeat(64) },
    };
    expect(svc.verify(tampered)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const { privatePem } = makeKeypair();
    const svc = makeService({ AUDIT_ANCHOR_PRIVATE_KEY: privatePem });
    const envelope = svc.signCheckpoint(makeCheckpoint())!;
    const flipped =
      envelope.signature.slice(0, -2) + (envelope.signature.endsWith('0') ? '1' : '0');
    const tampered = { ...envelope, signature: flipped };
    expect(svc.verify(tampered)).toBe(false);
  });

  it('rejects when the key fingerprint does not match the public key', () => {
    const { privatePem } = makeKeypair();
    const { publicPem: otherPublicPem } = makeKeypair();
    const svc = makeService({ AUDIT_ANCHOR_PRIVATE_KEY: privatePem });
    const envelope = svc.signCheckpoint(makeCheckpoint())!;
    expect(svc.verify(envelope, otherPublicPem)).toBe(false);
  });

  it('rebuilds envelope from a stored checkpoint with anchor fields', () => {
    const { privatePem } = makeKeypair();
    const svc = makeService({ AUDIT_ANCHOR_PRIVATE_KEY: privatePem });
    const unsigned = makeCheckpoint();
    const envelope = svc.signCheckpoint(unsigned)!;
    const stored = makeCheckpoint({
      anchorSignature: envelope.signature,
      anchorKeyFingerprint: envelope.keyFingerprint,
      anchoredAt: new Date(envelope.signedAt),
    } as any);
    const rebuilt = svc.envelopeFromCheckpoint(stored);
    expect(rebuilt).not.toBeNull();
    expect(svc.verify(rebuilt!)).toBe(true);
  });

  it('returns null when rebuilding a checkpoint that was never anchored', () => {
    const { privatePem } = makeKeypair();
    const svc = makeService({ AUDIT_ANCHOR_PRIVATE_KEY: privatePem });
    expect(svc.envelopeFromCheckpoint(makeCheckpoint())).toBeNull();
  });

  it('canonical payload order is stable (signed bytes do not drift on field reorder)', () => {
    const p1 = {
      checkpointId: 'c1',
      tenantId: 't',
      rootHash: 'r',
      previousRootHash: null,
      eventCount: 1,
      firstEventTimestamp: '2026-04-17T00:00:00.000Z',
      lastEventTimestamp: '2026-04-17T00:01:00.000Z',
    };
    const p2 = {
      tenantId: 't',
      rootHash: 'r',
      lastEventTimestamp: '2026-04-17T00:01:00.000Z',
      previousRootHash: null,
      eventCount: 1,
      checkpointId: 'c1',
      firstEventTimestamp: '2026-04-17T00:00:00.000Z',
    };
    expect(canonicalPayload(p1 as any)).toBe(canonicalPayload(p2 as any));
  });

  it('deliverToWitness returns null when no witness URL is configured', async () => {
    const { privatePem } = makeKeypair();
    const svc = makeService({ AUDIT_ANCHOR_PRIVATE_KEY: privatePem });
    const envelope = svc.signCheckpoint(makeCheckpoint())!;
    expect(await svc.deliverToWitness(envelope)).toBeNull();
  });

  it('deliverToWitness POSTs and captures response status + witness header', async () => {
    const { privatePem } = makeKeypair();
    const svc = makeService({
      AUDIT_ANCHOR_PRIVATE_KEY: privatePem,
      AUDIT_ANCHOR_WITNESS_URL: 'https://witness.test/anchor',
    });
    const envelope = svc.signCheckpoint(makeCheckpoint())!;
    const mockFetch = jest.fn().mockResolvedValue({
      status: 202,
      headers: { get: (name: string) => (name === 'x-witness-id' ? 'w-42' : null) },
    });
    (globalThis as any).fetch = mockFetch;

    const result = await svc.deliverToWitness(envelope);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://witness.test/anchor',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        endpoint: 'https://witness.test/anchor',
        responseStatus: 202,
        witness: 'w-42',
      }),
    );
  });

  it('deliverToWitness returns null on fetch failure (best-effort semantics)', async () => {
    const { privatePem } = makeKeypair();
    const svc = makeService({
      AUDIT_ANCHOR_PRIVATE_KEY: privatePem,
      AUDIT_ANCHOR_WITNESS_URL: 'https://witness.test/anchor',
    });
    const envelope = svc.signCheckpoint(makeCheckpoint())!;
    (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('network down'));
    expect(await svc.deliverToWitness(envelope)).toBeNull();
  });

  // Hunt 06 F11: fetch had no timeout, so a witness that never answers held createCheckpoint
  // (the super-admin request and the daily run) open.
  it('deliverToWitness gives up on a witness that does not answer within the timeout', async () => {
    const { privatePem } = makeKeypair();
    const svc = makeService({
      AUDIT_ANCHOR_PRIVATE_KEY: privatePem,
      AUDIT_ANCHOR_WITNESS_URL: 'https://witness.test/anchor',
      AUDIT_ANCHOR_WITNESS_TIMEOUT_MS: '50',
    });
    const envelope = svc.signCheckpoint(makeCheckpoint())!;
    // As fetch does: never settles unless its signal aborts
    (globalThis as any).fetch = jest.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    expect(await svc.deliverToWitness(envelope)).toBeNull();
  }, 2_000);
});
