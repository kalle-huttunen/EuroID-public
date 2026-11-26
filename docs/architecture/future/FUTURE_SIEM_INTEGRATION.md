# FUTURE: SIEM Integration & Webhook Event Subscriptions

> **Status:** Partially implemented. Built: webhook subscriptions (F-21) in `backend/src/modules/event-subscriptions/`
> (HMAC-SHA256 signed deliveries, retry with backoff and the DLQ, SSRF check of the URL, a body of ids only).
> Not built: SIEM batch export, OCSF and the Splunk, Sentinel and S3 targets (F-04/F-05/F-06); `SubscriptionType` is `'WEBHOOK'` only.

## Overview

EuroID emits 34+ domain event types internally via `DomainEventEmitterService`, but has no mechanism for external systems to consume these events. A SIEM integration layer would enable real-time audit event streaming to security platforms (Splunk, Microsoft Sentinel, Elastic SIEM, Datadog) and a webhook subscription API would allow arbitrary external consumers to receive filtered event streams.

---

## Problem Statement

- Audit events are stored in MongoDB with immutable hash-chain — but are **pull-only** (query via API)
- No real-time push to external SIEM systems for security monitoring
- No webhook API for external integrations (ticketing, alerting, custom dashboards)
- Compliance frameworks (SOC 2, ISO 27001) expect centralized log aggregation in enterprise SIEM

---

## Proposed Architecture

### Component Overview

| Component | Path (Proposed) | Responsibility |
|-----------|-----------------|----------------|
| EventSubscriptionService | `modules/event-subscriptions/event-subscription.service.ts` | CRUD for webhook subscriptions, filter matching |
| EventSubscriptionController | `modules/event-subscriptions/event-subscription.controller.ts` | REST API for managing subscriptions |
| EventDeliveryService | `modules/event-subscriptions/event-delivery.service.ts` | Reliable delivery with retry, dead-letter |
| SiemExportService | `modules/event-subscriptions/siem-export.service.ts` | Format translation (OCSF, CEF) and batch export |
| EventSubscription schema | `modules/event-subscriptions/schemas/event-subscription.schema.ts` | Subscription config persistence |
| DeliveryAttempt schema | `modules/event-subscriptions/schemas/delivery-attempt.schema.ts` | Delivery tracking for retry/DLQ |

### Data Flow

```
DomainEventEmitterService
        │
        ▼
EventSubscriptionListener (consumes ALL domain events)
        │
        ├──▶ Filter: match event type against subscription filters
        │
        ├──▶ Webhook Delivery ──▶ External System (HTTP POST, HMAC-signed)
        │       │
        │       └── Retry (exponential backoff, max 5) ──▶ Dead Letter
        │
        └──▶ SIEM Batch Export ──▶ S3/Blob (OCSF format) ──▶ SIEM pulls from bucket
                                    or
                                  ──▶ Splunk HEC / Sentinel Data Connector (direct push)
```

---

## Subscription Schema

```typescript
// Collection: event_subscriptions
{
  tenantId: string,
  name: string,                          // Human-readable name
  type: 'WEBHOOK' | 'SIEM_SPLUNK' | 'SIEM_SENTINEL' | 'SIEM_S3',
  status: 'ACTIVE' | 'PAUSED' | 'DISABLED',

  // Filter: which events to deliver
  filters: {
    eventTypes: string[],                // e.g., ['identity.*', 'anomaly.detected']
    severityMin?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
  },

  // Webhook config
  webhook?: {
    url: string,                         // SSRF-validated
    headers: Record<string, string>,     // Custom headers
    signingSecret: string,               // HMAC-SHA256 signing key (encrypted at rest)
  },

  // SIEM config
  siem?: {
    provider: 'SPLUNK' | 'SENTINEL' | 'S3',
    endpoint: string,                    // HEC URL, Sentinel workspace, or S3 bucket
    credentials: string,                 // Encrypted reference
    format: 'OCSF' | 'CEF' | 'JSON',   // Output format
    batchSize: number,                   // Events per batch (default 100)
    flushIntervalSeconds: number,        // Max time between flushes (default 60)
  },

  createdAt: Date,
  updatedAt: Date,
}
```

