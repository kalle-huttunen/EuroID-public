/**
 * S3 Storage Adapter
 *
 * Uploads archival batches to AWS S3.
 * Uses dynamic import so @aws-sdk/client-s3 is only loaded when upload is called.
 */

import type { StorageAdapter } from './storage.interface';

export interface S3StorageConfig {
  bucket: string;
  region?: string;
}

export class S3StorageAdapter implements StorageAdapter {
  private readonly bucket: string;
  private readonly region: string;
  private readonly credentials: { accessKeyId: string; secretAccessKey: string } | undefined;
  private clientPromise: Promise<unknown> | null = null;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.region = config.region || process.env.ARCHIVAL_STORAGE_REGION || 'us-east-1';
    this.credentials =
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined;
  }

  private async getClient(): Promise<{ send: (cmd: unknown) => Promise<unknown> }> {
    if (!this.clientPromise) {
      this.clientPromise = import('@aws-sdk/client-s3').then(
        ({ S3Client }) =>
          new S3Client({
            region: this.region,
            credentials: this.credentials,
          }),
      );
    }
    return this.clientPromise as Promise<{ send: (cmd: unknown) => Promise<unknown> }>;
  }

  async upload(buffer: Buffer, objectKey: string): Promise<string> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: buffer,
        ContentEncoding: 'gzip',
        ContentType: 'application/x-ndjson',
      }),
    );
    return `s3://${this.bucket}/${objectKey}`;
  }

  async uploadWithLock(buffer: Buffer, objectKey: string, retentionDays: number): Promise<string> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();

    const retainUntil = new Date();
    retainUntil.setDate(retainUntil.getDate() + retentionDays);

    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: buffer,
        ContentEncoding: 'gzip',
        ContentType: 'application/json',
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: retainUntil,
      }),
    );
    return `s3://${this.bucket}/${objectKey}`;
  }
}
