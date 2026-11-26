/**
 * An operator reads an encrypted payload through decode-temporal-payloads.ts: the history in
 * protobuf JSON, as the Temporal CLI prints it, comes back with each encrypted payload replaced
 * by its value; everything else is kept, and a payload the keys cannot decrypt stops it.
 */
import { randomBytes } from 'crypto';
import { defaultPayloadConverter, type Payload } from '@temporalio/common';
import { TemporalPayloadCodec, TemporalPayloadDecryptionError } from './temporal-payload-codec';
import { decryptPayloadsInJson } from './temporal-payload-json';

const PERSON = { email: 'ada.lovelace@example.com', lastName: 'Lovelace' };

/** A payload in protobuf JSON: bytes as base64. */
const asJson = (payload: Payload) => ({
  metadata: Object.fromEntries(
    Object.entries(payload.metadata ?? {}).map(([k, v]) => [k, Buffer.from(v).toString('base64')]),
  ),
  data: Buffer.from(payload.data ?? []).toString('base64'),
});

describe('decryptPayloadsInJson', () => {
  const key = randomBytes(32);
  const codec = new TemporalPayloadCodec(() => ({
    currentKeyId: 'key-1',
    keys: new Map([['key-1', key]]),
  }));

  it('replaces each encrypted payload of a history by its value and keeps the rest', async () => {
    const [input, other] = await codec.encode([
      defaultPayloadConverter.toPayload(PERSON),
      { metadata: { encoding: Buffer.from('json/protobuf') }, data: Buffer.from('{"a":1}') },
    ]);
    const plain = asJson(defaultPayloadConverter.toPayload('kept'));
    const event = (eventId: string, payload: unknown) => ({
      eventId,
      activityTaskCompletedEventAttributes: { result: { payloads: [payload] } },
    });
    const history = {
      events: [event('1', asJson(input)), event('2', plain), event('3', asJson(other))],
    };

    const decoded = decryptPayloadsInJson(history, codec);

    // A payload the default converter cannot read: its metadata as text, its data as base64
    const unreadable = {
      metadata: { encoding: 'json/protobuf' },
      data: Buffer.from('{"a":1}').toString('base64'),
    };
    expect(decoded).toEqual({
      events: [event('1', PERSON), event('2', plain), event('3', unreadable)],
    });
    expect(JSON.stringify(history)).not.toContain(PERSON.email);
  });

  it('stops at a payload the keys cannot decrypt, naming its key id', async () => {
    const other = new TemporalPayloadCodec(() => ({
      currentKeyId: 'key-2',
      keys: new Map([['key-2', randomBytes(32)]]),
    }));
    const [payload] = await other.encode([defaultPayloadConverter.toPayload(PERSON)]);

    expect(() => decryptPayloadsInJson({ payloads: [asJson(payload)] }, codec)).toThrow(
      TemporalPayloadDecryptionError,
    );
    expect(() => decryptPayloadsInJson(asJson(payload), codec)).toThrow(/key id "key-2"/);
  });
});
