/**
 * The Temporal payload codec keeps personal data out of Temporal: every payload the API's client
 * and the worker send is encrypted under the current key id, decrypts with the key its metadata
 * names (current or previous, so a key rotation keeps open workflows readable), passes payloads
 * recorded before the codec through, and refuses loudly, naming the key id, what it cannot decrypt.
 */
import { randomBytes } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import { defaultPayloadConverter, type Payload } from '@temporalio/common';
import {
  EncryptionKeysNotLoadedError,
  EncryptionService,
  type SubkeyRing,
} from '../secrets/encryption.service';
import { encryptionFromEnv } from '../secrets/key-rotation';
import {
  ENCRYPTED_PAYLOAD_ENCODING,
  PAYLOAD_KEY_ID_METADATA,
  TemporalPayloadCodec,
  TemporalPayloadDecryptionError,
  isEncryptedPayload,
  temporalDataConverter,
  temporalPayloadCodec,
} from './temporal-payload-codec';

const PERSON = { email: 'ada.lovelace@example.com', firstName: 'Ada', lastName: 'Lovelace' };
const ADDRESS = Buffer.from(PERSON.email);

const ring = (currentKeyId: string, keys: Record<string, Buffer>): SubkeyRing => ({
  currentKeyId,
  keys: new Map(Object.entries(keys)),
});
const codecWith = (currentKeyId: string, keys: Record<string, Buffer>) =>
  new TemporalPayloadCodec(() => ring(currentKeyId, keys));
const text = (bytes: Uint8Array | null | undefined) => Buffer.from(bytes ?? []).toString();
const jsonPayload = (value: unknown): Payload => defaultPayloadConverter.toPayload(value);

