import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AgentDocument = HydratedDocument<Agent>;

export type AgentStatus = 'online' | 'offline' | 'degraded' | 'decommissioned';

@Schema({ timestamps: true, collection: 'agents' })
export class Agent {
  /** Unique per tenant only (index below); migration 20261122000000 drops the old global index. */
  @Prop({ required: true })
  agentId!: string;

  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ type: String, default: 'offline' })
  status!: AgentStatus;

  @Prop({ type: [String], default: [] })
  connectorTypes!: string[];

  @Prop({ required: true })
  taskQueue!: string;

  @Prop({ type: Date })
  lastHeartbeat?: Date;

  @Prop()
  version?: string;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;

  @Prop()
  certificate?: string;

  @Prop({ type: Date })
  registeredAt?: Date;

  @Prop({ type: Date })
  decommissionedAt?: Date;
}

export const AgentSchema = SchemaFactory.createForClass(Agent);

AgentSchema.index({ tenantId: 1, agentId: 1 }, { unique: true });
AgentSchema.index({ tenantId: 1, status: 1 });
