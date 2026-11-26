/**
 * The payload codec of the Temporal e2e harness: the codec the API's client and the worker run
 * (src/infrastructure/temporal/temporal-payload-codec.ts) under a random key for this test
 * process, so every e2e suite runs with encrypted payloads as production does.
 *
 * A fetched history holds ciphertext. historyText() and historyJSON() decrypt it, so assertions
 * and recorded fixtures see the payloads the workflow wrote (fixtures stay plaintext, as
 * histories from before the codec are, and replay with or without the codec).
 */
import { randomBytes } from 'crypto';
import type { DataConverter } from '@temporalio/common';
import { TemporalPayloadCodec } from '../../src/infrastructure/temporal/temporal-payload-codec';

export const TEST_PAYLOAD_KEY_ID = 'e2e-key';

export const testPayloadCodec = new TemporalPayloadCodec(() => ({
  currentKeyId: TEST_PAYLOAD_KEY_ID,
  keys: new Map([[TEST_PAYLOAD_KEY_ID, randomBytes(32)]]),
}));

export const testDataConverter: DataConverter = { payloadCodecs: [testPayloadCodec] };

/** A fetched history with every payload the harness's codec encrypted decrypted, in place. */
export function decryptedHistory<T>(history: T): T {
  return testPayloadCodec.decryptHistory(history);
}
