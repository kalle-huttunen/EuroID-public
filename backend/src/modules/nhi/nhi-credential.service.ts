/**
 * NHI Credential Service — issues short-lived scoped credentials for agents.
 *
 * Design:
 *   - Credential is a detached Ed25519-signed SPIFFE-compatible token.
 *   - spiffeId: `spiffe://{trustDomain}/tenants/{tenantId}/agents/{agentId}`
 *   - Payload is a canonical JSON object (order-stable) holding the agent
 *     identifier, scope, and expiry — verifiable by anyone holding the
 *     public key (publicKey(), GET /nhi/_/public-key). Only verify()
 *     (POST /nhi/credentials/verify) also sees a revoke, kill switch or
 *     expiry of the agent within the credential's own lifetime.
 *   - TTL is clamped to MAX_CREDENTIAL_TTL_SECONDS (1 hour) — we never
 *     issue long-lived creds for agents.
 *   - The signing key is the same infrastructure used for audit anchor
 *     envelopes (NHI_SIGNING_PRIVATE_KEY). If absent, the service refuses
 *     to issue credentials — we never fall back to insecure mode.
 */
import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  KeyObject,
  webcrypto,
} from 'crypto';

import { NhiService } from './nhi.service';
import { MAX_CREDENTIAL_TTL_SECONDS } from './dtos/agent-identity.dto';
import type { AgentCredentialEnvelope } from './dtos/agent-credential.dto';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { AgentIdentityDocument } from './schemas/agent-identity.schema';

export interface AgentCredentialPayload {
  spiffeId: string;
  agentId: string;
  tenantId: string;
  scope: string[];
  issuedAt: string;
  expiresAt: string;
}

export interface AgentCredential {
  payload: AgentCredentialPayload;
  signature: string;
  keyFingerprint: string;
  algorithm: 'ed25519';
}

/**
 * The answer of verify(), shaped like OAuth token introspection (RFC 7662): `active` and, for an
 * active credential, what it grants; for an inactive one only why.
 */
export interface CredentialIntrospection {
  active: boolean;
  reason?: string;
  agentId?: string;
  scope?: string[];
  expiresAt?: string;
}

/** The signing public key, for a relying party that checks credentials offline. */
export interface NhiPublicKey {
  algorithm: 'ed25519';
  keyFingerprint: string;
  trustDomain: string;
  publicKeyPem: string;
  jwk: webcrypto.JsonWebKey & { kid: string; alg: 'EdDSA'; use: 'sig' };
}

/** An Ed25519 signature: 64 bytes, hex. */
const SIGNATURE_RE = /^[0-9a-f]{128}$/;

const inactive = (reason: string): CredentialIntrospection => ({ active: false, reason });

/** Order-stable JSON canonicalisation (mirrors the audit-anchor approach). */
export function canonicalCredentialPayload(p: AgentCredentialPayload): string {
  return JSON.stringify({
    spiffeId: p.spiffeId,
    agentId: p.agentId,
    tenantId: p.tenantId,
    scope: [...p.scope].sort(),
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt,
  });
}

function fingerprintOf(key: KeyObject): string {
  return createHash('sha256')
    .update(key.export({ format: 'der', type: 'spki' }))
    .digest('hex');
}

@Injectable()
export class NhiCredentialService {
  private readonly logger = new Logger(NhiCredentialService.name);
  private readonly privateKey: KeyObject | null;
  private readonly signingPublicKey: KeyObject | null;
  private readonly keyFingerprint: string | null;
  private readonly trustDomain: string;

