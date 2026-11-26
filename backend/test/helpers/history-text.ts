import { isEncryptedPayload } from '../../src/infrastructure/temporal/temporal-payload-codec';
import { testPayloadCodec } from './test-payload-codec';

/**
 * Every string in a fetched workflow history, payload bytes decoded as UTF-8 (JSON payloads), so
 * a test can assert that a value never reached the history. Payloads the harness's codec
 * encrypted are read decrypted (the history is not changed): the assertion is about what the
 * workflow wrote, which the codec hides from the Temporal server but not from a holder of the key.
 */
export function historyText(node: unknown, parts: string[] = []): string[] {
  if (isEncryptedPayload(node)) {
    historyText(testPayloadCodec.decryptPayload(node), parts);
  } else if (ArrayBuffer.isView(node)) {
    parts.push(Buffer.from(node.buffer, node.byteOffset, node.byteLength).toString('utf8'));
  } else if (Array.isArray(node)) {
    node.forEach((item) => historyText(item, parts));
  } else if (node !== null && typeof node === 'object') {
    Object.values(node).forEach((value) => historyText(value, parts));
  } else if (typeof node === 'string') {
    parts.push(node);
  }
  return parts;
}
