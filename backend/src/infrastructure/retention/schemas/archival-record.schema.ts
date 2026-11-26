/**
 * Archival Record Schema
 *
 * Tracks batches of data archived to cold storage (S3/Azure Blob).
 * Enables data discovery, restoration, and idempotent archival (skip already-archived docs).
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true, collection: 'archival_records' })
export class ArchivalRecord {
  @Prop({ required: true, type: String })
  batchId!: string;

  @Prop({ required: true, type: String })
  collection!: string;

  @Prop({ required: true, type: Number })
  documentCount!: number;

  @Prop({ required: true, type: String })
  storagePath!: string;

  @Prop({ required: true, type: String })
  storageProvider!: string;

  @Prop({ required: true, type: Date })
  archivedAt!: Date;

  @Prop({ required: true, type: Date })
  startDate!: Date;

  @Prop({ required: true, type: Date })
  endDate!: Date;

  @Prop({ type: Number })
  sizeBytes!: number;

  @Prop({ type: String })
  checksum!: string;
}

export type ArchivalRecordDocument = ArchivalRecord & Document;
export const ArchivalRecordSchema = SchemaFactory.createForClass(ArchivalRecord);

ArchivalRecordSchema.index({ collection: 1, archivedAt: -1 });

// --- Task 108 recap: Archival record schema for cold storage metadata. Tracks batchId, storagePath,
// documentCount, date range. Enables idempotent archival and data discovery.
