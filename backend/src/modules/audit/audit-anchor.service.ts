/**
 * Audit Anchor Service — external anchor for Merkle checkpoints.
 *
 * A Merkle checkpoint stored only in our MongoDB is only as trustworthy as
 * the database itself. Anyone with write access to the `audit_roots`
 * collection could rebuild a new consistent chain over tampered events.
 *
 * This service signs each checkpoint with an Ed25519 private key held
 * outside the audit DB (loaded from env/KMS at boot). An independent
 * verifier — holding only the public key — can then prove that a chain
 * was produced by the legitimate signer, even if the DB is compromised.
 *
 * Optional: deliver the anchor envelope to a configured external witness
 * (HTTP POST). Delivery is best-effort; the signature itself is the proof.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  KeyObject,
} from 'crypto';
import type { AuditMerkleRootDocument } from './schemas/audit-merkle-root.schema';

/** Canonical JSON fields signed by the anchor. */
export interface AnchorPayload {
  checkpointId: string;
  tenantId: string;
  rootHash: string;
  previousRootHash: string | null;
  eventCount: number;
  firstEventTimestamp: string;
  lastEventTimestamp: string;
}

export interface AnchorEnvelope {
  payload: AnchorPayload;
  signature: string;
  keyFingerprint: string;
  algorithm: 'ed25519';
  signedAt: string;
}

/**
 * Canonical, order-stable JSON encoding used as the signing input.
 * Changing this format breaks verification of prior checkpoints, so it is
 * versioned implicitly by the field set and explicit key order.
 */
export function canonicalPayload(payload: AnchorPayload): string {
  const ordered = {
    checkpointId: payload.checkpointId,
    tenantId: payload.tenantId,
    rootHash: payload.rootHash,
    previousRootHash: payload.previousRootHash,
    eventCount: payload.eventCount,
    firstEventTimestamp: payload.firstEventTimestamp,
    lastEventTimestamp: payload.lastEventTimestamp,
  };
  return JSON.stringify(ordered);
}

/** AUDIT_ANCHOR_WITNESS_TIMEOUT_MS when unset or not a positive number of milliseconds. */
const DEFAULT_WITNESS_TIMEOUT_MS = 10_000;

@Injectable()
export class AuditAnchorService {
  private readonly logger = new Logger(AuditAnchorService.name);
  private readonly privateKey: KeyObject | null;
  private readonly publicKey: KeyObject | null;
  private readonly keyFingerprint: string | null;
  private readonly externalWitnessUrl: string | null;
  /** AUDIT_ANCHOR_WITNESS_TIMEOUT_MS: the most a witness delivery waits for its answer. */
  private readonly witnessTimeoutMs: number;

