/**
 * Storage Adapter Factory
 *
 * Selects the appropriate storage adapter based on ARCHIVAL_STORAGE_PROVIDER.
 * Uses dynamic import for S3/Azure adapters so their SDKs are only loaded when used.
 */

import type { StorageAdapter } from './storage.interface';

export async function createStorageAdapter(): Promise<StorageAdapter> {
  const provider = process.env.ARCHIVAL_STORAGE_PROVIDER;
  if (!provider) {
    const { NoOpStorageAdapter } = require('./noop-storage.adapter');
    return new NoOpStorageAdapter();
  }
  switch (provider) {
    case 's3': {
      const bucket = process.env.ARCHIVAL_STORAGE_BUCKET;
      if (!bucket) {
        throw new Error('ARCHIVAL_STORAGE_BUCKET is required for S3 archival');
      }
      const { S3StorageAdapter } = await import('./s3-storage.adapter');
      return new S3StorageAdapter({
        bucket,
        region: process.env.ARCHIVAL_STORAGE_REGION,
      });
    }
    case 'azure-blob': {
      const container =
        process.env.ARCHIVAL_STORAGE_CONTAINER || process.env.ARCHIVAL_STORAGE_BUCKET;
      if (!container) {
        throw new Error(
          'ARCHIVAL_STORAGE_CONTAINER or ARCHIVAL_STORAGE_BUCKET is required for Azure Blob archival',
        );
      }
      const { AzureStorageAdapter } = await import('./azure-storage.adapter');
      return new AzureStorageAdapter({ container });
    }
    default:
      throw new Error(
        `Unknown ARCHIVAL_STORAGE_PROVIDER: ${provider}. Use 's3' or 'azure-blob'.`,
      );
  }
}