  constructor(
    config: ConfigService,
    private readonly nhi: NhiService,
    private readonly events: DomainEventEmitterService,
  ) {
    this.trustDomain = config.get<string>('NHI_TRUST_DOMAIN') ?? 'euroid.local';
    const privatePem = config.get<string>('NHI_SIGNING_PRIVATE_KEY') ?? null;
    if (privatePem) {
      try {
        this.privateKey = createPrivateKey({ key: privatePem, format: 'pem' });
        this.signingPublicKey = createPublicKey(this.privateKey);
        this.keyFingerprint = fingerprintOf(this.signingPublicKey);
        this.logger.log(
          `NHI signing keypair loaded (fingerprint ${this.keyFingerprint.slice(0, 16)}...)`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to load NHI_SIGNING_PRIVATE_KEY: ${msg}`);
        this.privateKey = null;
        this.signingPublicKey = null;
        this.keyFingerprint = null;
      }
    } else {
      this.privateKey = null;
      this.signingPublicKey = null;
      this.keyFingerprint = null;
      this.logger.warn('NHI_SIGNING_PRIVATE_KEY not configured — credential issuance disabled');
    }
  }

  isEnabled(): boolean {
    return this.privateKey !== null;
  }

  async issue(
    tenantId: string,
    agentId: string,
    ttlSeconds: number,
    actor: string,
  ): Promise<AgentCredential> {
    if (!this.privateKey || !this.keyFingerprint) {
      throw new ConflictException('NHI credential signing is not configured');
    }
    if (ttlSeconds <= 0 || ttlSeconds > MAX_CREDENTIAL_TTL_SECONDS) {
      throw new BadRequestException(`ttlSeconds must be in (0, ${MAX_CREDENTIAL_TTL_SECONDS}]`);
    }

    const doc = await this.nhi.mustGet(tenantId, agentId);
    this.assertIssuable(doc);

    const issuedAt = new Date();
    const rawExpiry = new Date(issuedAt.getTime() + ttlSeconds * 1000);
    const expiresAt = rawExpiry > doc.expiresAt ? doc.expiresAt : rawExpiry;

    const payload: AgentCredentialPayload = {
      spiffeId: this.spiffeIdFor(tenantId, agentId),
      agentId,
      tenantId,
      scope: doc.scope,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    const message = Buffer.from(canonicalCredentialPayload(payload), 'utf8');
    const signature = cryptoSign(null, message, this.privateKey).toString('hex');

    const fingerprint = createHash('sha256').update(signature).digest('hex');
    doc.credentialFingerprint = fingerprint;
    doc.lastRotatedAt = issuedAt;
    await doc.save();

    this.events.emit(
      DomainEventType.NHI_CREDENTIAL_ISSUED,
      agentId,
      {
        agentId,
        spiffeId: payload.spiffeId,
        expiresAt: payload.expiresAt,
        fingerprint,
      },
      { tenantId, actor },
    );

    return {
      payload,
      signature,
      keyFingerprint: this.keyFingerprint,
      algorithm: 'ed25519',
    };
  }

  /**
   * Whether `cred` is active for a caller of `tenantId`: signed by this key and unaltered, not
   * past its own expiry, issued for this tenant, and its agent still active (not revoked, killed
   * or past its expiresAt). Anything else is inactive with the reason; it never throws for a bad
   * credential. The signature and tenant are checked before any read, so a forged or foreign
   * credential learns nothing about the tenant's agents.
   */
  async verify(tenantId: string, cred: AgentCredentialEnvelope): Promise<CredentialIntrospection> {
    const problem = await this.problemOf(tenantId, cred);
    if (problem) {
      this.logger.warn(`NHI credential inactive in tenant ${tenantId}: ${problem}`);
      return inactive(problem);
    }
    return {
      active: true,
      agentId: cred.payload.agentId,
      scope: cred.payload.scope,
      expiresAt: cred.payload.expiresAt,
    };
  }

  /** The signing public key (PEM and JWK) and what a relying party needs with it; null without a key. */
  publicKey(): NhiPublicKey | null {
    if (!this.signingPublicKey || !this.keyFingerprint) return null;
    return {
      algorithm: 'ed25519',
      keyFingerprint: this.keyFingerprint,
      trustDomain: this.trustDomain,
      publicKeyPem: this.signingPublicKey.export({ format: 'pem', type: 'spki' }).toString(),
      jwk: {
        ...this.signingPublicKey.export({ format: 'jwk' }),
        kid: this.keyFingerprint,
        alg: 'EdDSA',
        use: 'sig',
      },
    };
  }

  /** Why the envelope is not this key's untouched signature, else undefined. */
  private signatureProblem(cred: AgentCredentialEnvelope): string | undefined {
    if (!this.signingPublicKey || !this.keyFingerprint)
      return 'credential signing is not configured';
    if (cred.algorithm !== 'ed25519') return 'unsupported algorithm';
    if (cred.keyFingerprint !== this.keyFingerprint) return 'signed with another key';
    if (!SIGNATURE_RE.test(cred.signature)) return 'malformed signature';
    try {
      const message = Buffer.from(canonicalCredentialPayload(cred.payload), 'utf8');
      const sig = Buffer.from(cred.signature, 'hex');
      return cryptoVerify(null, message, this.signingPublicKey, sig)
        ? undefined
        : 'invalid signature';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Credential verification error: ${msg}`);
      return 'invalid signature';
    }
  }

  /** Why the credential is not active for `tenantId`, else undefined. */
  private async problemOf(
    tenantId: string,
    cred: AgentCredentialEnvelope,
  ): Promise<string | undefined> {
    const signature = this.signatureProblem(cred);
    if (signature) return signature;
    if (!(Date.parse(cred.payload.expiresAt) > Date.now())) return 'credential expired';
    if (cred.payload.tenantId !== tenantId) return 'issued for another tenant';
    // Read with expiry applied: an agent past its expiresAt answers `expired`
    const doc = await this.nhi.get(tenantId, cred.payload.agentId);
    if (!doc) return 'agent not found';
    if (doc.killSwitchEngaged) return 'kill switch engaged';
    if (doc.status !== 'active') return `agent ${doc.status}`;
    return undefined;
  }

  spiffeIdFor(tenantId: string, agentId: string): string {
    return `spiffe://${this.trustDomain}/tenants/${tenantId}/agents/${agentId}`;
  }

  private assertIssuable(doc: AgentIdentityDocument): void {
    if (doc.killSwitchEngaged) {
      throw new ConflictException(`Agent ${doc.agentId} has kill-switch engaged`);
    }
    if (doc.status !== 'active') {
      throw new ConflictException(`Agent ${doc.agentId} is ${doc.status}`);
    }
    // Credentials issued before still verify (problemOf does not look at it)
    if (doc.ownerlessSince) {
      throw new ConflictException(
        `Agent ${doc.agentId} has no owner (the owner was ${doc.ownerlessReason ?? 'removed'}): ` +
          'give it a new owner or revoke it',
      );
    }
    if (doc.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException(`Agent ${doc.agentId} has expired`);
    }
  }
}
