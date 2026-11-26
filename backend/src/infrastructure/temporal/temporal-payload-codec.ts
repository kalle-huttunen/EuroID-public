/**
 * Temporal payload codec: AES-256-GCM encryption of every payload the API's Temporal client and
 * the worker send to Temporal (workflow and activity inputs and results, signals, queries,
 * updates, memos, schedule actions), so the Temporal server, its database and the UI hold no
 * personal data in clear. Search attribute values are not payloads and stay readable (`TenantId`).
 * Failure messages and stack traces are not payloads either (Temporal's default failure converter
 * writes them in clear); failure details are.
 *
 * Temporal applies payload codecs in the client and in the worker, outside the workflow sandbox:
 * workflow code and bundleWorkflowCode need nothing for it (only a custom payload or failure
 * converter would be bundled). Keys: EncryptionService.deriveSubkeyRing, HKDF subkeys of the
 * ENCRYPTION_KEY ring under the same key ids, so a key rotation rotates them too.
 *
 * Encoded payload: metadata `encoding: binary/encrypted` and `encryption-key-id: <id>`, data
 * `iv (12) + authTag (16) + ciphertext` of the original payload in protobuf form (its metadata
 * included), the layout of EncryptionService. Decoding passes every payload without that encoding
 * through unchanged (histories recorded before the codec), and throws on one it cannot decrypt.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { DataConverter, Payload, PayloadCodec } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import type { EncryptionService, SubkeyRing } from '../secrets/encryption.service';

/** HKDF info of the Temporal payload keys: never used for any other key. */
export const TEMPORAL_PAYLOAD_KEY_PURPOSE = 'euroid:temporal-payload-codec:v1';
export const ENCRYPTED_PAYLOAD_ENCODING = 'binary/encrypted';
export const PAYLOAD_KEY_ID_METADATA = 'encryption-key-id';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ProtoPayload = temporal.api.common.v1.Payload;

/** An encrypted payload this process cannot decrypt. It is never passed on as plaintext. */
export class TemporalPayloadDecryptionError extends Error {
  constructor(
    readonly keyId: string | undefined,
    reason: string,
  ) {
    super(
      keyId === undefined
        ? `Temporal payload with encoding ${ENCRYPTED_PAYLOAD_ENCODING} ${reason}`
        : `Temporal payload encrypted with key id "${keyId}" ${reason}`,
    );
    this.name = 'TemporalPayloadDecryptionError';
  }
}

/** True for a payload this codec encrypted (metadata `encoding: binary/encrypted`). */
export function isEncryptedPayload(value: unknown): value is Payload {
  if (typeof value !== 'object' || value === null) return false;
  const encoding = (value as Payload).metadata?.encoding;
  return (
    encoding instanceof Uint8Array &&
    Buffer.from(encoding).toString() === ENCRYPTED_PAYLOAD_ENCODING
  );
}

export class TemporalPayloadCodec implements PayloadCodec {
  private ring: SubkeyRing | undefined;

  /** `keyRing` is read on first use and kept: the codec may be built before the keys load. */
  constructor(private readonly keyRing: () => SubkeyRing) {}

  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => this.encryptPayload(payload));
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => this.decryptPayload(payload));
  }

  /** The payload encrypted under the current key id. */
  encryptPayload(payload: Payload): Payload {
    const { currentKeyId, keys } = this.keys();
    const key = keys.get(currentKeyId);
    if (!key) throw new Error(`Temporal payload key ring has no current key "${currentKeyId}"`);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const plaintext = ProtoPayload.encode(payload).finish();
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      metadata: {
        encoding: Buffer.from(ENCRYPTED_PAYLOAD_ENCODING),
        [PAYLOAD_KEY_ID_METADATA]: Buffer.from(currentKeyId),
      },
      data: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
    };
  }

  /** The original payload; a payload this codec did not encrypt is returned unchanged. */
  decryptPayload(payload: Payload): Payload {
    if (!isEncryptedPayload(payload)) return payload;
    const keyIdBytes = payload.metadata?.[PAYLOAD_KEY_ID_METADATA];
    if (!keyIdBytes) {
      throw new TemporalPayloadDecryptionError(
        undefined,
        `names no key id (metadata ${PAYLOAD_KEY_ID_METADATA}), so it cannot be decrypted.`,
      );
    }
    const keyId = Buffer.from(keyIdBytes).toString();
    const key = this.keys().keys.get(keyId);
    if (!key) {
      throw new TemporalPayloadDecryptionError(
        keyId,
        'cannot be decrypted: this process has no key with that id. Load the key it was ' +
          `encrypted with: ENCRYPTION_KEY_PREVIOUS, with ENCRYPTION_KEY_PREVIOUS_ID "${keyId}".`,
      );
    }
    const blob = Buffer.from(payload.data ?? new Uint8Array(0));
    if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new TemporalPayloadDecryptionError(
        keyId,
        `is too short (${blob.length} bytes) to hold an IV and an auth tag.`,
      );
    }
    const decipher = createDecipheriv(ALGORITHM, key, blob.subarray(0, IV_LENGTH), {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH));
    let plaintext: Buffer;
    try {
      const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new TemporalPayloadDecryptionError(
        keyId,
        'did not decrypt: the key this process has under that id is not the key it was ' +
          'encrypted with, or the payload was changed. Check ENCRYPTION_KEY and ' +
          'ENCRYPTION_KEY_PREVIOUS of this process.',
      );
    }
    // A protobuf message, like the payloads around it in a fetched history (historyJSON needs that)
    return ProtoPayload.decode(plaintext);
  }

  /**
   * Decrypts, in place, every payload this codec encrypted in a fetched history (or any object
   * tree of protobuf messages) and returns it. Plaintext payloads are left as they are.
   */
  decryptHistory<T>(history: T): T {
    const visit = (node: unknown): void => {
      if (typeof node !== 'object' || node === null || ArrayBuffer.isView(node)) return;
      const record = node as Record<string, unknown>;
      for (const [key, value] of Object.entries(record)) {
        if (isEncryptedPayload(value)) record[key] = this.decryptPayload(value);
        else visit(value);
      }
    };
    visit(history);
    return history;
  }

  private keys(): SubkeyRing {
    this.ring ??= this.keyRing();
    return this.ring;
  }
}

/** This deployment's codec: Temporal payload keys derived from EncryptionService on first use. */
export function temporalPayloadCodec(encryption: EncryptionService): TemporalPayloadCodec {
  return new TemporalPayloadCodec(() => encryption.deriveSubkeyRing(TEMPORAL_PAYLOAD_KEY_PURPOSE));
}

/**
 * The data converter of the API's Temporal client and of the worker (its workers and schedule
 * clients): Temporal's default payload and failure converters and the encrypting codec. Both
 * sides must use it, so deploy the API and the worker together.
 */
export function temporalDataConverter(encryption: EncryptionService): DataConverter {
  return { payloadCodecs: [temporalPayloadCodec(encryption)] };
}
