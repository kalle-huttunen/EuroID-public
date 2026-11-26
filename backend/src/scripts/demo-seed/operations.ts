/**
 * Operations data: two webhook subscriptions with their delivery history, and dead-letter
 * entries in each state. Ids only in payloads and errors, as the app stores them.
 */
import { DomainEventType } from '@infrastructure/events/event-types';
import type { DomainEvent } from '@infrastructure/events/domain-event.interface';
import { buildWebhookBody } from '@modules/event-subscriptions/webhook-payload';
import { daysFrom, seededObjectId, seededUuid } from './random';
import {
  DEMO_SEED_MARKER,
  personId,
  sectionRandom,
  workingPeople,
  type SeedContext,
} from './context';

/**
 * Neither subscription is ACTIVE: the seed cannot encrypt a signing secret with the app's key,
 * so an active one would fail every delivery. An admin who resumes one sets a new secret first.
 */
const SUBSCRIPTIONS = [
  {
    name: 'Security SIEM (Splunk HEC)',
    status: 'PAUSED',
    eventTypes: ['identity.*', 'provisioning.failed', 'anomaly.*'],
    url: 'https://siem.example.com/services/collector/euroid',
    types: [
      DomainEventType.IDENTITY_CREATED,
      DomainEventType.PROVISIONING_FAILED,
      DomainEventType.IDENTITY_UPDATED,
    ],
    failure: { httpStatus: 503, lastError: 'HTTP 503 Service Unavailable from the collector' },
  },
  {
    name: 'IT service desk bridge',
    status: 'DISABLED',
    eventTypes: ['provisioning.*', 'drift.detected'],
    url: 'https://servicedesk.example.com/api/euroid/events',
    types: [DomainEventType.PROVISIONING_COMPLETED, DomainEventType.DRIFT_DETECTED],
    failure: { httpStatus: undefined, lastError: 'getaddrinfo ENOTFOUND servicedesk.example.com' },
  },
];

export function subscriptionId(ctx: SeedContext, index: number): string {
  return String(seededObjectId(ctx.tenantId, 'event-subscription', index));
}

export function buildSubscriptions(ctx: SeedContext): Record<string, unknown>[] {
  return SUBSCRIPTIONS.map((sub, i) => ({
    _id: subscriptionId(ctx, i),
    tenantId: ctx.tenantId,
    name: sub.name,
    type: 'WEBHOOK',
    status: sub.status,
    filters: { eventTypes: sub.eventTypes },
    webhook: { url: sub.url, headers: {}, signingSecret: `${DEMO_SEED_MARKER}:not-a-secret` },
    createdBy: DEMO_SEED_MARKER,
    createdAt: daysFrom(ctx.anchor, -60 + i * 10, 9),
  }));
}

/** Within the attempts' 30-day TTL; failed ones ran out of retries, so the poller leaves them. */
export function buildDeliveryAttempts(ctx: SeedContext): Record<string, unknown>[] {
  const rng = sectionRandom('webhooks');
  const people = rng.shuffle(workingPeople(ctx));
  const attempts: Record<string, unknown>[] = [];
  SUBSCRIPTIONS.forEach((sub, s) => {
    const total = s === 0 ? 9 : 5;
    for (let k = 0; k < total; k++) {
      const failed = k >= total - 2;
      const createdAt = daysFrom(ctx.anchor, -rng.int(1, 25), rng.int(0, 23));
      const event = {
        eventId: seededUuid(ctx.tenantId, `webhook-event|${s}|${k}`),
        type: sub.types[k % sub.types.length],
        aggregateId: personId(ctx, people[s * 10 + k]),
        timestamp: createdAt.toISOString(),
        payload: { identityId: personId(ctx, people[s * 10 + k]) },
      } as unknown as DomainEvent;
      attempts.push({
        _id: seededObjectId(ctx.tenantId, 'webhook-attempt', s * 100 + k),
        tenantId: ctx.tenantId,
        subscriptionId: subscriptionId(ctx, s),
        eventType: event.type,
        eventId: event.eventId,
        body: buildWebhookBody(event),
        status: failed ? 'FAILED' : 'DELIVERED',
        ...(failed
          ? {
              attempts: 5,
              ...(sub.failure.httpStatus ? { httpStatus: sub.failure.httpStatus } : {}),
              lastError: sub.failure.lastError,
            }
          : { attempts: 1, httpStatus: 200 }),
        createdAt,
      });
    }
  });
  return attempts;
}

