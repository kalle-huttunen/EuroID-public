import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * One HR ingest run, as reported by HR_SYNC_COMPLETED. Full runs (fetched rows, none skipped,
 * none failed) are what missing-from-source counts: a person is missing once the source's last
 * `missingSyncThreshold` full runs all started after the person was last delivered.
 */
@Schema({ collection: 'hr_sync_runs' })
export class HrSyncRun {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  sourceName!: string;

  @Prop({ required: true })
  connectorName!: string;

  @Prop({ required: true })
  startedAt!: Date;

  @Prop({ required: true })
  completedAt!: Date;

  @Prop({ required: true })
  fetched!: number;

  @Prop({ required: true })
  skipped!: number;

  @Prop({ required: true })
  ingested!: number;

  @Prop({ required: true })
  errorCount!: number;

  @Prop({ required: true })
  full!: boolean;
}

export type HrSyncRunDocument = HydratedDocument<HrSyncRun>;
export const HrSyncRunSchema = SchemaFactory.createForClass(HrSyncRun);

HrSyncRunSchema.index({ tenantId: 1, sourceName: 1, full: 1, startedAt: -1 });

const retentionDays = parseInt(process.env.HR_SYNC_RUN_RETENTION_DAYS || '180', 10) || 180;
HrSyncRunSchema.index({ completedAt: 1 }, { expireAfterSeconds: retentionDays * 86400 });