  constructor(config: ConfigService) {
    const privatePem = config.get<string>('AUDIT_ANCHOR_PRIVATE_KEY') ?? null;
    const publicPem = config.get<string>('AUDIT_ANCHOR_PUBLIC_KEY') ?? null;
    this.externalWitnessUrl = config.get<string>('AUDIT_ANCHOR_WITNESS_URL') ?? null;
    const timeout = Number(config.get<string>('AUDIT_ANCHOR_WITNESS_TIMEOUT_MS') ?? '');
    this.witnessTimeoutMs =
      Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_WITNESS_TIMEOUT_MS;

    if (privatePem) {
      try {
        this.privateKey = createPrivateKey({ key: privatePem, format: 'pem' });
        this.publicKey = publicPem
          ? createPublicKey({ key: publicPem, format: 'pem' })
          : createPublicKey(this.privateKey);
        this.keyFingerprint = fingerprintOf(this.publicKey);
        this.logger.log(
          `Audit anchor keypair loaded (fingerprint ${this.keyFingerprint.slice(0, 16)}...)`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to load AUDIT_ANCHOR_PRIVATE_KEY: ${msg}`);
        this.privateKey = null;
        this.publicKey = null;
        this.keyFingerprint = null;
      }
    } else {
      this.privateKey = null;
      this.publicKey = null;
      this.keyFingerprint = null;
      this.logger.warn(
        'AUDIT_ANCHOR_PRIVATE_KEY not configured — Merkle checkpoints will not be externally anchored',
      );
    }
  }

  /** True when a private key is loaded and signing is possible. */
  isEnabled(): boolean {
    return this.privateKey !== null;
  }

  /**
   * Sign a checkpoint document. Returns an envelope that can be stored
   * with the checkpoint and delivered to external witnesses.
   */
  signCheckpoint(checkpoint: AuditMerkleRootDocument): AnchorEnvelope | null {
    if (!this.privateKey || !this.keyFingerprint) return null;

    const payload: AnchorPayload = {
      checkpointId: checkpoint.checkpointId,
      tenantId: checkpoint.tenantId,
      rootHash: checkpoint.rootHash,
      previousRootHash: checkpoint.previousRootHash ?? null,
      eventCount: checkpoint.eventCount,
      firstEventTimestamp: checkpoint.firstEventTimestamp.toISOString(),
      lastEventTimestamp: checkpoint.lastEventTimestamp.toISOString(),
    };
    const message = Buffer.from(canonicalPayload(payload), 'utf8');
    const signature = cryptoSign(null, message, this.privateKey).toString('hex');

    return {
      payload,
      signature,
      keyFingerprint: this.keyFingerprint,
      algorithm: 'ed25519',
      signedAt: new Date().toISOString(),
    };
  }

  /**
   * Verify an anchor envelope against the configured public key (or a
   * caller-supplied one). Returns true only on a valid signature.
   */
  verify(envelope: AnchorEnvelope, publicKeyPem?: string): boolean {
    try {
      const key = publicKeyPem
        ? createPublicKey({ key: publicKeyPem, format: 'pem' })
        : this.publicKey;
      if (!key) return false;
      if (envelope.algorithm !== 'ed25519') return false;

      const expectedFingerprint = fingerprintOf(key);
      if (envelope.keyFingerprint !== expectedFingerprint) return false;

      const message = Buffer.from(canonicalPayload(envelope.payload), 'utf8');
      const sig = Buffer.from(envelope.signature, 'hex');
      return cryptoVerify(null, message, key, sig);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Anchor verification error: ${msg}`);
      return false;
    }
  }

  /**
   * Rebuild the envelope from a persisted checkpoint so verifiers can
   * re-check any historical checkpoint without re-signing.
   */
  envelopeFromCheckpoint(checkpoint: AuditMerkleRootDocument): AnchorEnvelope | null {
    if (!checkpoint.anchorSignature || !checkpoint.anchorKeyFingerprint) return null;
    const payload: AnchorPayload = {
      checkpointId: checkpoint.checkpointId,
      tenantId: checkpoint.tenantId,
      rootHash: checkpoint.rootHash,
      previousRootHash: checkpoint.previousRootHash ?? null,
      eventCount: checkpoint.eventCount,
      firstEventTimestamp: checkpoint.firstEventTimestamp.toISOString(),
      lastEventTimestamp: checkpoint.lastEventTimestamp.toISOString(),
    };
    return {
      payload,
      signature: checkpoint.anchorSignature,
      keyFingerprint: checkpoint.anchorKeyFingerprint,
      algorithm: 'ed25519',
      signedAt: (checkpoint.anchoredAt ?? new Date(0)).toISOString(),
    };
  }

  /**
   * Best-effort delivery to an external witness endpoint.
   * Returns the ack payload and HTTP status, or null on failure. A witness that has not answered
   * within AUDIT_ANCHOR_WITNESS_TIMEOUT_MS counts as a failure, so it never holds the checkpoint
   * (the super-admin request, the daily run) open.
   */
  async deliverToWitness(
    envelope: AnchorEnvelope,
  ): Promise<{
    endpoint: string;
    deliveredAt: Date;
    responseStatus: number;
    witness?: string;
  } | null> {
    if (!this.externalWitnessUrl) return null;
    try {
      const res = await fetch(this.externalWitnessUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(this.witnessTimeoutMs),
      });
      const witness = res.headers.get('x-witness-id') ?? undefined;
      return {
        endpoint: this.externalWitnessUrl,
        deliveredAt: new Date(),
        responseStatus: res.status,
        witness,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`External witness delivery failed: ${msg}`);
      return null;
    }
  }
}

/** SHA-256 fingerprint of the DER-encoded SPKI public key (hex). */
function fingerprintOf(publicKey: KeyObject): string {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(der).digest('hex');
}
