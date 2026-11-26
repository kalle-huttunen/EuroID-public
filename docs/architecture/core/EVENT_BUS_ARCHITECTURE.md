---
Last updated: 2026-11-24
---

# Event Bus Architecture - The 2026 Standard

## The Core Problem

**"Services that call each other directly are married. Services that share events are neighbors."**

* **Today:** When `EntraService.provision()` completes, the onboarding workflow explicitly calls `auditService.log()`, then `userEventService.recordEvent()`, then (eventually) a notification service. Each new consumer means changing the provisioning code.
* **The Explosion:** Adding analytics, webhooks, or Slack notifications means modifying 15 different service files. Testing Entra requires mocking the audit service, the event service, and anything else it calls directly.
* **The Fix:** **Domain Events.** Services emit events. Consumers subscribe independently. The provisioning code never changes when you add a new consumer.

---

## Event Bus Landmines (Critical Safety Protocol)

### Landmine 1: The "Fire and Forget" Data Loss

* **The Trap:** You emit an event. The handler throws an error. The event is gone — no retry, no record.
* **The Explosion:** The audit trail has gaps. Compliance auditors find missing records. You cannot reconstruct what happened.
* **The 2026 Fix: At-Least-Once Delivery.**
  * `emit()` hands the event to the in-process handlers at once and stores nothing first. Only `emitWithTransaction()` persists it before any handler runs: it writes the event to `event_outbox` in the caller's MongoDB transaction, and the outbox poller publishes it after the commit (`backend/src/infrastructure/events/event-emitter.service.ts`, `outbox-poller.service.ts`).
  * A handler that fails is captured as a dead-letter entry with the event and the handler (`HandlerFailureCaptureService`, `handler-failure-capture.service.ts`).
  * The entry is retried automatically with exponential backoff, the first time after a minute, at most `DLQ_MAX_RETRIES` times (default 3), then it is `failed_permanently` (`backend/src/modules/dead-letter/dead-letter.service.ts`).

### Landmine 2: The "Event Storm" Cascade

* **The Trap:** Event A triggers Handler X, which emits Event B, which triggers Handler Y, which emits Event A again.
* **The Explosion:** Infinite loop. CPU 100%. MongoDB hammered. The system locks up.
* **The 2026 Fix: Causation Chain + Depth Limit.**
  * Every event carries `causedBy` (parent event ID) and `depth` (how many events deep in the chain).
  * If `depth > 20` (`MAX_EVENT_DEPTH`, `event-emitter.service.ts`), the event is dropped, logged as a potential loop and captured to the dead-letter queue (`event_chain_depth_exceeded`).
  * Events never trigger synchronous re-emission of the same event type.

### Landmine 3: The "Ordering" Assumption

