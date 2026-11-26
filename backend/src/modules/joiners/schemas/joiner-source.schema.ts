import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * How far joiner detection has looked at one HR source's minted identities (one document per
 * tenant and source). The next run of the source records the identities created from it since
 * `recordedUntil`, so a run whose joiner detection failed or did not run (a failed leaver
 * detection) loses nobody: the next one records them.
 */
@Schema({ timestamps: true, collection: 'joiner_sources' })
export class JoinerSource {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  sourceName!: string;

  @Prop({ required: true })
  recordedUntil!: Date;
}

export type JoinerSourceDocument = HydratedDocument<JoinerSource>;
export const JoinerSourceSchema = SchemaFactory.createForClass(JoinerSource);

JoinerSourceSchema.index({ tenantId: 1, sourceName: 1 }, { unique: true });
