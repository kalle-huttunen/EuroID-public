import { fixBuffers } from '@temporalio/common/lib/proto-utils';
import * as temporalProto from '@temporalio/proto';
import { toProto3JSON } from 'proto3-json-serializer';
import { decryptedHistory } from './test-payload-codec';

/**
 * A fetched workflow history as JSON in the format of the replay fixtures (test/fixtures/).
 * Temporal's historyToJSON cannot be used: proto3-json-serializer 2.0.2 throws on
 * map<string, bytes> values (payload metadata), so those become base64 strings first.
 * Payloads the harness's codec encrypted are written decrypted: the harness key lives only as
 * long as the test process, and a plaintext fixture replays with or without the codec.
 */
export function historyJSON(history: unknown): string {
  const message = temporalProto.temporal.api.history.v1.History.fromObject(
    decryptedHistory(history) as object,
  );
  const bytesMapsToBase64 = (node: unknown): void => {
    if (!node || typeof node !== 'object' || node instanceof Uint8Array) return;
    if (Array.isArray(node)) return node.forEach(bytesMapsToBase64);
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (!value || typeof value !== 'object' || value instanceof Uint8Array) continue;
      const entries = Array.isArray(value) ? [] : Object.entries(value);
      const isBytesMap =
        (value as object).constructor === Object &&
        entries.length > 0 &&
        entries.every(([, v]) => v instanceof Uint8Array);
      if (isBytesMap) {
        record[key] = Object.fromEntries(
          entries.map(([k, v]) => [k, Buffer.from(v as Uint8Array).toString('base64')]),
        );
      } else {
        bytesMapsToBase64(value);
      }
    }
  };
  bytesMapsToBase64(message);
  return JSON.stringify(fixBuffers(toProto3JSON(message as never)), null, 2);
}
