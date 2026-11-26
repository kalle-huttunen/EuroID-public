/**
 * Report Metadata Schema
 *
 * Stores metadata for generated compliance reports (SOX, ISO 27001).
 * Report content is stored as files; only metadata and file reference in MongoDB.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ReportType = 'SOX' | 'ISO27001';
export type ReportFormat = 'PDF' | 'CSV';

@Schema({ _id: false })
export class ReportDateRange {
  @Prop({ required: true, type: Date })
  from!: Date;

  @Prop({ required: true, type: Date })
  to!: Date;
}

export const ReportDateRangeSchema = SchemaFactory.createForClass(ReportDateRange);

@Schema({ _id: false })
export class ReportSummary {
  @Prop({ default: 0 })
  criticalFindings!: number;

  @Prop({ default: 0 })
  complianceScore!: number;
}

export const ReportSummarySchema = SchemaFactory.createForClass(ReportSummary);

@Schema({
  timestamps: true,
  collection: 'compliance_report_metadata',
})
export class ReportMetadata {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, unique: true })
  reportId!: string;

  @Prop({ required: true, enum: ['SOX', 'ISO27001'] })
  type!: ReportType;

  @Prop({ required: true, enum: ['PDF', 'CSV'] })
  format!: ReportFormat;

  @Prop({ type: ReportDateRangeSchema, required: true })
  dateRange!: ReportDateRange;

  @Prop({ required: true })
  generatedBy!: string;

  @Prop({ required: true, default: () => new Date() })
  generatedAt!: Date;

  @Prop({ required: true })
  fileSize!: number;

  @Prop({ required: true })
  filePath!: string;

  @Prop({ type: ReportSummarySchema, default: () => ({ criticalFindings: 0, complianceScore: 0 }) })
  summary!: ReportSummary;
}

export type ReportMetadataDocument = HydratedDocument<ReportMetadata>;
export const ReportMetadataSchema = SchemaFactory.createForClass(ReportMetadata);

ReportMetadataSchema.index({ tenantId: 1, generatedAt: -1 });
ReportMetadataSchema.index({ tenantId: 1, type: 1 });
