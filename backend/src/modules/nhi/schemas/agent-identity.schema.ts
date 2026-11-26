/**
 * Agent Identity Schema — first-class Non-Human Identity (NHI).
 *
 * AgentIdentity is kept in its own collection (not mixed into `identities`)
 * because its lifecycle, shape, and risk model differ from humans:
 *   - Mandatory human owner, short expiresAt window, scope list.
 *   - Attenuated delegation: a child agent's scope ⊆ parent scope and
 *     child.expiresAt ≤ parent.expiresAt.
 *   - Revocation is terminal; kill-switch is a stronger revocation that
 *     also triggers a critical SSF-style fan-out.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AgentKind = 'service-account' | 'workload' | 'ai-agent' | 'bot';
export type AgentStatus = 'active' | 'revoked' | 'expired';
export type AgentRiskTier = 'low' | 'medium' | 'high' | 'critical';
/** How the owner left: offboarded (or deleted from the hub) or erased (GDPR). */
export type OwnerlessReason = 'offboarded' | 'erased';

@Schema({ _id: false })
export class AgentOwner {
  /** Human Identity._id that is accountable for the agent. */
  @Prop({ required: true })
  identityId!: string;

  /** Denormalised for list views; kept in sync on creation only. */
  @Prop({ required: true })
  email!: string;
}

export const AgentOwnerSchema = SchemaFactory.createForClass(AgentOwner);

export type AgentIdentityDocument = HydratedDocument<AgentIdentity>;

@Schema({ timestamps: true, collection: 'agent_identities' })
export class AgentIdentity {
  /** Tenant-unique, caller-supplied agent identifier (e.g. "payroll-sync-bot"). */
  @Prop({ required: true })
  agentId!: string;

  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  displayName!: string;

  @Prop({ required: true, type: String, enum: ['service-account', 'workload', 'ai-agent', 'bot'] })
  kind!: AgentKind;

  @Prop({ type: AgentOwnerSchema, required: true })
  owner!: AgentOwner;

  /**
   * Capability strings (e.g. "hr:read", "entra:users:write"). The set is
   * tenant-defined; the service only enforces subset semantics on delegation.
   */
  @Prop({ type: [String], default: [] })
  scope!: string[];

  /** Ref to parent agentId (same tenant) when this agent was delegated. */
  @Prop()
  parentAgentId?: string;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop({
    type: String,
    enum: ['active', 'revoked', 'expired'],
    default: 'active',
    index: true,
  })
  status!: AgentStatus;

  @Prop()
  revokedAt?: Date;

  @Prop()
  revokedBy?: string;

  @Prop()
  revocationReason?: string;

  /**
   * Once engaged the agent is permanently dead: no rotation, no re-issuance,
   * and an SSF-compatible revocation signal has been emitted.
   */
  @Prop({ default: false })
  killSwitchEngaged!: boolean;

  @Prop({
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'low',
    index: true,
  })
  riskTier!: AgentRiskTier;

  /**
   * Set when the owner was offboarded or erased (NhiOwnershipService): the agent gets no new
   * credential until a super-admin gives it a new owner (which clears both) or revokes it.
   * Credentials issued before keep verifying until then.
   */
  @Prop()
  ownerlessSince?: Date;

  @Prop({ type: String, enum: ['offboarded', 'erased'] })
  ownerlessReason?: OwnerlessReason;

  /** SHA-256 fingerprint of the currently-issued credential material (hex). */
  @Prop()
  credentialFingerprint?: string;

  @Prop()
  lastRotatedAt?: Date;

  @Prop({ required: true })
  createdBy!: string;

  @Prop({ type: Object, default: {} })
  metadata?: Record<string, unknown>;
}

export const AgentIdentitySchema = SchemaFactory.createForClass(AgentIdentity);

AgentIdentitySchema.index({ tenantId: 1, agentId: 1 }, { unique: true });
AgentIdentitySchema.index({ tenantId: 1, 'owner.identityId': 1 });
AgentIdentitySchema.index({ tenantId: 1, parentAgentId: 1 }, { sparse: true });
AgentIdentitySchema.index({ tenantId: 1, expiresAt: 1 });
AgentIdentitySchema.index({ tenantId: 1, ownerlessSince: 1 }, { sparse: true });