/** Within the 90-day TTL. Pending entries carry no nextRetryAt, so no poller retries them. */
export function buildDeadLetters(ctx: SeedContext): Record<string, unknown>[] {
  const rng = sectionRandom('dead-letters');
  const people = rng.shuffle(workingPeople(ctx));
  const at = (days: number) => daysFrom(ctx.anchor, -days, rng.int(1, 22));
  const event = (type: DomainEventType, k: number, payload: Record<string, unknown>) => ({
    eventId: seededUuid(ctx.tenantId, `dead-letter-event|${k}`),
    type,
    aggregateId: personId(ctx, people[k]),
    timestamp: at(k + 2).toISOString(),
    payload: { identityId: personId(ctx, people[k]), ...payload },
    metadata: {
      correlationId: `${DEMO_SEED_MARKER}:${k}`,
      depth: 0,
      emittedBy: 'IdentityService',
      actor: 'system',
      tenantId: ctx.tenantId,
    },
  });
  const entries = [
    {
      type: 'event_handler_failure',
      source: 'event-bus',
      handler: 'UserTimelineHandler.handleIdentityUpdated',
      originalPayload: event(DomainEventType.IDENTITY_UPDATED, 0, {
        changedFields: ['jobTitle'],
        source: 'csv-hr',
      }),
      error: { message: 'MongoServerSelectionError: connection timed out', code: 'ETIMEDOUT' },
      status: 'pending',
      retryCount: 1,
    },
    {
      type: 'event_validation_failure',
      source: 'event-bus',
      originalPayload: event(DomainEventType.PROVISIONING_COMPLETED, 1, { connector: 'okta' }),
      error: { message: 'Invalid payload for provisioning.completed: operations is required' },
      status: 'pending',
      retryCount: 0,
    },
    {
      type: 'workflow_terminal',
      source: 'temporal:onboardingWorkflow',
      originalPayload: {
        workflowId: `onboarding-${personId(ctx, people[2])}`,
        identityId: personId(ctx, people[2]),
      },
      error: {
        message:
          'Activity provisionToTarget (okta) failed after 5 attempts: Okta API 429, rate limit exceeded',
      },
      status: 'failed_permanently',
      retryCount: 3,
    },
    {
      type: 'connector_non_retryable',
      source: 'connector:ad',
      originalPayload: { identityId: personId(ctx, people[3]), operation: 'disableAccount' },
      error: {
        message:
          'LDAP error 50 (insufficientAccessRights): the service account cannot modify this OU',
        code: '50',
      },
      status: 'dismissed',
      retryCount: 0,
      resolvedBy: 'admin',
      resolvedAt: at(1),
    },
    {
      type: 'event_handler_failure',
      source: 'event-bus',
      handler: 'UserTimelineHandler.handleProvisioningCompleted',
      originalPayload: event(DomainEventType.PROVISIONING_COMPLETED, 4, {
        connector: 'entra',
        operations: [],
      }),
      error: { message: 'WriteConflict: please retry your operation' },
      status: 'replayed',
      retryCount: 1,
      resolvedBy: 'admin',
      resolvedAt: at(2),
    },
  ];
  return entries.map((entry, k) => ({
    _id: seededObjectId(ctx.tenantId, 'dead-letter', k),
    tenantId: ctx.tenantId,
    ...entry,
    correlationId: `${DEMO_SEED_MARKER}:${k}`,
    maxRetries: 3,
    createdAt: at(k * 6 + 3),
  }));
}