---

## Event Format: OCSF (Open Cybersecurity Schema Framework)

OCSF v1.1 is the 2025-2026 standard replacing CEF for security event interchange. All events should be translatable to OCSF categories:

| EuroID Event | OCSF Category | OCSF Class |
|-------------|---------------|------------|
| `identity.created` | Identity & Access Management | Account Change (3001) |
| `identity.updated` | Identity & Access Management | Account Change (3001) |
| `identity.deleted` | Identity & Access Management | Account Change (3001) |
| `provisioning.*` | Identity & Access Management | Authorization (3003) |
| `anomaly.detected` | Findings | Security Finding (2001) |
| `access_review.*` | Identity & Access Management | Access Activity (3006) |
| `audit.*` | Application Activity | API Activity (6003) |
| `EMERGENCY_ACCESS_USED` | Authentication | Authentication (3002) |

---

## API Endpoints (Proposed)

| Method | Path | Role | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/event-subscriptions` | super-admin | Create subscription |
| `GET` | `/api/v1/event-subscriptions` | super-admin | List subscriptions |
| `GET` | `/api/v1/event-subscriptions/:id` | super-admin | Get subscription detail |
| `PATCH` | `/api/v1/event-subscriptions/:id` | super-admin | Update subscription |
| `DELETE` | `/api/v1/event-subscriptions/:id` | super-admin | Delete subscription |
| `POST` | `/api/v1/event-subscriptions/:id/test` | super-admin | Send test event |
| `GET` | `/api/v1/event-subscriptions/:id/deliveries` | super-admin | Recent delivery attempts |

---

## Security Considerations

- **SSRF:** All webhook URLs must pass `validateUrlForFetch()` — block private IPs, localhost, metadata endpoints
- **HMAC signing:** Every webhook delivery includes `X-EuroID-Signature` header (HMAC-SHA256 of payload using signing secret)
- **Credential storage:** SIEM credentials encrypted at rest via `EncryptionService`
- **Rate limiting:** Max 10 subscriptions per tenant; delivery rate capped at 1000 events/minute per subscription
- **PII:** Events must respect GDPR — no PII in SIEM exports unless subscription explicitly opts in; default: identityId only, no names/emails

---

## Dependencies

- Existing: `DomainEventEmitterService`, `EncryptionService`, `ssrf-guard.ts`
- New infra: None required (webhook is HTTP; SIEM batching uses existing MongoDB for buffering)
- Optional: S3/Blob for SIEM batch export

---

## Implementation Checklist

- [x] Create `event-subscriptions` module (schema, service, controller) — F-21
- [x] Implement webhook delivery with HMAC signing and retry/DLQ — F-21
- [ ] Implement SIEM batch export (OCSF format) for Splunk/Sentinel/S3 — F-04/F-05/F-06
- [x] Add SSRF validation for webhook URLs — F-21
- [x] Add subscription management API endpoints (CRUD + test delivery) — F-21
- [x] Encrypt signing secrets at rest (F-21); SIEM credentials do not exist
- [x] Enforce PII filtering (GDPR) in webhook bodies: ids only, no names or email addresses (`webhook-payload.ts`, F-21)
- [x] Add unit and integration tests (F-21)
- [x] Update API_CHANGELOG.md and DOCUMENTATION_STRATEGY.md — F-04/F-05/F-06

---

## Related Docs

| Doc | Relevance |
|-----|-----------|
| `../core/EVENT_BUS_ARCHITECTURE.md` | Internal event system this builds on |
| `../infrastructure/OBSERVABILITY_ARCHITECTURE.md` | Correlation IDs carried through to SIEM events |
| `../security/PLATFORM_AUTH_ARCHITECTURE.md` | Actor attribution in events |
| `FUTURE_SHARED_SIGNALS.md` | SSF/CAEP is the standards-based complement to this |