* **The Trap:** You assume `IDENTITY_CREATED` always arrives before `POLICY_EVALUATED` for the same identity.
* **The Explosion:** A race condition causes the policy handler to run before the identity exists. It fails or creates inconsistent state.
* **The 2026 Fix: Handlers Must Be Idempotent and Order-Independent.**
  * If a handler needs an identity that doesn't exist yet, it retries (not fails permanently).
  * Events carry enough context in their payload to be self-sufficient (don't require the handler to look up prerequisite state that might not exist yet).

---

## Architecture Decision: NestJS EventEmitter2 (Phase 1)

The system is a modular monolith running in a single process (API server) plus a separate worker process. For this topology:

* **Phase 1:** `@nestjs/event-emitter` (wraps `eventemitter2`). In-process, typed, zero infrastructure. Good enough for single-process deployments.
* **Phase 2 (When Needed):** BullMQ + Redis for durable, cross-process events. Required when the API server and workers need to share events, or when you need guaranteed delivery across restarts.

**Why not BullMQ from day one?** It adds Redis as a hard dependency. The current deployment is a single API process + a Temporal worker. Temporal already handles cross-process orchestration for workflows. The event bus handles in-process decoupling — notifications, audit, analytics — which all run inside the API process.

---

## Architecture Overview

```
    ┌─────────────── Producers (Emit Events) ─────────────────────────┐
    │                                                                  │
    │  IdentityService ──▶ IDENTITY_CREATED, IDENTITY_UPDATED         │
    │  OnboardingService ──▶ PROVISIONING_COMPLETED                   │
    │  PolicyEngineService ──▶ POLICY_EVALUATED                       │
    │  ReconciliationService ──▶ DRIFT_DETECTED, DRIFT_RESOLVED       │
    │  ConnectorServices ──▶ CONNECTOR_HEALTH_CHANGED                 │
    │  PolicyService ──▶ POLICY_CREATED, _UPDATED, _DELETED           │
    │  SimulationService ──▶ SIMULATION_COMPLETED                     │
    │                                                                  │
    └──────────────────────────┬───────────────────────────────────────┘
                               │ EventEmitter2
                               ▼
    ┌─────────────── Event Bus (In-Process) ──────────────────────────┐
    │                                                                  │
    │  EventEmitter2 (NestJS @nestjs/event-emitter)                    │
    │  - Typed events via DomainEvent<T>                               │
    │  - Async handlers (non-blocking)                                 │
    │  - Error isolation (one handler failure doesn't block others)    │
    │                                                                  │
    └──────────────────────────┬───────────────────────────────────────┘
                               │
    ┌─────────────── Consumers (Handle Events) ───────────────────────┐
    │                                                                  │
    │  AuditEventHandler ──▶ Writes to audit_events collection        │
    │  UserTimelineHandler ──▶ Writes to user_events collection       │
    │  MetricsHandler ──▶ Increments Prometheus counters               │
    │  EmailNotificationHandler ──▶ Email over SMTP                   │
    │  EventDeliveryService ──▶ Outbound webhook delivery             │
    │  AnalyticsEventHandler ──▶ Marks offboarding previews stale     │
    │  AnalyticsIndexerService ──▶ Audit events to Elasticsearch      │
    │                                                                  │
    └─────────────────────────────────────────────────────────────────┘
```

---

## Domain Event Schema

All events share a common envelope. The `payload` is typed per event.

```typescript
// backend/src/infrastructure/events/domain-event.interface.ts

export interface DomainEvent<T = Record<string, unknown>> {
  /** Unique event ID (UUID) */
  eventId: string;

  /** Event type — used for routing to handlers */
  type: DomainEventType;

  /** The primary aggregate this event relates to (e.g., identityId, policyId) */
  aggregateId: string;

  /** ISO 8601 timestamp */
  timestamp: string;

  /** Event-specific data */
  payload: T;

  /** Metadata for tracing and safety */
  metadata: {
    /** Correlation ID from the originating request */
    correlationId: string;
    /** Event ID that caused this event (for chain tracking) */
    causedBy?: string;
    /** Depth in the event chain (loop prevention) */
    depth: number;
    /** Service that emitted this event */
    emittedBy: string;
    /** Actor (user or system) that triggered the action */
    actor: string;
    /** Tenant the event belongs to */
    tenantId: string;
  };
}
```

### Event Type Registry

```typescript
// backend/src/infrastructure/events/event-types.ts

export enum DomainEventType {
  // ── Identity Lifecycle ────────────────────────────
  IDENTITY_CREATED       = 'identity.created',
  IDENTITY_UPDATED       = 'identity.updated',
  IDENTITY_DELETED       = 'identity.deleted',
  IDENTITY_STATUS_CHANGED = 'identity.status_changed',
  IDENTITY_OFFBOARD_REQUESTED = 'identity.offboard_requested', // emitAndWait: returns the workflow id
  LEAVER_DETECTED        = 'identity.leaver_detected',
  LEAVER_OFFBOARDING_STARTED = 'identity.leaver_offboarding_started',

  // ── HR Leavers (modules/leavers/docs/ARCHITECTURE.md) ──
  HR_SYNC_COMPLETED      = 'connector.hr_sync_completed', // emitAndWait: returns LeaverSyncSummary
  LEAVER_BATCH_PAUSED    = 'leaver.batch_paused',
  LEAVER_BATCH_APPROVED  = 'leaver.batch_approved',
  LEAVER_BATCH_REJECTED  = 'leaver.batch_rejected',
  LEAVER_POLICY_UPDATED  = 'leaver.policy_updated',

  // ── HR Movers (modules/mover/docs/ARCHITECTURE.md) ──
  // Emitted by HR ingestion after HR_SYNC_COMPLETED answered, so this run's leavers are known.
  HR_SYNC_MOVERS_REQUESTED = 'connector.hr_sync_movers_requested', // emitAndWait: returns MoverSyncSummary
  MOVER_BATCH_PAUSED     = 'mover.batch_paused',
  MOVER_BATCH_APPROVED   = 'mover.batch_approved',
  MOVER_BATCH_REJECTED   = 'mover.batch_rejected',
  MOVER_POLICY_UPDATED   = 'mover.policy_updated',

  // ── HR Joiners (modules/joiners/docs/ARCHITECTURE.md) ──
  // Emitted by HR ingestion after mover detection, once HR_SYNC_COMPLETED answered.
  HR_SYNC_JOINERS_REQUESTED = 'connector.hr_sync_joiners_requested', // emitAndWait: returns JoinerSyncSummary
  JOINER_ONBOARDING_STARTED = 'identity.joiner_onboarding_started',
  JOINER_ONBOARDING_WAITING = 'identity.joiner_onboarding_waiting', // once: start date unreadable
  JOINER_BATCH_PAUSED    = 'joiner.batch_paused',
  JOINER_BATCH_APPROVED  = 'joiner.batch_approved',
  JOINER_BATCH_REJECTED  = 'joiner.batch_rejected',
  JOINER_POLICY_UPDATED  = 'joiner.policy_updated',

  // ── Provisioning ─────────────────────────────────
  PROVISIONING_STARTED   = 'provisioning.started',
  PROVISIONING_COMPLETED = 'provisioning.completed',
  PROVISIONING_FAILED    = 'provisioning.failed',
  PROVISIONING_DEPROVISIONED = 'provisioning.deprovisioned', // audit log only, no timeline entry

  // ── Policy ────────────────────────────────────────
  POLICY_CREATED         = 'policy.created',
  POLICY_UPDATED         = 'policy.updated',
  POLICY_DELETED         = 'policy.deleted',
  POLICY_EVALUATED       = 'policy.evaluated',

  // ── Reconciliation & Drift ────────────────────────
  DRIFT_DETECTED         = 'drift.detected',
  DRIFT_RESOLVED         = 'drift.resolved',
  CIRCUIT_BREAKER_TRIPPED = 'drift.circuit_breaker_tripped',
  RECONCILIATION_DRIFT_THRESHOLD_EXCEEDED = 'reconciliation.drift_threshold_exceeded', // counts and run ids only

  // ── Simulation ────────────────────────────────────
  SIMULATION_COMPLETED   = 'simulation.completed',

  // ── Connector ─────────────────────────────────────
  CONNECTOR_HEALTH_CHANGED = 'connector.health_changed',
  DISCOVERY_COMPLETED    = 'discovery.completed',

  // ── Access Review ─────────────────────────────────
  ACCESS_REVIEW_CAMPAIGN_CREATED = 'access_review.campaign_created',
  ACCESS_REVIEW_CAMPAIGN_ACTIVATED = 'access_review.campaign_activated',
  ACCESS_REVIEW_CAMPAIGN_COMPLETED = 'access_review.campaign_completed',
  ACCESS_REVIEW_CAMPAIGN_CANCELLED = 'access_review.campaign_cancelled',
  // also item_approved, item_revoked, item_expired, item_escalated and more: see event-types.ts
}
```

---

## Event Payloads (Per Type)

Each event type has a typed payload. These are the initial events — add more as features grow.

```typescript
// backend/src/infrastructure/events/event-payloads.ts

/** identity.created (POST /identity, or an HR sync that minted the identity) */
export interface IdentityCreatedPayload {
  identityId: string;
  sourceSystem: string;
  sourceUserId?: string;     // only the id a POST /identity caller gave; never the email
  status: string;
  triggerWorkflow?: boolean; // POST /identity?triggerWorkflow=true
}

/** identity.updated */
export interface IdentityUpdatedPayload {
  identityId: string;
  changedFields: string[];   // ['jobTitle', 'departmentName']: the fields the update wrote
  source: string;            // Which system triggered the update
  syncToEntra?: boolean;     // PATCH ?syncToEntra=true: the PATCH starts the run, no handler does
  // Before-values of the access attributes whose value changed (null when none), the mover's
  // "before" profile. No names, contact data or identifiers (changedAccessAttributes); an email
  // value (managerEmail) masked, which the mover reads from the access baseline instead.
  previousAttributes?: Record<string, unknown>;
  // A write-back (source 'writeback'): the connector whose new account was written back.
  // changedFields then names the attributes written to its source entry (objectId, mail, ...),
  // and the event has depth 1, so neither the mover nor the onboarding handler starts a run.
  targetSystem?: string;
}

/** identity.status_changed */
export interface IdentityStatusChangedPayload {
  identityId: string;
  previousStatus: string;
  newStatus: string;
  reason: string;            // 'offboarding' | 'manual_override' | 'hr_sync'
}

/**
 * provisioning.completed: aggregate and identityId are the identity's id. Onboarding, the mover,
 * PAM admin accounts and bulk operations (the id of the identity the Golden Record write saved)
 * pass it on the profile. A caller whose profile has no `_id` (a bulk run whose history saved
 * with saveToHub) gets the event under the connector name with no identityId; the timeline, the
 * access graph and anomaly analysis skip it.
 * Emitted by the provisioning activities of Entra ID, Okta, AD, SCIM, GitHub, ServiceNow and the
 * targets that keep no account (provisioning.failed too).
 */
export interface ProvisioningCompletedPayload {
  identityId?: string;
  connector: string;          // 'entra-id', 'okta', 'ad', 'scim', 'github', 'servicenow', 'file-outbound'
  targetUserId?: string;      // account id in the target; absent for a target that keeps no
                              // account, for AD (the DN holds the person's name) and for an id
                              // that is an email address (eventAccountId)
  operations: Array<{
    action: 'add' | 'remove';
    type: 'group' | 'license' | 'role';
    targetId: string;
    success: boolean;
  }>;
  detail?: string;            // what a target that keeps no account did
  durationMs: number;
}

/** provisioning.failed: identity as above; emails (and AD DN names) in `error` masked */
export interface ProvisioningFailedPayload {
  identityId?: string;
  connector: string;
  error: string;
  retryable: boolean;
  partialFailure?: boolean;   // Entra ID or AD: some of the intent's changes were not made
}

/**
 * provisioning.deprovisioned (deprovision-event-schemas.ts): a connector's deprovision activity
 * removed an account (Entra ID deleteUser; AD, Okta, SCIM, GitHub, ServiceNow deprovision).
 * Ids only. Under the identity's id when the caller names it (offboarding, entitlement expiry,
 * access review), else under the connector (orphan cleanup, bulk delete). An account already
 * gone emits nothing. The audit log records it; no timeline handler listens, since offboarding,
 * expiry and access review write their own timeline entry for the removal.
 */
export interface ProvisioningDeprovisionedPayload {
  identityId?: string;
  connector: string;
  targetUserId?: string;      // as in provisioning.completed: never an AD DN or an email
  detail?: string;            // what the target did: 'deleted', 'disabled', 'deactivated', ...
}

/** policy.evaluated: under the identity's id, else 'policy-engine' with no identityId */
export interface PolicyEvaluatedPayload {
  identityId?: string;
  matchedPolicies: string[];  // sourcePolicy of the operations
  generatedOperations: number;
  durationMs: number;
  forProvisioning?: boolean;  // a workflow provisions from it: the identity timeline records it
}

/** drift.detected */
export interface DriftDetectedPayload {
  identityId: string;
  system: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  discrepancies: Array<{
    field: string;
    expected: string;
    actual: string;
    action: 'REVERT' | 'ABSORB' | 'IGNORE';
  }>;
}

/** simulation.completed */
export interface SimulationCompletedPayload {
  policyId: string;
  affectedUsers: number;
  additions: number;
  removals: number;
  highRiskChanges: number;
  durationMs: number;
}
```

No payload carries an email address, a phone number or a person's name: every event reaches the audit log and the tenant websocket, many the analytics index and webhooks (`webhook-payload.ts` copies ids only), and a failed handler stores the payload in the dead-letter store. An event names the identity by `identityId`; a handler that needs the address (onboarding's workflow input, the access graph, the mail module) reads it from the identity. Since plan 2.0dn `identity.updated` has no `email` and masks an email before-value, and `entitlement.expired`, `entitlement.expiring_soon` and `entitlement.expiring_tomorrow` have no `email` (and a schema each). Since plan 2.8a `identity.created` has no `email` (the onboarding handler and the access graph read it from the identity), and `provisioning.*` and `policy.evaluated` never use the email as the identity: an Entra ID deletion emits no provisioning event at all. Since the final sweep of the 2026-11-23 round `identity.provision_requested` (`{ syncToEntra?, reason? }`, the identity is the aggregate) and `identity.offboard_requested` (`{ userId, reason? }`) have no email: their handlers read the address from the identity by id and pass it to the workflow input. `invite.created`, `access_request.created`, `access_request.closed`, `admin_account.created` and `access_review.item_escalated` have a schema each and no address (`admin-user-event-schemas.ts`, `access-event-schemas.ts`); `access_request.created` carries `requesterId` only when it is an identity id, and the escalation mail reads the item's new reviewer by `itemId`. The `accountIdentifier` of `orphan.detected` is the account's opaque id (Entra ID object id, SCIM id), and for an AD account, whose id is its DN, the UPN masked (`orphan-event-identifier.ts`). `event-payload-schemas.spec.ts` fails on any schema key for an email, phone or name; it lists no open issue.

