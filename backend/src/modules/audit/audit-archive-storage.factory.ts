/**
 * Audit Archive Storage Factory
 *
 * Creates a StorageAdapter for WORM-compliant audit archival.
 * Uses AUDIT_ARCHIVE_S3_BUCKET (separate from general archival bucket)
 * since the bucket must have S3 Object Lock enabled.
 */

import type { StorageAdapter } from '../../infrastructure/retention/storage/storage.interface';

export async function createAuditArchiveStorageAdapter(): Promise<StorageAdapter> {
  const enabled = process.env.AUDIT_ARCHIVE_ENABLED === 'true';
  if (!enabled) {
    const {
      NoOpStorageAdapter,
    } = require('../../infrastructure/retention/storage/noop-storage.adapter');
    return new NoOpStorageAdapter();
  }

  const bucket = process.env.AUDIT_ARCHIVE_S3_BUCKET;
  if (!bucket) {
    throw new Error('AUDIT_ARCHIVE_S3_BUCKET is required when AUDIT_ARCHIVE_ENABLED=true');
  }

  const { S3StorageAdapter } =
    await import('../../infrastructure/retention/storage/s3-storage.adapter');
  return new S3StorageAdapter({
    bucket,
    region: process.env.AUDIT_ARCHIVE_S3_REGION,
  });
}
