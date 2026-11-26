/**
 * Rollback snapshot: the state a bulk operation or a distributed transaction is about to
 * overwrite (an Entra account's attribute values, a Golden Record), kept so a rollback can put
 * it back.
 *
 * The state is personal data, so it is stored encrypted (EncryptionService) and only the
 * document id travels through the Temporal workflow history and the workflow result. Snapshots
 * are tenant-scoped and expire after ROLLBACK_SNAPSHOT_TTL_HOURS.
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { ROLLBACK_SNAPSHOT_TTL_HOURS } from '@infrastructure/config/defaults';

/**
 * entra-state: an Entra account's whole pre-change state (existed, objectId, attributes), keyed
 * per operation and system. entra-attributes: the attribute values only, unkeyed (results
 * recorded before entra-state). entra-account: the Entra account a distributed transaction
 * prepares (id, userPrincipalName, mail, displayName, accountEnabled). hub-identity: a Golden Record
 * before a bulk write. hub-conflict-flags: the conflict flags of the identity a low-confidence
 * match flagged during that write.
 */
export type RollbackSnapshotKind =
  | 'entra-attributes'
  | 'entra-state'
  | 'entra-account'
  | 'hub-identity'
  | 'hub-conflict-flags';

@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'rollback_snapshots' })
export class RollbackSnapshot {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, type: String })
  kind!: RollbackSnapshotKind;

  /** Idempotency key: a retried activity gets the first snapshot back instead of a new one. */
  @Prop({ type: String })
  key?: string;

  /** EncryptionService ciphertext of the JSON state. */
  @Prop({ required: true, type: String })
  ciphertext!: string;

  createdAt?: Date;
}

export type RollbackSnapshotDocument = HydratedDocument<RollbackSnapshot>;
export const RollbackSnapshotSchema = SchemaFactory.createForClass(RollbackSnapshot);

RollbackSnapshotSchema.index(
  { tenantId: 1, key: 1 },
  { unique: true, partialFilterExpression: { key: { $type: 'string' } } },
);
RollbackSnapshotSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: ROLLBACK_SNAPSHOT_TTL_HOURS * 3600 },
);
