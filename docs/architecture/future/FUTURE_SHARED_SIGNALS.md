# FUTURE: Shared Signals Framework (SSF) & Continuous Access Evaluation (CAEP)

> **Status:** Not implemented. There is no `backend/src/modules/shared-signals/` and no SSF receiver, SET transmitter or CAEP event mapping in `backend/src`.

## Overview

The OpenID Shared Signals Framework (SSF) and Continuous Access Evaluation Protocol (CAEP) enable **real-time security signal exchange** between identity providers, relying parties, and governance platforms. When an IdP detects a compromised session, EuroID should receive that signal and trigger re-evaluation. When EuroID detects an anomaly, downstream systems should know immediately.

This is the standards-based complement to the SIEM webhook integration (see `FUTURE_SIEM_INTEGRATION.md`).

---

## Problem Statement

- EuroID detects anomalies (peer deviation, velocity, privilege escalation) but only stores them internally
- No inbound signal consumption: if Okta/Entra ID detects a compromised account, EuroID doesn't know
- No outbound signal propagation: if EuroID revokes access, relying parties learn only on next sync
- Access decisions are based on **point-in-time** evaluation, not **continuous** evaluation
- Modern zero-trust architectures require real-time signal propagation

---

## Standards

| Standard | Spec | Purpose |
|----------|------|---------|
| **OpenID SSF** | [openid.net/specs/openid-sse-framework-1_0](https://openid.net/specs/openid-sharedsignals-framework-1_0.html) | Framework for transmitting and receiving security events between systems |
| **CAEP** | [openid.net/specs/openid-caep-1_0](https://openid.net/specs/openid-caep-specification-1_0.html) | Event types for continuous access evaluation |
| **SET** | RFC 8417 | Security Event Token format (JWT-based) |
| **RISC** | OpenID RISC | Risk Incident Sharing and Coordination events |

---

## Proposed Architecture

### Component Overview

| Component | Path (Proposed) | Responsibility |
|-----------|-----------------|----------------|
| SsfReceiverController | `modules/shared-signals/ssf-receiver.controller.ts` | Inbound SSF endpoint (POST /.well-known/sse) |
| SsfTransmitterService | `modules/shared-signals/ssf-transmitter.service.ts` | Outbound event publishing to registered receivers |
| SsfStreamService | `modules/shared-signals/ssf-stream.service.ts` | Stream management (create, update, delete, status) |
| CaepEventMapper | `modules/shared-signals/caep-event.mapper.ts` | Map EuroID events ↔ CAEP event types |
| SignalEvaluationService | `modules/shared-signals/signal-evaluation.service.ts` | Process inbound signals → trigger re-evaluation |

### Signal Flow

```
                    INBOUND (Receiver)
    ┌─────────────────────────────────────────────┐
    │  Okta / Entra ID / Google                    │
    │     │                                        │
    │     ▼                                        │
    │  SSF Transmitter ──SET (JWT)──▶ EuroID       │
    │                                  │           │
    │                        SsfReceiverController │
    │                                  │           │
    │                        SignalEvaluationService│
    │                                  │           │
    │                        ┌─────────┴────────┐  │
    │                        │                  │  │
    │                  Re-evaluate         Create  │
    │                  risk score         anomaly  │
    │                  + policies         record   │
    └─────────────────────────────────────────────┘

                    OUTBOUND (Transmitter)
    ┌─────────────────────────────────────────────┐
    │  EuroID anomaly.detected                     │
    │     │                                        │
    │     ▼                                        │
    │  CaepEventMapper ──▶ SET (JWT)               │
    │     │                                        │
    │     ▼                                        │
    │  SsfTransmitterService ──POST──▶ Receiver    │
    │                                  (Okta,      │
    │                                   Entra,     │
    │                                   SIEM)      │
    └─────────────────────────────────────────────┘
```

---

## CAEP Event Mapping

### Inbound (EuroID receives)

| CAEP Event Type | EuroID Action |
|----------------|---------------|
| `session-revoked` | Trigger immediate access re-evaluation; mark identity as HIGH risk |
| `credential-change` | Flag for review; update risk score factor |
| `token-claims-change` | Re-sync identity attributes from source |
| `compliance-change` | Update compliance posture; trigger access review if needed |
| `assurance-level-change` | Adjust trust level for policy evaluation |
| `device-compliance-change` | Factor into risk scoring (future) |

### Outbound (EuroID transmits)

| EuroID Event | CAEP Event Type | When |
|-------------|----------------|------|
| `anomaly.detected` (PRIVILEGE_ESCALATION) | `compliance-change` | Rapid privilege increase detected |
| `anomaly.detected` (PEER_DEVIATION) | `assurance-level-change` | Unusual access pattern |
| Identity TERMINATED | `session-revoked` | User offboarded |
| Emergency access used | `credential-change` | Break-glass token consumed |
| SoD violation detected | `compliance-change` | Toxic combination granted |
| Access review: access revoked | `token-claims-change` | Entitlement removed during review |

---

## Stream Configuration Schema

```typescript
// Collection: ssf_streams
{
  tenantId: string,
  direction: 'INBOUND' | 'OUTBOUND',
  status: 'ENABLED' | 'PAUSED' | 'DISABLED',

  // SSF stream metadata
  streamId: string,                     // Unique stream identifier
  issuer: string,                       // JWT issuer (inbound: IdP; outbound: EuroID)
  audience: string,                     // JWT audience

  // Inbound: which IdP sends events to us
  inbound?: {
    jwksUri: string,                    // IdP's JWKS for SET verification
    supportedEvents: string[],          // CAEP event types we accept
  },

  // Outbound: where we send events
  outbound?: {
    endpoint: string,                   // Receiver's SSF endpoint
    bearerToken: string,                // Encrypted auth token
    deliveryMethod: 'PUSH' | 'POLL',   // SSF delivery method
    eventsRequested: string[],          // CAEP event types receiver wants
  },

  createdAt: Date,
  updatedAt: Date,
}
```

---

## Security Considerations

- **SET verification:** Inbound SETs are JWTs — verify signature against IdP's JWKS, validate `iss`, `aud`, `iat`
- **Outbound signing:** EuroID signs outbound SETs with its own private key; receivers verify via `/.well-known/jwks.json`
- **Replay protection:** Track `jti` (JWT ID) of processed SETs; reject duplicates
- **Rate limiting:** Inbound streams rate-limited per issuer; outbound delivery capped per receiver
- **SSRF:** Outbound endpoints validated via `validateUrlForFetch()`

---

## Prerequisites

- Existing: `AnomalyService`, `RiskScoringService`, `DomainEventEmitterService`, anomaly event types
- New: JWKS endpoint for EuroID (may already exist for OIDC auth)
- Infra: None required beyond existing HTTP capabilities

---

## Implementation Checklist

- [ ] Create `ssf_streams` schema and `SsfStreamService` (stream management: create, update, delete, status)
- [ ] Create `SsfReceiverController` (inbound SSF endpoint with SET/JWT verification against IdP JWKS)
- [ ] Create `SsfTransmitterService` (outbound SET signing with EuroID private key, delivery to registered receivers)
- [ ] Create `CaepEventMapper` (bidirectional mapping: EuroID domain events to/from CAEP event types)
- [ ] Create `SignalEvaluationService` (process inbound signals: trigger risk score recalculation, create anomaly records, re-evaluate policies)
- [ ] Implement replay protection (track `jti` of processed SETs, reject duplicates)
- [ ] Implement SSRF validation for outbound endpoints and rate limiting per issuer/receiver
- [ ] Expose EuroID JWKS endpoint (`/.well-known/jwks.json`) for outbound SET verification
- [ ] Add unit and integration tests for receiver, transmitter, event mapping, and signal evaluation
- [ ] Update API_CHANGELOG.md and backend README inventory

---

## Related Docs

| Doc | Relevance |
|-----|-----------|
| `FUTURE_SIEM_INTEGRATION.md` | Webhook/SIEM export — complementary to SSF |
| `../../../backend/src/modules/risk-scoring/docs/ARCHITECTURE.md` | Inbound signals feed into risk score recalculation |
| `../security/PLATFORM_AUTH_ARCHITECTURE.md` | JWT/OIDC infrastructure reused for SET signing |
| `../../../backend/src/modules/reconciliation/docs/ORPHAN_DETECTION.md` | Session-revoked signals may trigger orphan detection |
