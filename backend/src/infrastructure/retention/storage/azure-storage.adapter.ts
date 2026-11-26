/**
 * Azure Blob Storage Adapter
 *
 * Uploads archival batches to Azure Blob Storage.
 * Uses dynamic import so @azure/storage-blob is only loaded when upload is called.
 */

import type { StorageAdapter } from './storage.interface';

export interface AzureStorageConfig {
  container: string;
  connectionString?: string;
}

export class AzureStorageAdapter implements StorageAdapter {
  private readonly container: string;
  private readonly connectionString: string;
  private containerClientPromise: Promise<{
    getBlockBlobClient: (path: string) => {
      uploadData: (
        data: Buffer,
        options: { blobHTTPHeaders: { blobContentEncoding: string; blobContentType: string } },
      ) => Promise<unknown>;
    };
    accountName: string;
    containerName: string;
  }> | null = null;

  constructor(config: AzureStorageConfig) {
    this.container = config.container;
    const connectionString =
      config.connectionString || process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error('AZURE_STORAGE_CONNECTION_STRING is required for Azure Blob storage');
    }
    this.connectionString = connectionString;
  }

  private async getContainerClient() {
    if (!this.containerClientPromise) {
      this.containerClientPromise = import('@azure/storage-blob').then(
        ({ BlobServiceClient }) => {
          const blobServiceClient = BlobServiceClient.fromConnectionString(
            this.connectionString,
          );
          return blobServiceClient.getContainerClient(this.container);
        },
      );
    }
    return this.containerClientPromise;
  }

  async upload(buffer: Buffer, blobPath: string): Promise<string> {
    const containerClient = await this.getContainerClient();
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
    await blockBlobClient.uploadData(buffer, {
      blobHTTPHeaders: {
        blobContentEncoding: 'gzip',
        blobContentType: 'application/x-ndjson',
      },
    });
    return `https://${containerClient.accountName}.blob.core.windows.net/${containerClient.containerName}/${blobPath}`;
  }
}
