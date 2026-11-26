/**
 * EncryptionService — AES-256-GCM encryption for secrets at rest
 *
 * Used to encrypt connector credentials and other sensitive data before
 * storing in MongoDB. Supports key rotation with v2 format and lazy migration.
 * When KMS_PROVIDER is set, uses envelope encryption: KMS unwraps DEK on init.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  pbkdf2 as pbkdf2Cb,
} from 'crypto';
import { promisify } from 'util';

const pbkdf2Async = promisify(pbkdf2Cb);
import { KmsProvider } from './kms-provider.interface';
import { AwsKmsProvider } from './aws-kms.provider';
import { AzureKeyVaultProvider } from './azure-keyvault.provider';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;
const PREFIX_V1 = 'euroid:v1:';
const PREFIX_V2 = 'euroid:v2:';

/** A key id names its key inside `euroid:v2:<keyId>:<blob>`, so it cannot hold the separator. */
function assertKeyId(keyId: string, setting: string): void {
  if (keyId.includes(':')) {
    throw new Error(`${setting} must not contain ':' (got "${keyId}"). Choose an id without it.`);
  }
}

/**
 * During a rotation the previous key also takes the id `default` (what secrets stored without
 * ENCRYPTION_KEY_ID name), so the new key needs an id of its own: sharing one, new secrets would
 * be encrypted under the previous key and lost when ENCRYPTION_KEY_PREVIOUS is removed.
 */
function assertRotationKeyIds(keyId: string, prevKeyId: string): void {
  if (keyId === 'default' || keyId === prevKeyId) {
    throw new Error(
      `ENCRYPTION_KEY_PREVIOUS is set, so set ENCRYPTION_KEY_ID (now "${keyId}") to a new id for ` +
        `ENCRYPTION_KEY, other than "default" and ENCRYPTION_KEY_PREVIOUS_ID ("${prevKeyId}"), ` +
        'for example the id src/scripts/rotate-encryption-key.ts --generate prints.',
    );
  }
}

/** Base64 `iv + authTag + ciphertext` of a v1/v2 value, refused when too short to hold them. */
function toBlob(base64: string): Buffer {
  const blob = Buffer.from(base64, 'base64');
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted blob: too short');
  }
  return blob;
}

