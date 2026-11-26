/**
 * Zod DTOs for the NHI API boundary.
 *
 * Validation rules enforced here (the service re-checks the cross-field
 * invariants that can only be evaluated with access to the parent record):
 *   - agentId: URL-safe slug
 *   - scope entries: colon-segmented tokens
 *   - expiresAt: strict ISO 8601, must be in the future
 */
import { z } from 'zod';

const AGENT_ID_RE = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;
const SCOPE_ENTRY_RE = /^[a-z][a-z0-9-]*(?::[a-z0-9*-]+){1,4}$/;

/** Hard cap on credential TTL — keeps NHI creds short-lived. */
export const MAX_CREDENTIAL_TTL_SECONDS = 3600;

/** Hard cap on agent lifetime — 90 days. */
export const MAX_AGENT_LIFETIME_DAYS = 90;

const futureIsoDate = z
  .string()
  .datetime({ offset: true })
  .refine((s) => new Date(s).getTime() > Date.now(), {
    message: 'expiresAt must be in the future',
  });

export const CreateAgentIdentitySchema = z.object({
  agentId: z.string().regex(AGENT_ID_RE, 'agentId must be a lowercase slug'),
  displayName: z.string().min(1).max(200),
  kind: z.enum(['service-account', 'workload', 'ai-agent', 'bot']),
  ownerIdentityId: z.string().min(1).max(100),
  scope: z
    .array(
      z.string().regex(SCOPE_ENTRY_RE, 'scope entries must look like "domain:verb[:qualifier]"'),
    )
    .min(1, 'scope must contain at least one capability')
    .max(50, 'scope too large'),
  expiresAt: futureIsoDate,
  metadata: z.record(z.unknown()).optional(),
});
export type CreateAgentIdentityDto = z.infer<typeof CreateAgentIdentitySchema>;

export const DelegateAgentIdentitySchema = CreateAgentIdentitySchema.omit({ agentId: true }).extend(
  {
    agentId: z.string().regex(AGENT_ID_RE),
  },
);
export type DelegateAgentIdentityDto = z.infer<typeof DelegateAgentIdentitySchema>;

export const RevokeAgentIdentitySchema = z.object({
  reason: z.string().min(1).max(500),
});
export type RevokeAgentIdentityDto = z.infer<typeof RevokeAgentIdentitySchema>;

export const IssueCredentialSchema = z.object({
  ttlSeconds: z.number().int().positive().max(MAX_CREDENTIAL_TTL_SECONDS).default(900),
});
export type IssueCredentialDto = z.infer<typeof IssueCredentialSchema>;

export const ListAgentIdentitiesQuerySchema = z.object({
  ownerIdentityId: z.string().max(100).optional(),
  kind: z.enum(['service-account', 'workload', 'ai-agent', 'bot']).optional(),
  status: z.enum(['active', 'revoked', 'expired']).optional(),
  riskTier: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  /** true: only agents whose owner left; false: only the others. */
  ownerless: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListAgentIdentitiesQuery = z.infer<typeof ListAgentIdentitiesQuerySchema>;

/** POST /nhi/:agentId/owner: the agent's new owner, an active identity of the tenant. */
export const ReownAgentIdentitySchema = z.object({
  ownerIdentityId: CreateAgentIdentitySchema.shape.ownerIdentityId,
});
export type ReownAgentIdentityDto = z.infer<typeof ReownAgentIdentitySchema>;
