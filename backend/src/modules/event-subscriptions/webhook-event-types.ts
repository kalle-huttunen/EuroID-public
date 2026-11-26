/**
 * The event types a webhook subscription receives: every DomainEventType but webhook.* and
 * dlq.*, which EventDeliveryService never delivers (a delivery emits those, so delivering them
 * would loop). A delivery carries ids only (webhook-payload.ts), so no event type needs to be
 * kept from webhooks for what its payload holds: the password reset events carry the admin
 * user's id, never a token or link.
 *
 * test/fixtures/webhook-event-types.json pins this list for the webhook form
 * (frontend/src/features/webhooks/webhook-labels.ts), whose test compares the two.
 */
import { DomainEventType } from '@infrastructure/events/event-types';

/** Event type prefixes that are never delivered, to prevent infinite delivery loops. */
const UNDELIVERED_PREFIXES = ['webhook.', 'dlq.'];

export function isDeliveredToWebhooks(eventType: string): boolean {
  return !UNDELIVERED_PREFIXES.some((prefix) => eventType.startsWith(prefix));
}

export const WEBHOOK_EVENT_TYPES: readonly string[] =
  Object.values(DomainEventType).filter(isDeliveredToWebhooks);