/** AES-256-GCM open; throws when the key does not authenticate the blob. */
function openBlob(key: Buffer, blob: Buffer): string {
  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

/** Keys for another use of the key ring (deriveSubkeyRing), under the ring's key ids. */
export interface SubkeyRing {
  currentKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

/**
 * encrypt/decrypt before onModuleInit has loaded the keys. Not a wrong key: the same call
 * succeeds once the keys are loaded, so callers must not treat it as one.
 */
export class EncryptionKeysNotLoadedError extends Error {
  constructor() {
    super('EncryptionService not initialized. onModuleInit must complete before encrypt/decrypt.');
    this.name = 'EncryptionKeysNotLoadedError';
  }
}

@Injectable()
export class EncryptionService implements OnModuleInit {
  private readonly logger = new Logger(EncryptionService.name);
  private keyRing = new Map<string, Buffer>();
  private currentKeyId = 'default';
  /**
   * With ENCRYPTION_KEY_PREVIOUS set, `default` names the previous key. The old rotation steps
   * (before the key id was required) also saved secrets under `default` with ENCRYPTION_KEY, so a
   * `default` secret the previous key does not open is tried once with this key (ENCRYPTION_KEY).
   */
  private legacyDefaultAlternate?: Buffer;
  private legacyDefaultLogged = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.ensureKey();
  }

  private createKmsProvider(): KmsProvider {
    const provider = this.config.get<string>('encryption.KMS_PROVIDER');
    if (provider === 'aws') return new AwsKmsProvider();
    if (provider === 'azure') return new AzureKeyVaultProvider();
    throw new Error(`Unsupported KMS_PROVIDER: ${provider}. Use 'aws' or 'azure'.`);
  }

  private async ensureKey(): Promise<void> {
    if (this.keyRing.size > 0) return;

    const kmsProvider = this.config.get<string>('encryption.KMS_PROVIDER');
    if (kmsProvider === 'aws' || kmsProvider === 'azure') {
      const provider = this.createKmsProvider();
      const keyId = this.config.get<string>('encryption.ENCRYPTION_KEY_ID') || 'default';
      assertKeyId(keyId, 'ENCRYPTION_KEY_ID');
      const dek = await provider.getKey(keyId);
      if (dek.length !== KEY_LENGTH) {
        throw new Error(
          `KMS getKey returned invalid DEK (expected ${KEY_LENGTH} bytes, got ${dek.length})`,
        );
      }
      this.keyRing.set(keyId, dek);
      this.keyRing.set('default', dek);
      this.currentKeyId = keyId;
      this.logger.log(`Encryption key loaded from KMS (provider: ${kmsProvider}, id: ${keyId})`);
      return;
    }

    await this.ensureKeyFromEnv();
  }

  private async ensureKeyFromEnv(): Promise<void> {
    if (this.keyRing.size > 0) return;

    const rawKey = this.config.get<string>('encryption.ENCRYPTION_KEY');
    const keyId = this.config.get<string>('encryption.ENCRYPTION_KEY_ID') || 'default';
    const prevKey = this.config.get<string>('encryption.ENCRYPTION_KEY_PREVIOUS');
    const prevKeyId =
      this.config.get<string>('encryption.ENCRYPTION_KEY_PREVIOUS_ID') || 'previous';
    const passphrase = this.config.get<string>('encryption.ENCRYPTION_KEY_PASSPHRASE');
    const salt = this.config.get<string>('encryption.ENCRYPTION_KEY_SALT');

    if (rawKey) {
      const decoded = Buffer.from(rawKey, 'base64');
      if (decoded.length !== KEY_LENGTH) {
        throw new Error(
          `ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH} bytes (got ${decoded.length}). ` +
            `Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
        );
      }
      assertKeyId(keyId, 'ENCRYPTION_KEY_ID');
      // Every setting is checked before a key is loaded: a refused start leaves the ring empty.
      const prevDecoded = prevKey ? Buffer.from(prevKey, 'base64') : undefined;
      if (prevDecoded) {
        if (prevDecoded.length !== KEY_LENGTH) {
          throw new Error(
            `ENCRYPTION_KEY_PREVIOUS must decode to exactly ${KEY_LENGTH} bytes (got ` +
              `${prevDecoded.length}). Set it to the ENCRYPTION_KEY the stored secrets were encrypted with.`,
          );
        }
        assertKeyId(prevKeyId, 'ENCRYPTION_KEY_PREVIOUS_ID');
        assertRotationKeyIds(keyId, prevKeyId);
      }
      this.keyRing.set(keyId, decoded);
      this.currentKeyId = keyId;
      this.logger.log(`Encryption key loaded from ENCRYPTION_KEY (id: ${keyId})`);

      if (prevDecoded) {
        this.keyRing.set(prevKeyId, prevDecoded);
        this.keyRing.set('default', prevDecoded);
        this.legacyDefaultAlternate = decoded;
        this.logger.log(`Previous encryption key loaded (id: ${prevKeyId}, default for v1)`);
      } else {
        this.keyRing.set('default', decoded);
      }
      return;
    }

    if (passphrase) {
      if (!salt) {
        throw new Error(
          'ENCRYPTION_KEY_SALT is required when using ENCRYPTION_KEY_PASSPHRASE. ' +
            "Generate with: node -e \"console.log(require('crypto').randomBytes(16).toString('base64'))\"",
        );
      }
      const saltBuf = Buffer.from(salt, 'base64');
      const derived = await pbkdf2Async(
        passphrase,
        saltBuf,
        PBKDF2_ITERATIONS,
        KEY_LENGTH,
        'sha256',
      );
      this.keyRing.set('default', derived);
      this.currentKeyId = 'default';
      this.logger.log(
        'Encryption key derived from ENCRYPTION_KEY_PASSPHRASE (PBKDF2, id: default)',
      );
      return;
    }

    throw new Error(
      'No encryption key configured. Set ENCRYPTION_KEY (base64, 32 bytes) or ' +
        'ENCRYPTION_KEY_PASSPHRASE in .env. See backend/src/infrastructure/secrets/docs/ARCHITECTURE.md',
    );
  }

  private getKey(keyId?: string): Buffer {
    if (this.keyRing.size === 0) throw new EncryptionKeysNotLoadedError();
    const id = keyId ?? this.currentKeyId;
    const key = this.keyRing.get(id);
    if (!key) {
      throw new Error(`Encryption key not found: ${id}`);
    }
    return key;
  }

  /**
   * Encrypt plaintext. Returns v2 format:
   * euroid:v2:<keyId>:<base64(iv + authTag + ciphertext)>
   */
  encrypt(plaintext: string): string {
    const key = this.getKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const blob = Buffer.concat([iv, authTag, encrypted]);
    return `${PREFIX_V2}${this.currentKeyId}:${blob.toString('base64')}`;
  }

  /**
   * Decrypt ciphertext. Handles both v1 and v2 formats.
   */
  decrypt(ciphertext: string): string {
    if (ciphertext.startsWith(PREFIX_V1)) {
      const key = this.getKey('default');
      return this.open('default', key, toBlob(ciphertext.slice(PREFIX_V1.length)));
    }

    if (ciphertext.startsWith(PREFIX_V2)) {
      const rest = ciphertext.slice(PREFIX_V2.length);
      const colonIdx = rest.indexOf(':');
      if (colonIdx === -1) {
        throw new Error('Invalid v2 format: missing keyId');
      }
      const keyId = rest.slice(0, colonIdx);
      const blob = toBlob(rest.slice(colonIdx + 1));
      return this.open(keyId, this.getKey(keyId), blob);
    }

    throw new Error('Invalid encrypted format: missing euroid:v1: or euroid:v2: prefix');
  }

  /**
   * Open `blob` with `key`, the key `keyId` names. Only for the legacy id `default` during a
   * rotation (legacyDefaultAlternate): when that key does not authenticate it, ENCRYPTION_KEY is
   * tried once. Every other failure is thrown as it is.
   */
  private open(keyId: string, key: Buffer, blob: Buffer): string {
    try {
      return openBlob(key, blob);
    } catch (err: unknown) {
      const alternate = keyId === 'default' ? this.legacyDefaultAlternate : undefined;
      if (!alternate) throw err;
      let plaintext: string;
      try {
        plaintext = openBlob(alternate, blob);
      } catch {
        throw err;
      }
      this.logLegacyDefaultOpened();
      return plaintext;
    }
  }

  /** Once per process: which key opened a `default` secret. No key, ciphertext or value. */
  private logLegacyDefaultOpened(): void {
    if (this.legacyDefaultLogged) return;
    this.legacyDefaultLogged = true;
    this.logger.warn(
      'A secret stored under key id "default" did not open with ENCRYPTION_KEY_PREVIOUS and ' +
        `opened with ENCRYPTION_KEY (id: ${this.currentKeyId}): it was saved under "default" by ` +
        'the old rotation steps. Run src/scripts/rotate-encryption-key.ts to store every ' +
        'secret under the current key id.',
    );
  }

  /**
   * Returns true if the value appears to be encrypted (has our prefix).
   */
  isEncrypted(value: string): boolean {
    return (
      typeof value === 'string' && (value.startsWith(PREFIX_V1) || value.startsWith(PREFIX_V2))
    );
  }

  /**
   * Add a key to the key ring. Used by the rotation script to inject the new key.
   */
  addKey(keyId: string, key: Buffer): void {
    if (key.length !== KEY_LENGTH) {
      throw new Error(`Key must be exactly ${KEY_LENGTH} bytes (got ${key.length})`);
    }
    this.keyRing.set(keyId, key);
  }

  /**
   * Set the current key ID for new encryptions. The key must already be in the ring.
   */
  setCurrentKey(keyId: string): void {
    if (!this.keyRing.has(keyId)) {
      throw new Error(`Key not found in ring: ${keyId}`);
    }
    this.currentKeyId = keyId;
  }

  /**
   * Keys for another use of the same key material (the Temporal payload codec): an HKDF-SHA256
   * subkey of every key in the ring, `purpose` as the HKDF info, under the same key ids, with the
   * current key id. A rotation of ENCRYPTION_KEY rotates them too, and none of them is a key that
   * encrypts secrets.
   */
  deriveSubkeyRing(purpose: string): SubkeyRing {
    if (this.keyRing.size === 0) throw new EncryptionKeysNotLoadedError();
    const keys = new Map<string, Buffer>();
    for (const [keyId, key] of this.keyRing) {
      keys.set(keyId, Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), purpose, KEY_LENGTH)));
    }
    return { currentKeyId: this.currentKeyId, keys };
  }

  /** The id of the key new secrets are encrypted with (ENCRYPTION_KEY_ID, `default` if unset). */
  getCurrentKeyId(): string {
    return this.currentKeyId;
  }

  /** The key id a ciphertext names: its v2 key id, or `default` for v1 (the key decrypt uses). */
  keyIdOf(ciphertext: string): string {
    if (ciphertext.startsWith(PREFIX_V1)) return 'default';
    const colonIdx = ciphertext.indexOf(':', PREFIX_V2.length);
    if (!ciphertext.startsWith(PREFIX_V2) || colonIdx === -1) {
      throw new Error('Invalid encrypted format: not euroid:v1: or euroid:v2:<keyId>:');
    }
    return ciphertext.slice(PREFIX_V2.length, colonIdx);
  }

  /** True when the ciphertext is v2 under the current key id, so reEncrypt would keep it. */
  isUnderCurrentKey(ciphertext: string): boolean {
    return ciphertext.startsWith(PREFIX_V2) && this.keyIdOf(ciphertext) === this.currentKeyId;
  }

  /**
   * Re-encrypt ciphertext with current key. Returns unchanged if already v2 with current key.
   */
  reEncrypt(ciphertext: string): string {
    if (!this.isEncrypted(ciphertext)) {
      throw new Error('Value is not encrypted');
    }
    if (this.isUnderCurrentKey(ciphertext)) {
      return ciphertext;
    }
    const plaintext = this.decrypt(ciphertext);
    return this.encrypt(plaintext);
  }
}

// --- TASK_102: Key ring, v2 format (euroid:v2:<keyId>:<blob>), v1 backward compat, reEncrypt().