describe('TemporalPayloadCodec', () => {
  const key1 = randomBytes(32);
  const key2 = randomBytes(32);

  it('encrypts a payload under the current key id and decrypts it to the original', async () => {
    const codec = codecWith('key-1', { 'key-1': key1 });
    const original = jsonPayload(PERSON);

    const [encoded] = await codec.encode([original]);
    const [decoded] = await codec.decode([encoded]);

    expect(text(encoded.metadata?.encoding)).toBe(ENCRYPTED_PAYLOAD_ENCODING);
    expect(text(encoded.metadata?.[PAYLOAD_KEY_ID_METADATA])).toBe('key-1');
    expect(Buffer.from(encoded.data ?? []).includes(ADDRESS)).toBe(false);
    expect(text(decoded.metadata?.encoding)).toBe('json/plain');
    expect(Buffer.from(decoded.data ?? []).equals(Buffer.from(original.data ?? []))).toBe(true);
    expect(defaultPayloadConverter.fromPayload(decoded)).toEqual(PERSON);
  });

  it('keeps a payload without data (undefined) as it was', async () => {
    const codec = codecWith('key-1', { 'key-1': key1 });
    const original = jsonPayload(undefined);

    const [decoded] = await codec.decode(await codec.encode([original]));

    expect(text(decoded.metadata?.encoding)).toBe('binary/null');
    expect(defaultPayloadConverter.fromPayload(decoded)).toBeUndefined();
  });

  it('uses a fresh IV for every payload', async () => {
    const codec = codecWith('key-1', { 'key-1': key1 });
    const [a, b] = await codec.encode([jsonPayload(PERSON), jsonPayload(PERSON)]);

    expect(Buffer.from(a.data ?? []).equals(Buffer.from(b.data ?? []))).toBe(false);
  });

  it('refuses a changed payload, naming the key id', async () => {
    const codec = codecWith('key-1', { 'key-1': key1 });
    const [encoded] = await codec.encode([jsonPayload(PERSON)]);
    const data = Buffer.from(encoded.data ?? []);
    data[data.length - 1] ^= 0x01;

    const decoding = codec.decode([{ ...encoded, data }]);

    await expect(decoding).rejects.toThrow(TemporalPayloadDecryptionError);
    await expect(decoding).rejects.toThrow(/key id "key-1" did not decrypt/);
  });

  it('refuses a payload under a key it does not have, naming the key id and what to set', async () => {
    const [encoded] = await codecWith('key-1', { 'key-1': key1 }).encode([jsonPayload(PERSON)]);
    const codec = codecWith('key-2', { 'key-2': key2 });

    const error = await codec.decode([encoded]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TemporalPayloadDecryptionError);
    expect((error as TemporalPayloadDecryptionError).keyId).toBe('key-1');
    expect((error as Error).message).toContain('key id "key-1"');
    expect((error as Error).message).toContain('ENCRYPTION_KEY_PREVIOUS_ID "key-1"');
  });

  it('refuses a payload whose key id names a different key (wrong key), never passing it on', async () => {
    const [encoded] = await codecWith('key-1', { 'key-1': key1 }).encode([jsonPayload(PERSON)]);

    await expect(codecWith('key-1', { 'key-1': key2 }).decode([encoded])).rejects.toThrow(
      /key id "key-1" did not decrypt/,
    );
  });

  it('refuses an encrypted payload without a key id or too short to hold IV and tag', async () => {
    const codec = codecWith('key-1', { 'key-1': key1 });
    const [encoded] = await codec.encode([jsonPayload(PERSON)]);
    const encoding = encoded.metadata?.encoding as Uint8Array;
    const withoutKeyId = { metadata: { encoding }, data: encoded.data };
    const tooShort = { metadata: encoded.metadata, data: Buffer.alloc(10) };

    await expect(codec.decode([withoutKeyId])).rejects.toThrow(/names no key id/);
    await expect(codec.decode([tooShort])).rejects.toThrow(/key id "key-1" is too short/);
  });

  it('passes payloads it did not encrypt through unchanged (histories from before the codec)', async () => {
    const codec = codecWith('key-1', { 'key-1': key1 });
    const plain: Payload[] = [
      jsonPayload(PERSON),
      jsonPayload(undefined),
      { metadata: { encoding: Buffer.from('binary/plain') }, data: Buffer.from('raw') },
      {},
    ];

    const decoded = await codec.decode(plain);

    decoded.forEach((payload, i) => expect(payload).toBe(plain[i]));
  });

  it('after a rotation encrypts under the new key id and still decrypts the previous one', async () => {
    const before = codecWith('key-1', { 'key-1': key1, default: key1 });
    const [old] = await before.encode([jsonPayload(PERSON)]);
    const rotating = codecWith('key-2', { 'key-2': key2, 'key-1': key1, default: key1 });

    const [decodedOld] = await rotating.decode([old]);
    const [fresh] = await rotating.encode([jsonPayload(PERSON)]);

    expect(defaultPayloadConverter.fromPayload(decodedOld)).toEqual(PERSON);
    expect(text(fresh.metadata?.[PAYLOAD_KEY_ID_METADATA])).toBe('key-2');
    await expect(before.decode([fresh])).rejects.toThrow(/key id "key-2"/);
  });

  it('decrypts every encrypted payload of a history in place and leaves the rest', async () => {
    const codec = codecWith('key-1', { 'key-1': key1 });
    const [input, result] = await codec.encode([jsonPayload(PERSON), jsonPayload('done')]);
    const plain = jsonPayload({ id: 'identity-1' });
    const startInput = { payloads: [input] };
    const activityResult = { payloads: [plain, result] };
    const memoFields = { triggeredBy: input };
    const history = {
      events: [
        { workflowExecutionStartedEventAttributes: { input: startInput } },
        { activityTaskCompletedEventAttributes: { result: activityResult } },
        { memo: { fields: memoFields } },
      ],
    };

    const decrypted = codec.decryptHistory(history);

    expect(decrypted).toBe(history);
    const payloads = [startInput.payloads[0], activityResult.payloads[1], memoFields.triggeredBy];
    expect(payloads.map((p) => defaultPayloadConverter.fromPayload(p))).toEqual([
      PERSON,
      'done',
      PERSON,
    ]);
    expect(activityResult.payloads[0]).toBe(plain);
    expect(payloads.some(isEncryptedPayload)).toBe(false);
  });
});

