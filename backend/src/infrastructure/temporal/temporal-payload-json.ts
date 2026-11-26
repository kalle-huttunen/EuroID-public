/**
 * Decrypts the payloads of a workflow history, or of any part of one, in protobuf JSON (bytes as
 * base64), the form `temporal workflow show --output json` prints and test/fixtures/ hold. For an
 * operator who must read a payload the Temporal UI shows encrypted:
 * src/scripts/decode-temporal-payloads.ts.
 */
import { defaultPayloadConverter, type Payload } from '@temporalio/common';
import { ENCRYPTED_PAYLOAD_ENCODING, type TemporalPayloadCodec } from './temporal-payload-codec';

type JsonPayload = { metadata: Record<string, string>; data?: string };

function isEncryptedJsonPayload(node: Record<string, unknown>): node is JsonPayload {
  const encoding = (node.metadata as Record<string, unknown> | undefined)?.encoding;
  return (
    typeof encoding === 'string' &&
    Buffer.from(encoding, 'base64').toString() === ENCRYPTED_PAYLOAD_ENCODING
  );
}

/** The value a decrypted payload holds; a payload that is not JSON as metadata and base64 data. */
function payloadValue(payload: Payload): unknown {
  try {
    return defaultPayloadConverter.fromPayload(payload);
  } catch {
    const metadata = Object.entries(payload.metadata ?? {});
    return {
      metadata: Object.fromEntries(metadata.map(([k, v]) => [k, Buffer.from(v).toString()])),
      data: Buffer.from(payload.data ?? new Uint8Array(0)).toString('base64'),
    };
  }
}

/**
 * A copy of `node` in which every payload the codec encrypted is replaced by the value it holds.
 * Throws TemporalPayloadDecryptionError for a payload the codec's keys cannot decrypt.
 */
export function decryptPayloadsInJson(node: unknown, codec: TemporalPayloadCodec): unknown {
  if (Array.isArray(node)) return node.map((item) => decryptPayloadsInJson(item, codec));
  if (typeof node !== 'object' || node === null) return node;
  const record = node as Record<string, unknown>;
  if (isEncryptedJsonPayload(record)) {
    const metadata = Object.entries(record.metadata);
    const payload: Payload = {
      metadata: Object.fromEntries(metadata.map(([k, v]) => [k, Buffer.from(v, 'base64')])),
      data: Buffer.from(record.data ?? '', 'base64'),
    };
    return payloadValue(codec.decryptPayload(payload));
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, decryptPayloadsInJson(value, codec)]),
  );
}
