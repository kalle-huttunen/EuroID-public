/**
 * Audit Chain Head Schema
 *
 * One document per tenant: the position of the tenant's last audit event in its hash chain.
 * AuditService links each new event to it and moves it forward after the event is stored, so
 * every process (API, worker) writes one chain in order. Created by the tenant's first write
 * after the chain head was introduced, from the newest event already in the log (or the genesis
 * hash for an empty log). Moves forward only.
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AuditChainHeadDocument = HydratedDocument<AuditChainHead>;

@Schema({ timestamps: true, collection: 'audit_chain_heads' })
export class AuditChainHead {
  @Prop({ required: true, type: String })
  tenantId!: string;

  /** `seq` of the tenant's last chained event; 0 before its first one. */
  @Prop({ required: true, type: Number, min: 0 })
  seq!: number;

  /** integrityHash of that event: the previousHash of the next one. */
  @Prop({ required: true, type: String })
  lastHash!: string;
}

export const AuditChainHeadSchema = SchemaFactory.createForClass(AuditChainHead);

// One head per tenant: two first writes at the same moment create one head between them
AuditChainHeadSchema.index({ tenantId: 1 }, { unique: true });
