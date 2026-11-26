/**
 * The credential envelope as a relying party sends it to POST /nhi/credentials/verify: the body
 * POST /nhi/:agentId/credentials answered, unchanged. Zod checks its shape only (an unknown field
 * or a missing one is a 400). Whether it is genuine, unexpired, for the caller's tenant and of an
 * agent still active is NhiCredentialService.verify's answer (`active: false` with a reason).
 *
 * The payload's tenantId is the signed issuing tenant. verify() compares it with the tenant of the
 * request context and answers inactive when they differ; no query is scoped by it.
 */
import { z } from 'zod';

const isoTime = z.string().datetime({ offset: true });

export const AgentCredentialSchema = z
  .object({
    payload: z
      .object({
        spiffeId: z.string().max(512),
        agentId: z.string().max(64),
        tenantId: z.string().max(200),
        scope: z.array(z.string().max(200)).max(50),
        issuedAt: isoTime,
        expiresAt: isoTime,
      })
      .strict(),
    signature: z.string().max(256),
    keyFingerprint: z.string().max(128),
    algorithm: z.string().max(32),
  })
  .strict();
export type AgentCredentialEnvelope = z.infer<typeof AgentCredentialSchema>;
