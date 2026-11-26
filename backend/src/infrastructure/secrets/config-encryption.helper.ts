/**
 * Helper for encrypting/decrypting config objects that may contain secrets.
 * Used by the blueprint (Design studio canvas) service.
 */

import { Logger } from '@nestjs/common';
import { EncryptionService } from './encryption.service';

const logger = new Logger('ConfigEncryption');

/**
 * A stored config this process cannot decrypt (another key, or corrupted data). Callers that
 * answer a request tell it apart from other failures (GET /blueprints/latest: CanvasLoadError).
 */
export class ConfigDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigDecryptionError';
  }
}

/**
 * Whether a config holds a secret. `secretKeys` are the keys the connector's manifest declares
 * `type: 'password'` (PluginRegistryService.getSecretConfigKeys), so a key name alone decides
 * nothing: Discord's `webhookUrl` is a secret, SCIM's `oauth2TokenUrl` is not.
 * `undefined` means no manifest applies (a node that names no registered connector): every key
 * then counts as secret, as GET /connectors does for such a connector.
 */
export function configHasSecrets(
  config: Record<string, unknown> | null | undefined,
  secretKeys: ReadonlySet<string> | undefined,
): boolean {
  if (!config || typeof config !== 'object') return false;
  const keys = Object.keys(config);
  if (!secretKeys) return keys.length > 0;
  return keys.some((k) => secretKeys.has(k));
}

/** The config encrypted as a whole when it holds a secret (see configHasSecrets), else as is. */
export function encryptConfigIfNeeded(
  encryption: EncryptionService,
  config: Record<string, unknown> | null | undefined,
  secretKeys: ReadonlySet<string> | undefined,
): string | Record<string, unknown> | undefined {
  if (!config) return undefined;
  if (!configHasSecrets(config, secretKeys)) return config;
  return encryption.encrypt(JSON.stringify(config));
}

export interface DecryptConfigOptions {
  /** When true and value is v1, reEncrypted will be set for caller to persist */
  reEncryptIfOldVersion?: boolean;
  /** Output: re-encrypted string when reEncryptIfOldVersion and value was v1 */
  reEncrypted?: { value: string };
}

export function decryptConfigIfEncrypted(
  encryption: EncryptionService,
  value: string | Record<string, unknown> | null | undefined,
  options?: DecryptConfigOptions,
): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === 'object') return value; // Legacy plaintext
  if (typeof value === 'string' && encryption.isEncrypted(value)) {
    try {
      const decrypted = JSON.parse(encryption.decrypt(value)) as Record<string, unknown>;
      if (options?.reEncryptIfOldVersion && value.startsWith('euroid:v1:')) {
        const reEnc = encryption.reEncrypt(value);
        if (options.reEncrypted) options.reEncrypted.value = reEnc;
      }
      return decrypted;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `Decrypt failed (key mismatch or corrupted data). ` +
          `Re-save connector config from Design Studio (click the connector on the canvas). Error: ${message}`,
      );
      throw new ConfigDecryptionError(
        `Config decryption failed: ${message}. Re-save the connector config to re-encrypt with the current key.`,
      );
    }
  }
  return typeof value === 'object' ? value : {};
}

// --- TASK_102: DecryptConfigOptions with reEncryptIfOldVersion, reEncrypted output for v1→v2 migration.
