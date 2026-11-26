/**
 * The API's Temporal client encrypts what it sends (workflow inputs, signals, queries, memos)
 * with the codec the worker decrypts with: without it the email in an onboarding or offboarding
 * input would be stored in clear by the Temporal server.
 */
import { randomBytes } from 'crypto';
import { Client } from '@temporalio/client';
import { defaultPayloadConverter, type PayloadCodec } from '@temporalio/common';
import { encryptionFromEnv } from '../secrets/key-rotation';
import { TemporalClientProvider } from './temporal-client.provider';
import { PAYLOAD_KEY_ID_METADATA, temporalDataConverter } from './temporal-payload-codec';

jest.mock('@temporalio/client', () => ({
  Connection: { connect: jest.fn().mockResolvedValue({}) },
  Client: jest.fn(),
}));

describe('TemporalClientProvider payload encryption', () => {
  it('builds the client with the encrypting codec, under ENCRYPTION_KEY_ID', async () => {
    const encryption = await encryptionFromEnv({
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      ENCRYPTION_KEY_ID: 'key-1',
    });
    const provider = new TemporalClientProvider(encryption);

    await provider.onModuleInit();

    expect(provider.isConnected()).toBe(true);
    const options = (Client as unknown as jest.Mock).mock.calls[0][0];
    const codecs: PayloadCodec[] = options.dataConverter?.payloadCodecs ?? [];
    expect(codecs).toHaveLength(1);
    const input = defaultPayloadConverter.toPayload({ targetEmail: 'ada@example.com' });
    const [encoded] = await codecs[0].encode([input]);
    expect(Buffer.from(encoded.data ?? []).includes('ada@example.com')).toBe(false);
    expect(Buffer.from(encoded.metadata?.[PAYLOAD_KEY_ID_METADATA] ?? []).toString()).toBe('key-1');
    // The worker's converter, built from the same settings, reads it
    const worker = temporalDataConverter(encryption).payloadCodecs ?? [];
    const [decoded] = await worker[0].decode([encoded]);
    expect(defaultPayloadConverter.fromPayload(decoded)).toEqual({
      targetEmail: 'ada@example.com',
    });
  });
});
