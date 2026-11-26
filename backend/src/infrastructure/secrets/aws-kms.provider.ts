/**
 * AWS KMS Provider
 *
 * Envelope encryption: KMS wraps/unwraps DEK. DEK encrypts data locally.
 * getKey() calls KMS Decrypt once on startup; EncryptionService caches the DEK.
 */

import { KMSClient, DecryptCommand, EncryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { KmsProvider } from './kms-provider.interface';

const KEY_LENGTH = 32;

export class AwsKmsProvider implements KmsProvider {
  private readonly client: KMSClient;
  private readonly keyArn: string;
  private readonly wrappedDekBase64: string | undefined;

  constructor() {
    const keyArn = process.env.AWS_KMS_KEY_ARN;
    const region = process.env.AWS_REGION || 'eu-west-1';
    if (!keyArn) {
      throw new Error('AWS_KMS_KEY_ARN is required when KMS_PROVIDER=aws');
    }
    this.keyArn = keyArn;
    this.wrappedDekBase64 = process.env.AWS_KMS_WRAPPED_DEK;
    this.client = new KMSClient({ region });
  }

  async getKey(_keyId: string): Promise<Buffer> {
    if (this.wrappedDekBase64) {
      const ciphertextBlob = Buffer.from(this.wrappedDekBase64, 'base64');
      const response = await this.client.send(
        new DecryptCommand({
          CiphertextBlob: new Uint8Array(ciphertextBlob),
          KeyId: this.keyArn,
        }),
      );
      if (!response.Plaintext || response.Plaintext.length !== KEY_LENGTH) {
        throw new Error(
          `KMS Decrypt returned invalid DEK (expected ${KEY_LENGTH} bytes, got ${response.Plaintext?.length ?? 0})`,
        );
      }
      return Buffer.from(response.Plaintext);
    }

    // Bootstrap: GenerateDataKey, return plaintext (caller must store CiphertextBlob for next run)
    const response = await this.client.send(
      new GenerateDataKeyCommand({
        KeyId: this.keyArn,
        KeySpec: 'AES_256',
        NumberOfBytes: KEY_LENGTH,
      }),
    );
    if (!response.Plaintext || response.Plaintext.length !== KEY_LENGTH) {
      throw new Error('KMS GenerateDataKey returned invalid DEK');
    }
    if (response.CiphertextBlob) {
      // Bootstrap: user must store wrapped DEK for next run
      process.stderr.write(
        '[AWS KMS] Bootstrap: Set AWS_KMS_WRAPPED_DEK in .env for next run:\n' +
          `AWS_KMS_WRAPPED_DEK=${Buffer.from(response.CiphertextBlob).toString('base64')}\n`,
      );
    }
    return Buffer.from(response.Plaintext);
  }

  async encrypt(plaintext: Buffer, _keyId: string): Promise<Buffer> {
    const response = await this.client.send(
      new EncryptCommand({
        KeyId: this.keyArn,
        Plaintext: new Uint8Array(plaintext),
      }),
    );
    if (!response.CiphertextBlob) {
      throw new Error('KMS Encrypt returned no ciphertext');
    }
    return Buffer.from(response.CiphertextBlob);
  }

  async decrypt(ciphertext: Buffer, _keyId: string): Promise<Buffer> {
    const response = await this.client.send(
      new DecryptCommand({
        CiphertextBlob: new Uint8Array(ciphertext),
        KeyId: this.keyArn,
      }),
    );
    if (!response.Plaintext) {
      throw new Error('KMS Decrypt returned no plaintext');
    }
    return Buffer.from(response.Plaintext);
  }
}
