/**
 * Labels for non-human identities and the rules the backend applies (`dtos/agent-identity.dto.ts`,
 * `nhi.service.ts`, `nhi-credential.service.ts`): the id and scope formats, the 90-day lifetime,
 * attenuated delegation and which statuses allow which action. Who a revoke or kill switch
 * reaches is the API's dry run. Statuses are the API's: nothing here decides from the browser's
 * clock that an agent expired.
 */
import dayjs, { type Dayjs } from 'dayjs';
import type { IdentityOption } from '@api/identity-api';
import type { AgentKind, AgentRiskTier, AgentStatus, IAgentIdentity } from '../../interfaces';

export const KIND_LABEL: Record<AgentKind, string> = {
  'service-account': 'Service account',
  workload: 'Workload',
  'ai-agent': 'AI agent',
  bot: 'Bot',
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
};

/** Ant Design Tag presets (theme-driven, no raw colors). */
export const STATUS_TAG: Record<AgentStatus, string> = {
  active: 'success',
  expired: 'warning',
  revoked: 'default',
};

export const RISK_LABEL: Record<AgentRiskTier, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export const RISK_TAG: Record<AgentRiskTier, string> = {
  low: 'success',
  medium: 'processing',
  high: 'warning',
  critical: 'error',
};

export const KINDS = Object.keys(KIND_LABEL) as AgentKind[];
export const STATUSES = Object.keys(STATUS_LABEL) as AgentStatus[];
export const RISK_TIERS = Object.keys(RISK_LABEL) as AgentRiskTier[];

/** The DTO's formats and caps. */
export const AGENT_ID_RE = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;
export const SCOPE_ENTRY_RE = /^[a-z][a-z0-9-]*(?::[a-z0-9*-]+){1,4}$/;
export const MAX_SCOPE_ENTRIES = 50;
export const MAX_LIFETIME_DAYS = 90;
export const MAX_CREDENTIAL_TTL_MINUTES = 60;
export const DEFAULT_CREDENTIAL_TTL_MINUTES = 15;

export const formatDateTime = (iso?: string) =>
  iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : undefined;

/** Why this person cannot own an agent (the API refuses an owner who is not ACTIVE). */
export function ownerProblem(identity: IdentityOption): string | undefined {
  return identity.status && identity.status !== 'ACTIVE'
    ? `not active (${identity.status})`
    : undefined;
}

/**
 * Why this expiry would be refused or shortened, else undefined: in the future, at most 90 days
 * from now (the API shortens a later one to 90 days), and for a delegated agent no later than its
 * parent's expiry (the API refuses a later one).
 */
export function expiryProblem(
  value: Dayjs | null | undefined,
  now: Dayjs,
  parentExpiresAt?: string,
): string | undefined {
  if (!value) return 'Choose when the agent expires';
  if (!value.isAfter(now)) return 'The expiry must be in the future';
  if (value.isAfter(now.add(MAX_LIFETIME_DAYS, 'day'))) {
    return `At most ${MAX_LIFETIME_DAYS} days from now`;
  }
  if (parentExpiresAt && value.isAfter(dayjs(parentExpiresAt))) {
    return `No later than the parent's expiry, ${formatDateTime(parentExpiresAt)}`;
  }
  return undefined;
}

/** The owner was offboarded or erased and nobody has re-owned or revoked the agent yet. */
export const isOwnerless = (agent: IAgentIdentity) =>
  !!agent.ownerlessSince && agent.status !== 'revoked';

export const OWNERLESS_REASON: Record<NonNullable<IAgentIdentity['ownerlessReason']>, string> = {
  offboarded: 'offboarded',
  erased: 'erased (GDPR)',
};

/** Why the action is not offered for this agent, or undefined when it is. */
export function delegateBlocker(agent: IAgentIdentity): string | undefined {
  return agent.status === 'active'
    ? undefined
    : `only an active agent can delegate; this one is ${STATUS_LABEL[agent.status].toLowerCase()}.`;
}

export function revokeBlocker(agent: IAgentIdentity): string | undefined {
  return agent.status === 'revoked' ? 'the agent is already revoked.' : undefined;
}

/** A revoked agent still takes the kill switch: the API flags, audits and signals it. */
export function killBlocker(agent: IAgentIdentity): string | undefined {
  return agent.killSwitchEngaged ? 'the kill switch is already engaged.' : undefined;
}

/** `signingEnabled` undefined: the status is unknown, so the API decides. */
export function issueBlocker(
  agent: IAgentIdentity,
  signingEnabled: boolean | undefined,
): string | undefined {
  if (agent.killSwitchEngaged) return 'the kill switch is engaged.';
  if (agent.status !== 'active') {
    return `the agent is ${STATUS_LABEL[agent.status].toLowerCase()}.`;
  }
  if (isOwnerless(agent)) return 'the agent has no owner: give it a new owner or revoke it.';
  if (signingEnabled === false) return 'credential signing is not configured on the API.';
  return undefined;
}

export const VERIFY_NOTE =
  'A relying party checks a credential with POST /api/v1/nhi/credentials/verify, which refuses it ' +
  'as soon as the agent is revoked, killed or expired. A check offline with the public key ' +
  '(GET /api/v1/nhi/_/public-key) cannot see that before the credential itself expires.';

export const NOT_RECALLED_NOTE =
  'A credential issued before stops verifying at EuroID at once. A relying party that checks it ' +
  'offline with the public key accepts it until its own expiry, at most one hour after it was ' +
  'issued.';
