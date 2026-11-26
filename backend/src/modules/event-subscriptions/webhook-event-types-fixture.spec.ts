/**
 * test/fixtures/webhook-event-types.json is the backend side of the webhook form's catalog test
 * (frontend/src/features/webhooks/__tests__/webhook-labels.test.ts): the event types
 * EventDeliveryService delivers, every DomainEventType but webhook.* and dlq.*. A new event type
 * fails this test until the fixture lists it, then the frontend test until the form offers it:
 * eleven had been left out of the form, so nobody could subscribe to them from the UI.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DomainEventType } from '@infrastructure/events/event-types';
import { WEBHOOK_EVENT_TYPES, isDeliveredToWebhooks } from './webhook-event-types';

const FIXTURE = resolve(__dirname, '../../../test/fixtures/webhook-event-types.json');

describe('webhook event types fixture', () => {
  it('lists every event type webhooks receive', () => {
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual({
      eventTypes: [...WEBHOOK_EVENT_TYPES].sort(),
    });
  });

  it('leaves out only the webhook and dead-letter events, which would loop', () => {
    const undelivered = Object.values(DomainEventType).filter((t) => !isDeliveredToWebhooks(t));

    expect(undelivered.length).toBeGreaterThan(0);
    for (const type of undelivered) expect(type).toMatch(/^(webhook|dlq)\./);
    expect(WEBHOOK_EVENT_TYPES).toContain(DomainEventType.ADMIN_USER_PASSWORD_RESET_ISSUED);
  });
});
