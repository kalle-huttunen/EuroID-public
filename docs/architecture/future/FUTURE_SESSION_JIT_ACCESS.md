# FUTURE: Session-Based Just-in-Time (JIT) Access

> **Status:** Not implemented. Architecture draft for future development. What exists today: a linked admin account (PAM) is disabled in the target systems outside a privileged session, which enables it for the tier's maximum session length (`privilegedSessionWorkflow`, `backend/src/modules/privileged-access/docs/ARCHITECTURE.md`). There is no approval, credential checkout, vault or session recording.

## Overview

EuroID supports **time-bound access** (request access for N days, auto-expire). Session-based JIT goes further: access is only "live" during an active, audited session. The user checks in, receives temporary credentials, performs their work, and checks out — at which point credentials are immediately revoked. This is the evolution of EuroID's existing time-bound + PAM + break-glass features into a full privileged session management capability.

---

## Problem Statement

- Time-bound access grants are active 24/7 for the duration — even when the user is not working
- PAM admin accounts persist between uses; credentials are long-lived
- No session recording or command-level audit for privileged operations
- Break-glass access has no automatic checkout — relies on manual token expiry
- Compliance frameworks (SOC 2 CC6.1, NIST AC-2(2)) require session-level access control for privileged accounts

---

## Proposed Architecture

### Session Lifecycle

```
User requests JIT session for Tier 0 entitlement
        │
        ▼
  AccessRequestPortal ──▶ JIT Session Request
        │                  (entitlement, justification, max duration)
        │
        ▼
  Approval workflow (existing) ──▶ APPROVED
        │
        ▼
  JitSessionService.checkIn()
        │
        ├── Generate temporary credentials (password/API key)
        ├── Provision to target via connector
        ├── Store credentials in vault (time-locked)
        ├── Start session timer (Temporal workflow)
        ├── Emit JIT_SESSION_STARTED event
        │
        ▼
  User works (session active, timer ticking)
        │
        ├── Heartbeat: user confirms still active (configurable interval)
        │   └── No heartbeat → auto-checkout after grace period
        │
        ▼
  User clicks "Check Out" OR timer expires
        │
        ▼
  JitSessionService.checkOut()
        │
        ├── Revoke temporary credentials in target
        ├── Purge from vault
        ├── Emit JIT_SESSION_ENDED event
        ├── Log session duration + activity summary
        └── Return to pre-session state
```

---

## Component Overview

| Component | Path (Proposed) | Responsibility |
|-----------|-----------------|----------------|
| JitSessionService | `modules/privileged-access/jit-session.service.ts` | Check-in/check-out orchestration |
| JitSessionController | `modules/privileged-access/jit-session.controller.ts` | REST API for session management |
| jitSessionWorkflow | `workflows/jit-session.workflow.ts` | Temporal workflow: timer, heartbeat, auto-checkout |
| JitSession schema | `modules/privileged-access/schemas/jit-session.schema.ts` | Session state persistence |

---

## Session Schema

```typescript
// Collection: jit_sessions
{
  tenantId: string,
  identityId: string,
  entitlementId: string,
  targetSystem: string,

  status: 'PENDING_APPROVAL' | 'CHECKED_IN' | 'CHECKED_OUT' | 'EXPIRED' | 'FORCE_REVOKED',

  // Timing
  requestedAt: Date,
  checkedInAt: Date,
  checkedOutAt: Date,
  maxDurationMinutes: number,
  expiresAt: Date,                    // checkedInAt + maxDurationMinutes

  // Credentials (reference only — actual values in vault)
  credentialVaultPath: string,
  credentialType: 'PASSWORD' | 'API_KEY' | 'CERTIFICATE',

  // Audit
  heartbeats: Date[],                 // Timestamps of activity confirmations
  checkoutReason: 'USER' | 'TIMEOUT' | 'HEARTBEAT_MISSED' | 'ADMIN_REVOKE',
  workflowId: string,                 // Temporal workflow ID
}
```

---

## API Endpoints (Proposed)

