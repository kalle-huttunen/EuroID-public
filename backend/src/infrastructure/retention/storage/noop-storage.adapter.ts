/**
 * No-Op Storage Adapter
 *
 * Throws when upload is called. Used when ARCHIVAL_STORAGE_PROVIDER is not configured.
 */

import type { StorageAdapter } from './storage.interface';

export class NoOpStorageAdapter implements StorageAdapter {
  async upload(): Promise<string> {
    throw new Error(
      'Archival storage not configured. Set ARCHIVAL_STORAGE_PROVIDER (s3 | azure-blob) and related env vars.',
    );
  }
}

// --- Task 108 recap: No-op adapter when ARCHIVAL_STORAGE_PROVIDER unset. Throws on upload.
