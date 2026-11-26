/**
 * Non-human identities (backend `modules/nhi`, collection `agent_identities`): service accounts,
 * workloads, AI agents and bots. Written out from the Mongoose schema and the Zod DTOs: the
 * generated types carry no bodies for these routes. Every route takes the `agentId` slug, not
 * `_id`.
 */

export type AgentKind = 'service-account' | 'workload' | 'ai-agent' | 'bot';
export type AgentStatus = 'active' | 'revoked' | 'expired';
export type AgentRiskTier = 'low' | 'medium' | 'high' | 'critical';

/** One agent as GET /nhi (lean) and GET /nhi/:agentId answer it. */
export interface IAgentIdentity {
  _id: string;
  /** Tenant-unique slug; every route takes it. */
  agentId: string;
  tenantId: string;
  displayName: string;
  kind: AgentKind;
  /** The accountable person: the identity's `_id` and its work email as stored at creation. */
  owner: { identityId: string; email: string };
  scope: string[];
  /** Set when the agent was delegated from another agent. */
  parentAgentId?: string;
  expiresAt: string;
  /** The API marks an agent past its expiry `expired` before it answers any read. */
  status: AgentStatus;
  revokedAt?: string;
  revokedBy?: string;
  revocationReason?: string;
  /** Sticky: once true the agent can never get a credential again. */
  killSwitchEngaged: boolean;
  riskTier: AgentRiskTier;
  /** SHA-256 of the last issued credential's signature (not the credential). */
  credentialFingerprint?: string;
  /** When the last credential was issued. */
  lastRotatedAt?: string;
  /**
   * Set when the owner was offboarded or erased: no new credential until a super-admin gives the
   * agent a new owner (POST /nhi/:agentId/owner) or revokes it; credentials issued before work.
   */
  ownerlessSince?: string;
  ownerlessReason?: 'offboarded' | 'erased';
  createdBy: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** GET /nhi: one page (1-based) and the number of matches. */
export interface IAgentIdentityPage {
  data: IAgentIdentity[];
  total: number;
}

/** The list filters GET /nhi takes. */
export interface IAgentFilter {
  kind?: AgentKind;
  status?: AgentStatus;
  riskTier?: AgentRiskTier;
  ownerIdentityId?: string;
  /** true: only the agents whose owner left. */
  ownerless?: boolean;
}

/** One agent a revoke or kill switch reaches, as its dry run lists it. */
export type IReachedAgent = Pick<
  IAgentIdentity,
  'agentId' | 'displayName' | 'kind' | 'owner' | 'parentAgentId' | 'status' | 'expiresAt'
>;

/** POST /nhi/:agentId/revoke or /kill with ?dryRun=true: what the call would do, changing nothing. */
export interface IEndAgentPreview {
  dryRun: true;
  agentId: string;
  killSwitch: boolean;
  /** False when the call would change nothing (already revoked, or the switch already engaged). */
  changes: boolean;
  /** The delegated agents it would revoke too, depth first: a child, then its own delegates. */
  reached: IReachedAgent[];
}

/** POST /nhi and POST /nhi/:parentAgentId/delegate. */
export interface ICreateAgentBody {
  agentId: string;
  displayName: string;
  kind: AgentKind;
  /** The owner's identity `_id`. */
  ownerIdentityId: string;
  scope: string[];
  /** ISO 8601, in the future. */
  expiresAt: string;
}

/**
 * POST /nhi/:agentId/credentials: a detached Ed25519 signature over the canonical payload. A
 * bearer secret while it is valid; the API keeps only a fingerprint of the signature.
 */
export interface IAgentCredential {
  payload: {
    spiffeId: string;
    agentId: string;
    tenantId: string;
    scope: string[];
    issuedAt: string;
    expiresAt: string;
  };
  signature: string;
  keyFingerprint: string;
  algorithm: 'ed25519';
}