| Method | Path | Role | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/jit-sessions` | operator | Request JIT session (triggers approval if required) |
| `POST` | `/api/v1/jit-sessions/:id/check-in` | operator | Check in and receive credentials |
| `POST` | `/api/v1/jit-sessions/:id/heartbeat` | operator | Confirm still active |
| `POST` | `/api/v1/jit-sessions/:id/check-out` | operator | Check out and revoke |
| `POST` | `/api/v1/jit-sessions/:id/force-revoke` | super-admin | Force-revoke active session |
| `GET` | `/api/v1/jit-sessions` | operator | List my sessions |
| `GET` | `/api/v1/jit-sessions/active` | super-admin | All active sessions (admin view) |

---

## Temporal Workflow

```typescript
// jit-session.workflow.ts (conceptual)
export async function jitSessionWorkflow(args: JitSessionArgs): Promise<void> {
  // 1. Wait for check-in signal (max 30 min after approval)
  const checkedIn = await condition(() => state.checkedIn, '30m');
  if (!checkedIn) { await expireSession(); return; }

  // 2. Provision temporary credentials
  await provisionTemporaryCredentials(args);

  // 3. Run session timer with heartbeat monitoring
  while (!state.checkedOut && !state.expired) {
    // Wait for heartbeat or checkout signal, with timeout
    const received = await condition(
      () => state.checkedOut || state.heartbeatReceived,
      `${args.heartbeatIntervalMinutes}m`
    );

    if (state.checkedOut) break;

    if (!received) {
      // Missed heartbeat — grace period
      const graceReceived = await condition(
        () => state.checkedOut || state.heartbeatReceived,
        '5m'
      );
      if (!graceReceived) {
        state.checkedOut = true;
        state.checkoutReason = 'HEARTBEAT_MISSED';
        break;
      }
    }

    state.heartbeatReceived = false; // Reset for next cycle

    // Check max duration
    if (Date.now() > state.expiresAt) {
      state.checkedOut = true;
      state.checkoutReason = 'TIMEOUT';
      break;
    }
  }

  // 4. Revoke credentials
  await revokeTemporaryCredentials(args);
}
```

---

## Integration with Existing PAM

| Existing Feature | JIT Enhancement |
|-----------------|-----------------|
| Linked admin accounts | JIT sessions provision temporary credentials on the linked account |
| Tier 0/1/2 classification | Tier 0 always requires JIT; Tier 1 configurable; Tier 2 standard access |
| Break-glass | Break-glass bypasses approval but still creates a JIT session with forced audit |
| Access requests | JIT sessions are a variant of access requests with session lifecycle |
| Risk scoring | Active JIT session count becomes a risk factor |

---

## Security Considerations

- **Credential isolation:** Temporary credentials stored ONLY in external vault; never in MongoDB
- **Session recording:** Future extension — proxy session traffic for command-level audit
- **Concurrent sessions:** Configurable max concurrent JIT sessions per identity (default: 1 for Tier 0)
- **Network binding:** Optional: bind session to requesting IP (reject credentials from different IP)
- **Dual approval:** Tier 0 JIT sessions require two approvers

---

## Implementation Checklist

- [ ] Create `jit_sessions` schema and `JitSessionService` (check-in/check-out orchestration)
- [ ] Create `JitSessionController` with proposed API endpoints (request, check-in, heartbeat, check-out, force-revoke, list)
- [ ] Create `jitSessionWorkflow` Temporal workflow (timer, heartbeat monitoring, auto-checkout on missed heartbeat or expiry)
- [ ] Implement temporary credential generation and vault storage (integrate with `FUTURE_CREDENTIAL_LIFECYCLE` vault adapters)
- [ ] Implement credential revocation on check-out (revoke in target system, purge from vault)
- [ ] Integrate with existing PAM: Tier 0 always requires JIT, configurable for Tier 1, break-glass creates forced-audit JIT session
- [ ] Add active JIT session count as risk factor in `RiskScoringService`
- [ ] Enforce security: concurrent session limits, optional IP binding, dual approval for Tier 0
- [ ] Add unit and integration tests for session lifecycle, heartbeat, and credential management
- [ ] Update API_CHANGELOG.md and privileged-access docs

---

## Related Docs

| Doc | Relevance |
|-----|-----------|
| `../../../backend/src/modules/privileged-access/docs/ARCHITECTURE.md` | PAM foundation this extends |
| `../../../backend/src/modules/access-requests/docs/ARCHITECTURE.md` | JIT requests flow through approval workflow |
| `FUTURE_CREDENTIAL_LIFECYCLE.md` | Credential generation and vault storage |
| `../infrastructure/TEMPORAL_WORKFLOWS.md` | Workflow pattern for session timer |
