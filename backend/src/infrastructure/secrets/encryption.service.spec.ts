import * as crypto from 'crypto';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EncryptionKeysNotLoadedError, EncryptionService } from './encryption.service';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/** Minimal ConfigService mock that reads from process.env, stripping the 'encryption.' namespace prefix */
function createMockConfigService(): ConfigService {
  return {
    get: (key: string) => {
      const envKey = key.startsWith('encryption.') ? key.slice('encryption.'.length) : key;
      return process.env[envKey];
    },
  } as unknown as ConfigService;
}

function createV1Ciphertext(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, authTag, encrypted]);
  return 'euroid:v1:' + blob.toString('base64');
}

describe('EncryptionService', () => {
  const validKey = Buffer.alloc(32, 'a').toString('base64');

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = validKey;
    delete process.env.ENCRYPTION_KEY_PASSPHRASE;
    delete process.env.ENCRYPTION_KEY_SALT;
    delete process.env.ENCRYPTION_KEY_ID;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    delete process.env.ENCRYPTION_KEY_PREVIOUS_ID;
    delete process.env.KMS_PROVIDER;
    delete process.env.AWS_KMS_KEY_ARN;
    delete process.env.AZURE_KEYVAULT_URL;
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY_PASSPHRASE;
    delete process.env.ENCRYPTION_KEY_SALT;
    delete process.env.ENCRYPTION_KEY_ID;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    delete process.env.ENCRYPTION_KEY_PREVIOUS_ID;
    delete process.env.KMS_PROVIDER;
    delete process.env.AWS_KMS_KEY_ARN;
    delete process.env.AZURE_KEYVAULT_URL;
  });

  it('encrypts and decrypts round-trip (v2 format)', async () => {
    const service = new EncryptionService(createMockConfigService());
    await service.onModuleInit();

    const plaintext = 'secret-client-credentials';
    const ciphertext = service.encrypt(plaintext);
    expect(ciphertext).toMatch(/^euroid:v2:/);
    expect(ciphertext).not.toBe(plaintext);

    const decrypted = service.decrypt(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext for same plaintext (IV is random)', async () => {
    const service = new EncryptionService(createMockConfigService());
    await service.onModuleInit();

    const plaintext = 'secret';
    const c1 = service.encrypt(plaintext);
    const c2 = service.encrypt(plaintext);
    expect(c1).not.toBe(c2);
    expect(service.decrypt(c1)).toBe(plaintext);
    expect(service.decrypt(c2)).toBe(plaintext);
  });

  it('decrypts JSON config round-trip', async () => {
    const service = new EncryptionService(createMockConfigService());
    await service.onModuleInit();

    const config = { tenantId: 'abc', clientSecret: 'super-secret', clientId: '123' };
    const ciphertext = service.encrypt(JSON.stringify(config));
    const decrypted = JSON.parse(service.decrypt(ciphertext));
    expect(decrypted).toEqual(config);
  });

  it('throws when decrypting with wrong key', async () => {
    const service = new EncryptionService(createMockConfigService());
    await service.onModuleInit();
    const ciphertext = service.encrypt('secret');

    const wrongKey = Buffer.alloc(32, 'b').toString('base64');
    process.env.ENCRYPTION_KEY = wrongKey;
    const service2 = new EncryptionService(createMockConfigService());
    await service2.onModuleInit();

    expect(() => service2.decrypt(ciphertext)).toThrow();
  });

  it('throws when decrypting tampered ciphertext', async () => {
    const service = new EncryptionService(createMockConfigService());
    await service.onModuleInit();
    const ciphertext = service.encrypt('secret');
    const tampered = ciphertext.slice(0, -2) + 'XX';

    expect(() => service.decrypt(tampered)).toThrow();
  });

  it('throws when decrypting without euroid:v1: or euroid:v2: prefix', async () => {
    const service = new EncryptionService(createMockConfigService());
    await service.onModuleInit();

    expect(() => service.decrypt('invalid:format')).toThrow('Invalid encrypted format');
  });

  it('isEncrypted returns true for encrypted string', async () => {
    const service = new EncryptionService(createMockConfigService());
    await service.onModuleInit();
    const ciphertext = service.encrypt('x');
    expect(service.isEncrypted(ciphertext)).toBe(true);
  });

  it('isEncrypted returns false for plaintext', async () => {
    const service = new EncryptionService(createMockConfigService());
    await service.onModuleInit();
    expect(service.isEncrypted('plaintext')).toBe(false);
  });

  it('throws on startup when neither ENCRYPTION_KEY nor PASSPHRASE nor KMS is set', async () => {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY_PASSPHRASE;
    delete process.env.KMS_PROVIDER;

    const service = new EncryptionService(createMockConfigService());
    await expect(service.onModuleInit()).rejects.toThrow(/No encryption key configured/);
  });

  it('loads key from ENCRYPTION_KEY_PASSPHRASE when ENCRYPTION_KEY is not set', async () => {
    delete process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY_PASSPHRASE = 'my-dev-passphrase';
    process.env.ENCRYPTION_KEY_SALT = Buffer.alloc(16, 'x').toString('base64');

    const service = new EncryptionService(createMockConfigService());
    await service.onModuleInit();

    const plaintext = 'secret';
    const ciphertext = service.encrypt(plaintext);
    expect(service.decrypt(ciphertext)).toBe(plaintext);
  });

  it('throws when ENCRYPTION_KEY decodes to wrong length', async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(16).toString('base64'); // 16 bytes, not 32

    const service = new EncryptionService(createMockConfigService());
    await expect(service.onModuleInit()).rejects.toThrow(/must decode to exactly 32 bytes/);
  });

  it('decrypts v1 ciphertext with default key', async () => {
    const key = Buffer.alloc(KEY_LENGTH, 'a');
    const v1Cipher = createV1Ciphertext('legacy-secret', key);
    process.env.ENCRYPTION_KEY = key.toString('base64');
    const service = new EncryptionService(createMockConfigService());
    await service.onModuleInit();
    const dec = service.decrypt(v1Cipher);
    expect(dec).toBe('legacy-secret');
  });

  it('reEncrypt upgrades v1 to v2', async () => {
    const key = Buffer.alloc(KEY_LENGTH, 'a');
    const v1Cipher = createV1Ciphertext('secret', key);
    process.env.ENCRYPTION_KEY = key.toString('base64');
    const service = new EncryptionService(createMockConfigService());
    await service.onModuleInit();
    const reEnc = service.reEncrypt(v1Cipher);
    expect(reEnc).toMatch(/^euroid:v2:/);
    expect(service.decrypt(reEnc)).toBe('secret');
  });

  it('reEncrypt leaves v2 with current key unchanged', async () => {
    const service = new EncryptionService(createMockConfigService());
    await service.onModuleInit();
    const ciphertext = service.encrypt('x');
    const reEnc = service.reEncrypt(ciphertext);
    expect(reEnc).toBe(ciphertext);
  });

  describe('key rotation settings', () => {
    const keyB = Buffer.alloc(KEY_LENGTH, 'b').toString('base64');
    const load = async () => {
      const service = new EncryptionService(createMockConfigService());
      await service.onModuleInit();
      return service;
    };

    it('during a rotation encrypts under the new key id and still decrypts the previous key', async () => {
      const stored = (await load()).encrypt('stored-before'); // ENCRYPTION_KEY (a), no key id
      process.env.ENCRYPTION_KEY_PREVIOUS = validKey;
      process.env.ENCRYPTION_KEY = keyB;
      process.env.ENCRYPTION_KEY_ID = 'key-2';
      const rotating = await load();
      const written = rotating.encrypt('written-during-rotation');

      expect(stored).toMatch(/^euroid:v2:default:/);
      expect(written).toMatch(/^euroid:v2:key-2:/);
      expect(rotating.decrypt(stored)).toBe('stored-before');
      expect(rotating.isUnderCurrentKey(stored)).toBe(false);
      expect(rotating.isUnderCurrentKey(written)).toBe(true);

      delete process.env.ENCRYPTION_KEY_PREVIOUS;
      const after = await load();
      expect(after.decrypt(written)).toBe('written-during-rotation');
      expect(after.decrypt(rotating.reEncrypt(stored))).toBe('stored-before');
    });

    it.each([
      ['unset', undefined],
      ['"default"', 'default'],
    ])(
      'refuses ENCRYPTION_KEY_PREVIOUS with ENCRYPTION_KEY_ID %s, loading no key',
      async (_label, keyId) => {
        process.env.ENCRYPTION_KEY_PREVIOUS = validKey;
        process.env.ENCRYPTION_KEY = keyB;
        if (keyId) process.env.ENCRYPTION_KEY_ID = keyId;
        const service = new EncryptionService(createMockConfigService());

        await expect(service.onModuleInit()).rejects.toThrow(
          /set ENCRYPTION_KEY_ID .* to a new id/,
        );
        expect(() => service.encrypt('x')).toThrow(EncryptionKeysNotLoadedError);
      },
    );

    it('refuses ENCRYPTION_KEY_ID equal to ENCRYPTION_KEY_PREVIOUS_ID', async () => {
      process.env.ENCRYPTION_KEY_PREVIOUS = validKey;
      process.env.ENCRYPTION_KEY_PREVIOUS_ID = 'key-1';
      process.env.ENCRYPTION_KEY = keyB;
      process.env.ENCRYPTION_KEY_ID = 'key-1';

      await expect(load()).rejects.toThrow(/ENCRYPTION_KEY_PREVIOUS_ID \("key-1"\)/);
    });

    it('refuses an ENCRYPTION_KEY_PREVIOUS that is not 32 bytes instead of ignoring it', async () => {
      process.env.ENCRYPTION_KEY_PREVIOUS = Buffer.alloc(16).toString('base64');
      process.env.ENCRYPTION_KEY = keyB;
      process.env.ENCRYPTION_KEY_ID = 'key-2';

      await expect(load()).rejects.toThrow(/ENCRYPTION_KEY_PREVIOUS must decode to exactly 32/);
    });

    it('refuses a key id with ":", which separates the key id in the ciphertext', async () => {
      process.env.ENCRYPTION_KEY_ID = 'key:2';

      await expect(load()).rejects.toThrow(/ENCRYPTION_KEY_ID must not contain ':'/);
    });

    // FOLLOWUPS 2026-11-23 (encryption.service.ts): the old rotation steps left secrets under two
    // keys that both carry the id "default"; neither the API nor the rotation script read both
    describe('recovery of secrets under two keys with the id "default"', () => {
      /** Secrets saved under "default" with key a, then with key b (the old steps). */
      const savedUnderBothKeys = async () => {
        const underA = (await load()).encrypt('saved-with-a');
        process.env.ENCRYPTION_KEY = keyB;
        const underB = (await load()).encrypt('saved-with-b');
        const v1UnderB = createV1Ciphertext('v1-with-b', Buffer.alloc(KEY_LENGTH, 'b'));
        // Recovery: a key id for ENCRYPTION_KEY, the old key back as ENCRYPTION_KEY_PREVIOUS
        process.env.ENCRYPTION_KEY_ID = 'key-2';
        process.env.ENCRYPTION_KEY_PREVIOUS = validKey;
        return { underA, underB, v1UnderB };
      };

      afterEach(() => {
        jest.restoreAllMocks();
      });

      it('opens the secrets of both keys; the rotation moves them to the new id', async () => {
        const { underA, underB, v1UnderB } = await savedUnderBothKeys();
        expect([underA, underB]).toEqual([
          expect.stringMatching(/^euroid:v2:default:/),
          expect.stringMatching(/^euroid:v2:default:/),
        ]);
        const recovering = await load();

        expect(recovering.decrypt(underA)).toBe('saved-with-a');
        expect(recovering.decrypt(underB)).toBe('saved-with-b');
        expect(recovering.decrypt(v1UnderB)).toBe('v1-with-b');

        const rotated = [underA, underB, v1UnderB].map((c) => recovering.reEncrypt(c));
        delete process.env.ENCRYPTION_KEY_PREVIOUS;
        const after = await load();
        expect(rotated.map((c) => after.decrypt(c))).toEqual([
          'saved-with-a',
          'saved-with-b',
          'v1-with-b',
        ]);
      });

      it('logs once which key opened such a secret, with no key or secret material', async () => {
        const { underB } = await savedUnderBothKeys();
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const recovering = await load();

        recovering.decrypt(underB);
        recovering.decrypt(underB);

        expect(warn).toHaveBeenCalledTimes(1);
        const logged = String(warn.mock.calls[0]?.[0]);
        expect(logged).toContain('opened with ENCRYPTION_KEY (id: key-2)');
        for (const secret of [keyB, validKey, 'saved-with-b', underB.slice(-20)]) {
          expect(logged).not.toContain(secret);
        }
      });

      it('refuses a secret neither key opens; other ids get no second key', async () => {
        process.env.ENCRYPTION_KEY = Buffer.alloc(KEY_LENGTH, 'c').toString('base64');
        const underC = (await load()).encrypt('saved-with-c');
        await savedUnderBothKeys();
        const recovering = await load();
        // Names the previous key's id but was encrypted with ENCRYPTION_KEY (b)
        const misnamed = recovering.encrypt('x').replace(':key-2:', ':previous:');

        expect(() => recovering.decrypt(underC)).toThrow(/authenticate/);
        expect(() => recovering.decrypt(misnamed)).toThrow(/authenticate/);
      });
    });

    it('keyIdOf names the key a ciphertext needs: its v2 id, or default for v1', async () => {
      process.env.ENCRYPTION_KEY_ID = 'key-2';
      const service = await load();

      expect(service.keyIdOf(service.encrypt('x'))).toBe('key-2');
      expect(service.keyIdOf(createV1Ciphertext('x', Buffer.alloc(KEY_LENGTH, 'a')))).toBe(
        'default',
      );
      expect(service.getCurrentKeyId()).toBe('key-2');
    });
  });

  describe('deriveSubkeyRing (keys of the Temporal payload codec)', () => {
    const keyB = Buffer.alloc(KEY_LENGTH, 'b').toString('base64');

    it('derives a key per key id that differs from the key and from other purposes', async () => {
      process.env.ENCRYPTION_KEY_PREVIOUS = validKey;
      process.env.ENCRYPTION_KEY = keyB;
      process.env.ENCRYPTION_KEY_ID = 'key-2';
      const service = new EncryptionService(createMockConfigService());
      await service.onModuleInit();

      const ring = service.deriveSubkeyRing('purpose-a');
      const other = service.deriveSubkeyRing('purpose-b');

      expect(ring.currentKeyId).toBe('key-2');
      expect([...ring.keys.keys()].sort()).toEqual(['default', 'key-2', 'previous']);
      const derived = ring.keys.get('key-2') as Buffer;
      expect(derived).toHaveLength(KEY_LENGTH);
      expect(derived.equals(Buffer.from(keyB, 'base64'))).toBe(false);
      expect(derived.equals(other.keys.get('key-2') as Buffer)).toBe(false);
      // The previous key keeps its subkey, also under `default`, so old payloads still decrypt
      expect(ring.keys.get('default')?.equals(ring.keys.get('previous') as Buffer)).toBe(true);
      // Deterministic: the API and the worker derive the same key from the same settings
      const again = service.deriveSubkeyRing('purpose-a').keys.get('key-2') as Buffer;
      expect(derived.equals(again)).toBe(true);
    });

    it('refuses before the keys are loaded', () => {
      const service = new EncryptionService(createMockConfigService());

      expect(() => service.deriveSubkeyRing('purpose-a')).toThrow(EncryptionKeysNotLoadedError);
    });
  });

  it('isEncrypted accepts v1 and v2', async () => {
    const service = new EncryptionService(createMockConfigService());
    await service.onModuleInit();
    const v2 = service.encrypt('x');
    expect(service.isEncrypted(v2)).toBe(true);
    expect(service.isEncrypted('euroid:v1:abc123')).toBe(true);
    expect(service.isEncrypted('plaintext')).toBe(false);
  });
});

// --- TASK_102: v2 format, v1 decrypt, reEncrypt, isEncrypted(v1|v2) tests.
