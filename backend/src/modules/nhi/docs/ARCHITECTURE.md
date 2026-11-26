# NHI (Non-Human Identity) Module

## Purpose

First-class domain for **service accounts, workload identities, AI agents, and
bots**. Keeps them out of the human `Identity` onion so they can be modelled
directly: mandatory owner, short expiry, attenuated delegation, kill-switch.

Everything a human Identity is not:

| Human Identity              | Agent Identity (NHI)                         |
| --------------------------- | -------------------------------------------- |
| HR-source-of-truth driven   | Caller-created via API                       |
| Long-lived                  | ≤ 90 day lifetime (hard cap)                 |
| No explicit scope           | Required, attenuating delegation             |
| No kill-switch              | Sticky kill-switch                           |
| Password / MFA credentials  | Short-lived Ed25519 credentials (≤ 1 h)      |

## Schema

`AgentIdentity` (collection: `agent_identities`)

- `agentId` — tenant-unique slug.
- `tenantId` — always scoped.
- `owner.identityId` + `owner.email` — human accountability (required, active).
- `kind` — `service-account | workload | ai-agent | bot`.
- `scope` — capability strings (e.g. `hr:read`, `entra:users:write`).
- `parentAgentId` — set when delegated, in the write that creates the agent.
- `expiresAt` — mandatory, clamped to ≤ 90 days.
- `status` — `active | revoked | expired`.
- `killSwitchEngaged` — sticky; once true, no rotation, no re-issue.
- `riskTier` — `low | medium | high | critical` (heuristic).
- `credentialFingerprint`, `lastRotatedAt` — last-issued cred metadata.
- `ownerlessSince`, `ownerlessReason` (`offboarded | erased`) — set when the
  owner left (invariant 6).

## Invariants enforced in the service

1. **Owner must be an active, non-deleted human Identity.**
2. **`expiresAt` ≤ createdAt + 90 days** (server clamp, not client trust).
3. **Attenuated delegation.** `child.scope ⊆ parent.scope` and
   `child.expiresAt ≤ parent.expiresAt`. Violations are hard errors.