Each payload is parsed with its zod schema in `event-payload-schemas.ts` (`EVENT_SCHEMAS`; an event type without one passes as it is) before any handler sees it. Zod drops a key the schema does not declare, so a field added to a payload reaches no handler, audit entry or websocket until the schema declares it; a payload that fails the schema throws in the emitting code outside production and is dead-lettered (`event_validation_failure`) in production. `event-payload-emitters.spec.ts` reads every `emit` / `emitAndWait` / `emitWithTransaction` call in `backend/src` and fails on a key the event's schema does not declare or a required key the payload lacks; it checks keys only, not value types, and lists the calls it cannot read.

---

## Event Emitter Service

A thin wrapper around `EventEmitter2` that enforces the envelope, adds metadata, and guards against loops.

```typescript
// backend/src/infrastructure/events/event-emitter.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { DomainEvent, DomainEventType } from './domain-event.interface';
import { requestContext } from '../middleware/correlation.middleware';

const MAX_EVENT_DEPTH = 20;

@Injectable()
export class DomainEventEmitterService {
  private readonly logger = new Logger(DomainEventEmitterService.name);

  constructor(private readonly emitter: EventEmitter2) {}

  /**
   * Emit a domain event. Automatically wraps payload in the standard envelope.
   *
   * @param type       Event type from the registry
   * @param aggregateId  The primary entity ID (identityId, policyId, etc.)
   * @param payload    Event-specific data
   * @param options    Optional: causedBy (parent eventId), actor override
   */
  emit<T>(
    type: DomainEventType,
    aggregateId: string,
    payload: T,
    options?: { causedBy?: string; depth?: number; actor?: string },
  ): void {
    const depth = (options?.depth ?? 0);

    if (depth > MAX_EVENT_DEPTH) {
      this.logger.error(
        `Event chain depth exceeded (${depth}) for ${type}. Possible loop. Dropping event.`,
      );
      return;
    }

    const ctx = requestContext.getStore();
    const event: DomainEvent<T> = {
      eventId: randomUUID(),
      type,
      aggregateId,
      timestamp: new Date().toISOString(),
      payload,
      metadata: {
        correlationId: ctx?.correlationId ?? 'no-context',
        causedBy: options?.causedBy,
        depth,
        emittedBy: this.constructor.name,
        actor: options?.actor ?? 'system',
      },
    };

    this.logger.debug(`Emitting ${type} for ${aggregateId}`);

    // Async emit — handlers run in parallel, errors are isolated
    this.emitter.emitAsync(type, event).catch((err) => {
      this.logger.error(`Handler error for ${type}: ${err.message}`, err.stack);
    });
  }
}
```

