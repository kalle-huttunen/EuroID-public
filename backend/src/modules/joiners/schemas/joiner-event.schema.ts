import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * - waiting: minted by an HR sync and not onboarded yet. The source's next full sync looks at it
 *   again: the pipeline was not deployed (or paused), the start date was ahead, the run was
 *   partial or did not deliver the person, or the start failed (`startError`)
 * - pending-approval: in a paused batch, waiting for an admin
 * - started: the onboarding workflow started (workflowId)
 * - rejected: an admin rejected its batch; the joiner path never onboards the person
 * - superseded: closed without a start (`closeReason`): left in HR, offboarded by an HR leaver,
 *   deleted, already onboarded, or an onboarding run already in progress
 */
export type JoinerEventStatus =
  | 'waiting'
  | 'pending-approval'
  | 'started'
  | 'rejected'
  | 'superseded';

/** Statuses that may still lead to an onboarding. */
export const OPEN_JOINER_STATUSES: JoinerEventStatus[] = ['waiting', 'pending-approval'];

/**
 * One HR joiner: an identity an HR sync minted or revived as a rehire, and what became of its
 * onboarding. One per identity and hire (unique index on the identity and `rehiredAt`):
 * re-ingesting the same export, or a later sync, never raises it again; a rehire is a new hire.
 */
@Schema({ timestamps: true, collection: 'joiner_events' })
export class JoinerEvent {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  identityId!: string;

  /** The source whose sync minted (or revived) the identity; its full syncs start the onboarding. */
  @Prop({ required: true })
  sourceName!: string;

  /**
   * Set for a rehire: when the source's sync revived the soft-deleted identity
   * (identity metadata.rehiredAt). Unset for an identity the sync minted.
   */
  @Prop()
  rehiredAt?: Date;

  @Prop({
    required: true,
    type: String,
    enum: ['waiting', 'pending-approval', 'started', 'rejected', 'superseded'],
  })
  status!: JoinerEventStatus;

  /** True while the status is open (OPEN_JOINER_STATUSES). */
  @Prop({ required: true })
  open!: boolean;

  @Prop({ required: true })
  detectedAt!: Date;

  @Prop()
  batchId?: string;

  @Prop()
  workflowId?: string;

  @Prop()
  startedAt?: Date;

  /** Last failed start attempt of a waiting joiner. */
  @Prop()
  startError?: string;

  /**
   * Why a waiting joiner last waited (JoinerWaitReason, joiner-candidates.ts). Kept so the
   * identity timeline shows "start date unreadable" once, not at every sync.
   */
  @Prop()
  waitReason?: string;

  /** Why a superseded or rejected joiner closed without an onboarding. */
  @Prop()
  closeReason?: string;

  /** Actor of the batch decision (authenticated user), for batch members. */
  @Prop()
  decidedBy?: string;
}

export type JoinerEventDocument = HydratedDocument<JoinerEvent>;
export const JoinerEventSchema = SchemaFactory.createForClass(JoinerEvent);

// Existing databases get it, and lose the older { tenantId, identityId } unique index, from
// migrations/20261123000000-joiner-events-one-per-hire.
JoinerEventSchema.index({ tenantId: 1, identityId: 1, rehiredAt: 1 }, { unique: true });
JoinerEventSchema.index({ tenantId: 1, status: 1, sourceName: 1 });
JoinerEventSchema.index({ tenantId: 1, batchId: 1 });
