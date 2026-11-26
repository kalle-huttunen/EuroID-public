/**
 * The event types the webhook form offers (eventTypeOptions over WEBHOOK_EVENT_TYPES). The
 * reconciliation start body refuses notifySlack and points at a webhook subscribed to
 * reconciliation.drift_threshold_exceeded instead, so the form must offer that type.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { WEBHOOK_EVENT_TYPES, eventTypeOptions } from '../webhook-labels';

// The event types the backend delivers to webhooks (every DomainEventType but webhook.* and
// dlq.*), pinned by backend/src/modules/event-subscriptions/webhook-event-types-fixture.spec.ts.
// The frontend cannot import the backend enum; a type missing here cannot be subscribed to from
// the form although the API accepts and delivers it.
const BACKEND: { eventTypes: string[] } = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../../backend/test/fixtures/webhook-event-types.json'),
    'utf8',
  ),
);

describe('eventTypeOptions', () => {
  it('offers the reconciliation drift alert, alone and through reconciliation.*', () => {
    const group = eventTypeOptions().find((g) => g.label === 'reconciliation');

    expect(group?.options.map((o) => o.value)).toEqual([
      'reconciliation.*',
      'reconciliation.drift_threshold_exceeded',
    ]);
  });

  it('offers every event type the backend delivers to webhooks, and no other', () => {
    expect([...WEBHOOK_EVENT_TYPES].sort()).toEqual(BACKEND.eventTypes);
    expect(new Set(WEBHOOK_EVENT_TYPES).size).toBe(WEBHOOK_EVENT_TYPES.length);
  });

  it('groups the joiner events under joiner, each also through joiner.*', () => {
    const group = eventTypeOptions().find((g) => g.label === 'joiner');

    expect(group?.options.map((o) => o.value)).toEqual([
      'joiner.*',
      'joiner.batch_paused',
      'joiner.batch_approved',
      'joiner.batch_rejected',
      'joiner.policy_updated',
    ]);
  });
});
