/**
 * Azure Key Vault Provider
 *
 * Envelope encryption: Key Vault wraps/unwraps DEK. DEK encrypts data locally.
 * getKey() calls unwrapKey once on startup; EncryptionService caches the DEK.
 * Uses RSA-OAEP for key wrapping (Key Vault RSA keys).
 */

import { DefaultAzureCredential } from '@azure/identity';
import { KeyClient, CryptographyClient } from '@azure/keyvault-keys';
import { randomBytes } from 'crypto';
import { KmsProvider } from './kms-provider.interface';

const KEY_LENGTH = 32;
const WRAP_ALGORITHM = 'RSA-OAEP' as const;

export class AzureKeyVaultProvider implements KmsProvider {
  private cryptoClient: CryptographyClient | null = null;
  private readonly vaultUrl: string;
  private readonly keyName: string;
  private readonly wrappedDekBase64: string | undefined;
  private readonly credential = new DefaultAzureCredential();

  constructor() {
    const vaultUrl = process.env.AZURE_KEYVAULT_URL;
    const keyName = process.env.AZURE_KEYVAULT_KEY_NAME || 'euroid-encryption-key';
    if (!vaultUrl) {
      throw new Error('AZURE_KEYVAULT_URL is required when KMS_PROVIDER=azure');
    }
    this.vaultUrl = vaultUrl;
    this.keyName = keyName;
    this.wrappedDekBase64 = process.env.AZURE_KEYVAULT_WRAPPED_DEK;
  }

  private async getCryptoClient(): Promise<CryptographyClient> {
    if (this.cryptoClient) return this.cryptoClient;
    const keyClient = new KeyClient(this.vaultUrl, this.credential);
    const key = await keyClient.getKey(this.keyName);
    this.cryptoClient = new CryptographyClient(key!, this.credential);
    return this.cryptoClient;
  }

  async getKey(_keyId: string): Promise<Buffer> {
    const client = await this.getCryptoClient();
    if (this.wrappedDekBase64) {
      const wrappedKey = Buffer.from(this.wrappedDekBase64, 'base64');
      const result = await client.unwrapKey(
        WRAP_ALGORITHM,
        new Uint8Array(wrappedKey),
      );
      const dek = Buffer.from(result.result);
      if (dek.length !== KEY_LENGTH) {
        throw new Error(
          `Key Vault unwrap returned invalid DEK (expected ${KEY_LENGTH} bytes, got ${dek.length})`,
        );
      }
      return dek;
    }

    // Bootstrap: generate DEK, wrap it, output for user to store
    const dek = randomBytes(KEY_LENGTH);
    const wrapResult = await client.wrapKey(
      WRAP_ALGORITHM,
      new Uint8Array(dek),
    );
    const wrappedBase64 = Buffer.from(wrapResult.result).toString('base64');
    process.stderr.write(
      '[Azure Key Vault] Bootstrap: Set AZURE_KEYVAULT_WRAPPED_DEK in .env for next run:\n' +
        `AZURE_KEYVAULT_WRAPPED_DEK=${wrappedBase64}\n`,
    );
    return dek;
  }

  async encrypt(plaintext: Buffer, _keyId: string): Promise<Buffer> {
    const client = await this.getCryptoClient();
    const result = await client.encrypt(
      'RSA-OAEP',
      new Uint8Array(plaintext),
    );
    return Buffer.from(result.result);
  }

  async decrypt(ciphertext: Buffer, _keyId: string): Promise<Buffer> {
    const client = await this.getCryptoClient();
    const result = await client.decrypt(
      'RSA-OAEP',
      new Uint8Array(ciphertext),
    );
    return Buffer.from(result.result);
  }
}
