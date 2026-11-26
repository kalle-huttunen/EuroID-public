/**
 * Storage Adapter Interface
 *
 * Abstract interface for cold storage (S3, Azure Blob, GCS).
 * Enables multi-cloud archival with a single activity implementation.
 */

export interface StorageAdapter {
  /**
   * Upload a buffer to the given path. Returns the full storage path/URI.
   */
  upload(buffer: Buffer, path: string): Promise<string>;

  /**
   * Upload with S3 Object Lock (COMPLIANCE mode) for WORM compliance.
   * Optional — only implemented by adapters supporting immutable storage.
   */
  uploadWithLock?(buffer: Buffer, path: string, retentionDays: number): Promise<string>;
}

// --- Task 108 recap: Abstract storage interface for S3/Azure Blob. Enables multi-cloud archival.