4. **Cascading revocation.** Revoking a parent revokes every active descendant:
   each delegated agent stored as `active`, then its own, depth first
   (`walkCascade`), also below a delegated agent that is revoked or expired.
   Each level adds `cascade: ` to the reason. The cascade runs on every call,
   also on an agent already revoked, so calling again completes a cascade that
   failed part way through (an audit write, a database error). The agent detail
   offers it to a super-admin as [Finish cascade] when the dry run of the call
   that ended the agent still reaches active delegates. A delegate whose
   parent is revoked between its check and the child's write revokes the child
   as the cascade would have (killed when the parent's switch is engaged) and
   answers 409. `?dryRun=true` on
   `POST /revoke` and `POST /kill` (`previewRevoke`) walks the same code, writes
   nothing (not even an expiry) and answers what the call would reach, so the
   preview and the call cannot differ.
5. **Kill-switch is sticky.** Once engaged, the agent cannot be resurrected.
   On an agent already revoked, `POST /kill` still engages it: it sets
   `killSwitchEngaged`, writes the critical audit entry and emits
   `nhi.kill_switch_engaged`, and keeps the first revocation's time, actor and
   reason. A revoke of a revoked agent, or a second kill, changes the agent no
   further; it still revokes any delegated agent left active.
6. **An owner who leaves makes the agent ownerless.** When the owner's
   offboarding has run (`identity.offboarding_completed`) or the identity is
   deleted from the hub (`identity.deleted`), `NhiOwnerLeftHandler` marks the
   owner's agents that are not revoked (`NhiOwnershipService.markOwnerless`):
   `ownerlessSince`, `ownerlessReason: offboarded`, a warning audit entry
   `AGENT_IDENTITY_OWNERLESS` and the event `nhi.owner_lost` per agent, once.
   A GDPR erasure of the owner marks the ones not marked yet (and not revoked)
   through the same `markOwnerless`, with `erased`, the same audit entry and
   `nhi.owner_lost` (ids only, no personal data of the owner); its redaction
   then sets the owner email of every agent of the owner to `(erased)` and
   marks a revoked one too, without an entry (`gdpr-erasure-scope.ts`; the
   erasure's attestation counts them). An ownerless agent gets no new
   credential (409 "has no owner ... give it a new owner or revoke it");
   credentials issued before keep verifying until they expire, so an
   integration does not break silently. A super-admin gives it a new, active
   owner with `POST /:agentId/owner` (audit `AGENT_IDENTITY_OWNER_CHANGED`,
   event `nhi.owner_changed`), which clears the mark, or revokes it. A revoked
   agent keeps its owner (409). An owner who is only suspended does not make
   the agent ownerless. Migration `20261126000006-nhi-ownerless-backfill`
   marked the agents of owners who had left before.
6. **Expiry on read.** `list` and `get` (so `mustGet` and every write) first
   mark the tenant's agents past `expiresAt` `expired` with one conditional
   update (`expireDue`: only agents still `active`, so a revoke that lands first
   is never overwritten). `GET /nhi` and `GET /nhi/:agentId` answer `expired`
   for them and `GET /nhi?status=expired` finds them, without a cron.

## Credential issuance

Handled by `NhiCredentialService`, wholly separate from the Credential Lifecycle
module (which tracks human passwords / MFA).

- Credential = SPIFFE-compatible envelope:
  - `spiffeId` = `spiffe://{trustDomain}/tenants/{tenantId}/agents/{agentId}`.
  - Payload (canonical JSON) = `{ spiffeId, agentId, tenantId, scope, issuedAt, expiresAt }`.
  - Signature = detached Ed25519 (`crypto.sign(null, msg, privateKey)`),
    same algorithm we use for the audit anchor.
- TTL clamped to `MAX_CREDENTIAL_TTL_SECONDS = 3600` and further clamped to
  the agent's own `expiresAt`.
- Signing key is `NHI_SIGNING_PRIVATE_KEY` (PEM). **If unset, issuance throws** —
  we never fall back to insecure mode.
- Verification: `POST /api/v1/nhi/credentials/verify` (viewer) takes the
  envelope the issue route answered and calls `verify(tenantId, envelope)`,
  shaped like OAuth token introspection (RFC 7662). It answers
  `{ active: true, agentId, scope, expiresAt }` or `{ active: false, reason }`
  and never throws for a bad credential. Checks, in order, the first failure
  being the reason:

  | Check | Reason when it fails |
  | ----- | -------------------- |
  | a signing key is loaded | `credential signing is not configured` |
  | `algorithm` is `ed25519` | `unsupported algorithm` |
  | `keyFingerprint` is the loaded key's | `signed with another key` |
  | `signature` is 128 hex characters | `malformed signature` |
  | the signature verifies over the canonical payload | `invalid signature` |
  | the payload's `expiresAt` is in the future | `credential expired` |
  | the payload's `tenantId` is the caller's (request context) | `issued for another tenant` |
  | the agent exists in that tenant | `agent not found` |
  | its kill switch is not engaged | `kill switch engaged` |
  | it is `active` (read with expiry on read) | `agent revoked`, `agent expired` |

  The signature and the tenant are checked before any read, so a forged or
  foreign credential learns nothing about the tenant's agents. A body that is
  not an envelope (a missing or unknown field, a bad time) is a 400 from the
  Zod schema in `dtos/agent-credential.dto.ts`. Verifying is a read and, like
  the other reads, writes no audit entry; an inactive answer is logged with
  its reason.
- Public key: `GET /api/v1/nhi/_/public-key` (viewer) answers
  `{ algorithm, keyFingerprint, trustDomain, publicKeyPem, jwk }` (JWK with
  `kid` = the fingerprint, `alg: 'EdDSA'`, `use: 'sig'`); 404 without a key.
  A relying party checks a credential offline by verifying the hex-decoded
  `signature` with the key over the UTF-8 bytes of
  `JSON.stringify({ spiffeId, agentId, tenantId, scope: sorted, issuedAt, expiresAt })`
  (`canonicalCredentialPayload`) and checking `expiresAt` itself. An offline
  check cannot see a revoke, kill switch or expiry of the agent before the
  credential itself expires (at most 1 h); the verify route can. The route
  needs a EuroID token like every NHI route.
- Issuance emits `nhi.credential_issued` so an SSF emitter can mirror it.

## Events emitted

All wired through the standard `DomainEventEmitterService` (outbox-safe).

| Event                            | Aggregate     | Notes                                               |
| -------------------------------- | ------------- | --------------------------------------------------- |
| `nhi.created`                    | `agentId`     | includes kind, owner, riskTier                      |
| `nhi.delegated`                  | `childAgentId`| includes parentAgentId                              |
| `nhi.revoked`                    | `agentId`     | `killSwitch: false`                                 |
| `nhi.kill_switch_engaged`        | `agentId`     | `killSwitch: true`, severity `critical` in audit    |
| `nhi.credential_issued`          | `agentId`     | spiffeId + fingerprint + expiresAt                  |
| `nhi.credential_rotated`         | `agentId`     | (same payload shape as issued)                      |
| `nhi.owner_lost`                 | `agentId`     | ownerIdentityId, reason `offboarded` or `erased` (warning audit) |
| `nhi.owner_changed`              | `agentId`     | previousOwnerIdentityId, ownerIdentityId            |

Consumers currently wired:

- `AuditService.log(...)` — every lifecycle action, with `AGENT_IDENTITY_*`
  actions. `kill_switch_engaged` is `critical` severity.
- **Deferred:** a Shared Signals (SSF) emitter that subscribes to
  `nhi.revoked` / `nhi.kill_switch_engaged` and fans out to external receivers.
  The events already carry the information required; the emitter itself is a
  follow-up task.

## API surface

All routes are tenant-scoped via `getRequestContext()`.

| Method | Path                                       | Role          | Purpose                                        |
| ------ | ------------------------------------------ | ------------- | ---------------------------------------------- |
| GET    | `/api/v1/nhi`                              | `viewer`      | List (filter: owner, kind, status, riskTier, ownerless) |
| GET    | `/api/v1/nhi/:agentId`                     | `viewer`      | Get one                                        |
| POST   | `/api/v1/nhi`                              | `super-admin` | Create                                         |
| POST   | `/api/v1/nhi/:parentAgentId/delegate`      | `super-admin` | Create sub-agent (scope must be subset)        |
| POST   | `/api/v1/nhi/:agentId/revoke`              | `super-admin` | Terminal revocation; `?dryRun=true` previews   |
| POST   | `/api/v1/nhi/:agentId/kill`                | `super-admin` | Engage kill-switch (sticky, critical fan-out); `?dryRun=true` previews |
| POST   | `/api/v1/nhi/:agentId/owner`               | `super-admin` | New owner (active person); ends ownerless      |
| POST   | `/api/v1/nhi/:agentId/credentials`         | `super-admin` | Issue short-lived signed credential            |
| POST   | `/api/v1/nhi/credentials/verify`           | `viewer`      | Introspect a credential (`active`, `reason`)   |
| GET    | `/api/v1/nhi/_/public-key`                 | `viewer`      | Signing public key (PEM, JWK) for offline checks |
| GET    | `/api/v1/nhi/_/credential-signing-status`  | `super-admin` | Whether signing is configured                  |

## UI

Identities > Non-human identities (`/nhi`, `frontend/src/features/nhi/`, Flow 23
in `docs/USER_FLOWS.md`). Every role lists, filters (kind, status, risk tier,
ownership, owner) and opens an agent; an ownerless agent is tagged Ownerless and
its detail says since when and why it gets no credential.
A super-admin gives it a new owner there ([Change owner]). A super-admin also gets what the super-admin routes
allow, each gated like its route:

- Create and delegate, with the rules above shown before submit: an owner who
  is an active person, a lowercase id, scope entries like `hr:read`, an expiry
  at most 90 days away, and for a sub-agent only the parent's scope entries and
  no later expiry than the parent's.
- Revoke and kill switch, each confirmed after the API's dry run of the same
  call (`?dryRun=true`) lists the delegated agents the cascade reaches. If it
  cannot load, the action stays available with a warning. The kill switch needs
  the agent id typed. A revoked agent is offered only the kill switch (until it
  is engaged), which still flags it, audits it, signals it and reaches its
  active delegated agents; it keeps its first revocation's time, actor and
  reason.
- Issue a credential (1 to 60 minutes). It is shown once, kept only in the
  modal's state and discarded on close. The modal names the verify route and
  the public key route, and says an offline check cannot see a revocation.
- The signing status (`GET /nhi/_/credential-signing-status`); issuing is
  disabled with the reason when it is off.

The page shows the status the API returns and does not decide expiry from the
browser's clock.

## What is intentionally deferred

- **Real KMS integration.** The signing key is currently loaded from env
  (matching the audit-anchor pattern). Moving to a KMS / HSM is a follow-up.
- **SSF (Shared Signals) outbound emitter.** Events are emitted; the HTTP
  fan-out adapter is not wired yet.
- **Policy-engine integration for NHI access requests.** Agents can be
  referenced by the policy engine because they have a stable `spiffeId`, but
  the ABAC rules treating them as principals are a separate task.
- **Key rotation and a trust bundle.** One signing key at a time: a new
  `NHI_SIGNING_PRIVATE_KEY` makes every credential signed with the old one
  `signed with another key`. The public key is served only to authenticated
  callers; there is no unauthenticated JWKS or SPIFFE trust bundle endpoint.