describe('temporalDataConverter (keys from EncryptionService)', () => {
  const keyA = randomBytes(32).toString('base64');
  const keyB = randomBytes(32).toString('base64');

  it('derives its keys on first use, so it can be built before the keys are loaded', async () => {
    const settings: Record<string, string> = { 'encryption.ENCRYPTION_KEY': keyA };
    const config = { get: (key: string) => settings[key] } as unknown as ConfigService;
    const encryption = new EncryptionService(config);
    const codec = temporalDataConverter(encryption).payloadCodecs?.[0] as TemporalPayloadCodec;

    await expect(codec.encode([jsonPayload(PERSON)])).rejects.toThrow(EncryptionKeysNotLoadedError);
    await encryption.onModuleInit();
    const [encoded] = await codec.encode([jsonPayload(PERSON)]);

    expect(text(encoded.metadata?.[PAYLOAD_KEY_ID_METADATA])).toBe('default');
    expect(defaultPayloadConverter.fromPayload((await codec.decode([encoded]))[0])).toEqual(PERSON);
  });

  it('encrypts with a key of its own, not with ENCRYPTION_KEY itself', async () => {
    const encryption = await encryptionFromEnv({ ENCRYPTION_KEY: keyA, ENCRYPTION_KEY_ID: 'a' });
    const [encoded] = await temporalPayloadCodec(encryption).encode([jsonPayload(PERSON)]);

    const withRawKey = codecWith('a', { a: Buffer.from(keyA, 'base64') });

    await expect(withRawKey.decode([encoded])).rejects.toThrow(/key id "a" did not decrypt/);
  });

  it('follows an ENCRYPTION_KEY rotation: payloads from before still decrypt, new ones use the new id', async () => {
    // A deployment that never set ENCRYPTION_KEY_ID writes the id "default"
    const before = temporalPayloadCodec(await encryptionFromEnv({ ENCRYPTION_KEY: keyA }));
    const [old] = await before.encode([jsonPayload(PERSON)]);
    const rotating = temporalPayloadCodec(
      await encryptionFromEnv({
        ENCRYPTION_KEY: keyB,
        ENCRYPTION_KEY_ID: 'key-b',
        ENCRYPTION_KEY_PREVIOUS: keyA,
      }),
    );
    const afterRotation = temporalPayloadCodec(
      await encryptionFromEnv({ ENCRYPTION_KEY: keyB, ENCRYPTION_KEY_ID: 'key-b' }),
    );

    const [decodedOld] = await rotating.decode([old]);
    const [fresh] = await rotating.encode([jsonPayload(PERSON)]);

    expect(defaultPayloadConverter.fromPayload(decodedOld)).toEqual(PERSON);
    expect(text(fresh.metadata?.[PAYLOAD_KEY_ID_METADATA])).toBe('key-b');
    // Once ENCRYPTION_KEY_PREVIOUS is removed, the old payload fails loudly instead of passing on
    await expect(afterRotation.decode([old])).rejects.toThrow(/key id "default" did not decrypt/);
  });

  it('works with a passphrase-derived key', async () => {
    const codec = temporalPayloadCodec(
      await encryptionFromEnv({
        ENCRYPTION_KEY_PASSPHRASE: 'dev passphrase',
        ENCRYPTION_KEY_SALT: randomBytes(16).toString('base64'),
      }),
    );

    const [decoded] = await codec.decode(await codec.encode([jsonPayload(PERSON)]));

    expect(defaultPayloadConverter.fromPayload(decoded)).toEqual(PERSON);
  });
});