---

## Handler Failures and the Dead-Letter Queue

What the code does today (`backend/src/infrastructure/events/`, `backend/src/modules/dead-letter/`):

| Step | Where | Behaviour |
|---|---|---|
| Capture | `handler-failure-capture.service.ts` | At startup every `@OnEvent` method is wrapped. A failure becomes a dead-letter entry (`event_handler_failure`, the event as `originalPayload`, `handler: Class.method`, the event's tenant), then is rethrown so Nest logs and suppresses it: the emitting request and the other handlers carry on. Nest's `suppressErrors` default (and `async: true`, which detaches a listener from the emit) is why `emit()`'s own catch rarely sees a failure. |
| Not captured | same | A `suppressErrors: false` listener: its error reaches the emitter (`emitAndWait`'s caller, or `emit()`'s catch, which captures it with the `handler` tagged by the wrapper). A handler without `async: true` on an event emitted with `emitAndWait`: it answers that caller, which gets `undefined` and reports the failure. |
| Re-run registry | `dead-letter-handler.registry.ts` | Every wrapped handler is registered by `Class.method`; a run calls the handler itself, without Nest's error suppression. |
| Retry / replay | `dead-letter-rerun.ts`, `dead-letter.service.ts` | An entry with `handler` runs only that handler with the stored event. An entry with an event but no handler (email and webhook retry events, entries from before 2.0cu, outbox failures) re-emits the event and collects the outcome of every wrapped handler that ran (`handler-dispatch.ts`), `async: true` ones included. The entry becomes `replayed` only when the re-run succeeded; an entry without an event is refused with 409. |
| Automatic retry | `DeadLetterService.processAutoRetries` | Every `DLQ_RETRY_POLL_INTERVAL_MS`, up to 50 due entries that this process can re-run, longest due first, each in its entry's tenant, with backoff (1, 5, 25 minutes) until `DLQ_MAX_RETRIES`. Every API replica and every worker runs it (the worker boots the whole `AppModule`). |
| Claim | `dead-letter-claim.ts` | Every re-run (automatic retry, admin retry, replay, batch retry) starts with one conditional update on the state the entry was read in (`status`, `retryCount`, and for the automatic retry a due `nextRetryAt`): of the processes that read the same state, one gets it; an admin who loses gets 409. While it runs the entry is `retrying` and `nextRetryAt` is the end of the lease (`DLQ_RETRY_LEASE_MS`, default 5 minutes). The outcome is written only while the claim holds, so an entry dismissed meanwhile stays dismissed. A re-run that has not finished when the lease runs out (the process stopped) is taken again by the automatic retry and counts as a failed retry. |
| Capture without a context | `dead-letter.schema.ts` | The entry's `error` sub-schema is exempt from the tenant plugin, so pollers without a request context (outbox, webhook retries) can capture; the entry is stored under the tenant it names. |

Retry events: a failure whose re-run is not the original handler is captured with its own event type, never emitted by a service, and a dedicated handler: `notification.email_retry` (`EmailNotificationHandler.handleRetry`) and `webhook.delivery_retry` (`EventDeliveryService.handleDeliveryRetry`, re-posts the stored webhook body).

Webhook deliveries retry on their own before they reach the dead-letter queue (`EventDeliveryService`, user view in `docs/USER_FLOWS.md` Flow 16). The retry poller also runs in every API replica and worker: every 30 seconds, per tenant with an active subscription and in that tenant's context, it claims the due deliveries of the tenant's ACTIVE subscriptions whose filters still name the event, oldest due first, each with one conditional update (`findOneAndUpdate` from FAILED with a due retry, or PENDING with its lease run out, to PENDING with a new lease, `WEBHOOK_DELIVERY_LEASE_MS`, default 1 minute). A delivery is sent only by the process holding it, which records the outcome only while it still does. Deliveries of paused or deleted subscriptions are not read and wait unchanged. A send that never finished counts as an attempt.

Outbox events (`emitWithTransaction`: today `identity.created` from `IdentityMutationService.create` on a replica set) are published by `OutboxPollerService` (`outbox-poller.service.ts`), which runs in every API replica and worker. It claims one event at a time, oldest first, with one conditional update to `processing` and `claimedAt`: a `pending` event, or a `processing` one whose claim is older than `OUTBOX_CLAIM_TIMEOUT_MS` (default 5 minutes), because the process holding it stopped before it published. A claim from before `claimedAt` was stored (the schema did not declare it, so Mongoose dropped it) counts from its `updatedAt`. While its handlers run, the claiming process renews `claimedAt` every third of the timeout and stores a `claimToken` with the claim; it writes the outcome only while the stored token is still its own. So a handler slower than the timeout no longer lets another process take the event and publish it a second time, and a process whose claim was taken over changes nothing. A failed publish goes back to `pending` with `nextAttemptAt`, after `OUTBOX_RETRY_BASE_MS` (default 5 seconds) doubled per failure (5, 10, 20, 40 seconds), and is not claimed before then; the fifth failed attempt makes it `failed` and dead-letters it. On a replica set the change stream starts a pass on each change, and a sweep every `OUTBOX_SWEEP_INTERVAL_MS` (default 15 seconds) takes what no change announces: a stale claim, a retry that fell due. On a standalone MongoDB the poller polls every `OUTBOX_POLL_INTERVAL_MS` (default 2 seconds). A reclaimed event reaches every handler again, as a dead-letter replay of an event does. Handlers that store it keep one record per event id: the audit log (`AuditEventHandler` passes `eventId`, unique per tenant among entries that have one), the identity timeline (`UserTimelineHandler`, unique per tenant, event id and entry type) and webhook deliveries (`deliverWebhook` inserts the attempt as its claim on a unique `{ subscriptionId, eventId }` index and sends nothing when the insert finds the subscription's delivery of that `eventId`, so two processes handling the event at once send it once). `GraphSyncService` (MERGE) and the Elasticsearch indexer (document id) write the same result again; the onboarding start finds its run by workflow id while that run is open; the metrics and the websocket count it twice.

---

## Event Handlers (Consumers)

Handlers are NestJS services decorated with `@OnEvent`. Each handler is independent — one handler's failure does not affect others.

**Critical pattern: Event handlers are notification/audit only. Provisioning logic lives in Temporal workflows.** Handlers should not perform policy evaluation, delta computation, or other business logic that could trigger further events. They should only: (1) read minimal data needed to enqueue a workflow, (2) start the workflow, (3) return. This prevents event bus circularity and keeps the depth guard effective.

### Example: Audit Event Handler

```typescript
// backend/src/infrastructure/events/handlers/audit-event.handler.ts

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent, DomainEventType } from '../domain-event.interface';
import { AuditService } from '../../../modules/audit/audit.service';

@Injectable()
export class AuditEventHandler {
  private readonly logger = new Logger(AuditEventHandler.name);

  constructor(private readonly auditService: AuditService) {}

  /**
   * Catch-all: every domain event becomes an audit log entry.
   * Uses wildcard listener so new event types are automatically audited.
   */
  @OnEvent('**', { async: true })
  async handleAll(event: DomainEvent): Promise<void> {
    try {
      await this.auditService.log({
        action: event.type,
        targetId: event.aggregateId,
        actor: event.metadata.actor,
        details: event.payload,
        correlationId: event.metadata.correlationId,
        timestamp: new Date(event.timestamp),
      });
    } catch (error) {
      this.logger.error(`Failed to audit ${event.type}: ${error.message}`);
      // Audit failures should NOT crash the system — log and continue
    }
  }
}
```

### Example: Metrics Event Handler

```typescript
// backend/src/infrastructure/events/handlers/metrics-event.handler.ts

import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent, DomainEventType } from '../domain-event.interface';
import { MetricsService } from '../../metrics/metrics.service';
import { ProvisioningCompletedPayload, DriftDetectedPayload } from '../event-payloads';

@Injectable()
export class MetricsEventHandler {
  constructor(private readonly metrics: MetricsService) {}

  @OnEvent(DomainEventType.PROVISIONING_COMPLETED, { async: true })
  handleProvisioningCompleted(event: DomainEvent<ProvisioningCompletedPayload>) {
    const { connector, durationMs, operations } = event.payload;
    const allSuccess = operations.every((op) => op.success);

    this.metrics.provisioningTotal.inc({
      connector,
      status: allSuccess ? 'success' : 'partial_failure',
    });
    this.metrics.provisioningDuration.observe({ connector }, durationMs);
  }

  @OnEvent(DomainEventType.DRIFT_DETECTED, { async: true })
  handleDriftDetected(event: DomainEvent<DriftDetectedPayload>) {
    this.metrics.driftDetected.inc({
      system: event.payload.system,
      severity: event.payload.severity,
    });
  }
}
```

### Example: User Timeline Handler

This replaces the direct `userEventService.recordEvent()` calls scattered across services.

```typescript
// backend/src/infrastructure/events/handlers/user-timeline.handler.ts

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent, DomainEventType } from '../domain-event.interface';
import { UserEventService } from '../../../modules/identity/user-event.service';
import { ProvisioningCompletedPayload, DriftDetectedPayload } from '../event-payloads';

@Injectable()
export class UserTimelineHandler {
  private readonly logger = new Logger(UserTimelineHandler.name);

  constructor(private readonly userEventService: UserEventService) {}

  @OnEvent(DomainEventType.PROVISIONING_COMPLETED, { async: true })
  async handleProvisioned(event: DomainEvent<ProvisioningCompletedPayload>) {
    await this.userEventService.recordEvent({
      userId: event.aggregateId,
      type: 'provisioning',
      title: `Provisioned to ${event.payload.connector}`,
      description: `${event.payload.operations.length} operations executed`,
      actor: event.metadata.actor,
      targetSystem: event.payload.connector,
      metadata: { operations: event.payload.operations },
    });
  }

  @OnEvent(DomainEventType.DRIFT_DETECTED, { async: true })
  async handleDrift(event: DomainEvent<DriftDetectedPayload>) {
    await this.userEventService.recordEvent({
      userId: event.aggregateId,
      type: 'drift',
      severity: event.payload.severity === 'CRITICAL' ? 'error' : 'warning',
      title: `Drift detected in ${event.payload.system}`,
      description: `${event.payload.discrepancies.length} discrepancies found`,
      actor: 'system',
      targetSystem: event.payload.system,
      metadata: { discrepancies: event.payload.discrepancies },
    });
  }
}
```

---

## Module Structure

```
backend/src/infrastructure/events/
├── domain-event.interface.ts    # DomainEvent<T> envelope type
├── event-types.ts               # DomainEventType enum
├── event-payloads.ts            # Typed payloads per event type
├── event-emitter.service.ts     # DomainEventEmitterService wrapper
├── event-payload-schemas.ts     # Zod schema per event type (EVENT_SCHEMAS)
├── handler-failure-capture.service.ts # Wraps @OnEvent handlers, dead-letters failures
├── outbox-poller.service.ts     # Publishes emitWithTransaction outbox events
├── events.module.ts             # NestJS module (global)
└── handlers/
    ├── audit-event.handler.ts   # Writes all events to audit_events
    ├── metrics-event.handler.ts # Increments Prometheus counters
    ├── user-timeline.handler.ts # Writes identity events to user timeline
    └── ...                      # onboarding, offboarding, mover, joiner, leaver,
                                 # access review and entitlement handlers
```

```typescript
// backend/src/infrastructure/events/events.module.ts

import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DomainEventEmitterService } from './event-emitter.service';
import { AuditEventHandler } from './handlers/audit-event.handler';
import { MetricsEventHandler } from './handlers/metrics-event.handler';
import { UserTimelineHandler } from './handlers/user-timeline.handler';

@Global()
@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: true,        // Enable '**' catch-all listeners
      delimiter: '.',        // Event names use dot notation
      maxListeners: 20,      // Safety: prevent unbounded listener registration
      ignoreErrors: false,   // We handle errors in the emitter service
    }),
  ],
  providers: [
    DomainEventEmitterService,
    AuditEventHandler,
    MetricsEventHandler,
    UserTimelineHandler,
  ],
  exports: [DomainEventEmitterService],
})
export class EventsModule {}
```

---

## Migration: From Direct Calls to Events

The transition is incremental. You don't need to rip out all direct calls at once.

### Before (Direct Coupling)

```typescript
// entra.service.ts (today)
async provision(user, intent) {
  const result = await this.client.post('/users', profile);

  // Direct calls to every consumer — tightly coupled
  await this.auditService.log({ action: 'PROVISION', ... });
  await this.userEventService.recordEvent({ ... });
  // If you want metrics, add another call here...
  // If you want Slack notification, add another call here...

  return result;
}
```

### After (Event-Driven)

```typescript
// entra.service.ts (after)
async provision(user, intent) {
  const result = await this.client.post('/users', profile);

  // One line — all consumers are decoupled
  this.events.emit(
    DomainEventType.PROVISIONING_COMPLETED,
    identityId,
    {
      connector: 'entra-id',
      targetUserId: result.id,
      operations: executedOps,
      generatedAttributes: result.generatedAttributes,
      durationMs: elapsed,
    },
  );

  return result;
}
```

### Migration Order

Migrate producers one at a time. Start with the highest-traffic paths:

| # | Producer | Events | Impact |
|---|----------|--------|--------|
| 1 | `IdentityService` | `IDENTITY_CREATED`, `IDENTITY_UPDATED` | Highest volume — every HR sync |
| 2 | Connector services (`entra`, `ad`, `jira`) | `PROVISIONING_COMPLETED`, `PROVISIONING_FAILED` | Replaces direct audit + timeline calls |
| 3 | `ReconciliationService` | `DRIFT_DETECTED`, `DRIFT_RESOLVED` | Feeds drift dashboard |
| 4 | `PolicyEngineService` | `POLICY_EVALUATED` | Feeds analytics |
| 5 | `PolicyService` | `POLICY_CREATED`, `POLICY_UPDATED`, `POLICY_DELETED` | Audit trail for policy changes |

---

## Phase 2: BullMQ (When Cross-Process Events Are Needed)

When the architecture grows beyond a single API process — for example, when you want the Temporal worker to also consume events, or when you need guaranteed delivery across process restarts:

1. Replace `EventEmitterModule` with a BullMQ-backed module.
2. Events are published to a Redis stream instead of in-process.
3. Handlers become BullMQ workers (can run in the API process or in separate workers).
4. The `DomainEventEmitterService` interface stays the same — producers don't change.

This is a straightforward swap because the event envelope and handler patterns are already decoupled from the transport.

---

## How Events Relate to Temporal

**Events and Temporal serve different purposes:**

| Concern | Temporal | Event Bus |
|---------|----------|-----------|
| **Orchestration** (multi-step, durable, with rollback) | Yes | No |
| **Notification** (fire-and-forget side effects) | Overkill | Yes |
| **Audit logging** | Not its job | Yes |
| **Metrics / Analytics** | Not its job | Yes |
| **Cross-service decoupling** | Workflow → Activity (1:1) | Event → N handlers (1:N) |

**Rule of thumb:** If the consumer is part of the critical path (provisioning must succeed), use Temporal activities. If the consumer is a side effect (audit, notification, metrics), use events.

---

## Implementation Plan

| # | Task | Effort | Dependencies |
|---|------|--------|-------------|
| 1 | Install `@nestjs/event-emitter` | 5 min | — |
| 2 | Create `infrastructure/events/` folder with types, enum, payloads | 1 hour | — |
| 3 | Create `DomainEventEmitterService` | 30 min | Correlation middleware (from Observability) |
| 4 | Create `EventsModule` (global) and register in `app.module.ts` | 15 min | Step 2, 3 |
| 5 | Create `AuditEventHandler` | 30 min | Existing `AuditService` |
| 6 | Create `UserTimelineHandler` | 30 min | Existing `UserEventService` |
| 7 | Create `MetricsEventHandler` | 30 min | MetricsService (from Observability) |
| 8 | Migrate `IdentityService` to emit events | 1 hour | Step 4 |
| 9 | Migrate connector services to emit events | 1–2 hours | Step 4 |
| 10 | Migrate `ReconciliationService` to emit events | 1 hour | Step 4 |
| 11 | Remove direct audit/timeline calls from migrated services | 30 min | Steps 8–10 verified |

**Total estimated effort:** 1–2 days

---

## Related Documents

| Doc | Relevance |
|-----|-----------|
| **[roadmap/ROADMAP.md](../roadmap/ROADMAP.md)** | Prioritized backlog — this doc is the full event bus spec |
| **infrastructure/OBSERVABILITY_ARCHITECTURE.md** | Correlation middleware is shared; metrics handler consumes events |
| **core/SYSTEM_ARCHITECTURE.md** | Landmine 3 (Distributed Monolith) — events are the fix |
| **[reconciliation/ARCHITECTURE.md](../../../backend/src/modules/reconciliation/docs/ARCHITECTURE.md)** | Drift events feed the drift dashboard |
| **[connectors/ARCHITECTURE.md](../../../backend/src/modules/connectors/docs/ARCHITECTURE.md)** | Connector services are the primary event producers |
