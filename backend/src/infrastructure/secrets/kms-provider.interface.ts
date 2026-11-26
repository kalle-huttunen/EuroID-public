/**
 * KMS Provider Interface
 *
 * Abstraction for key management services (AWS KMS, Azure Key Vault).
 * Used for envelope encryption: KMS wraps/unwraps DEK, DEK encrypts data locally.
 */

export interface KmsProvider {
  /** Returns the unwrapped data encryption key (DEK) for the given key ID. */
  getKey(keyId: string): Promise<Buffer>;

  /** Encrypt plaintext using the KMS key (for direct encryption or key wrapping). */
  encrypt(plaintext: Buffer, keyId: string): Promise<Buffer>;

  /** Decrypt ciphertext using the KMS key (for direct decryption or key unwrapping). */
  decrypt(ciphertext: Buffer, keyId: string): Promise<Buffer>;
}
