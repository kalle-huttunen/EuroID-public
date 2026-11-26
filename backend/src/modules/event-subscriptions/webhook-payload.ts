/**
 * The JSON body of a webhook delivery: ids only, never names or email addresses.
 *
 * Only the event's own fields and a fixed list of id fields of its payload are copied. An id field
 * whose value holds an email address (an emitter that fell back to the email for an identity
 * without an `_id`) is left out, so the body is safe whatever an emitter put there.
 */
import type { DomainEvent } from '@infrastructure/events/domain-event.interface';
import { maskEmails } from '../../activities/deprovision-failure';

/** The payload fields a delivery carries, when the event has them. */
const PAYLOAD_ID_FIELDS = ['identityId', 'policyId', 'campaignId', 'driftId', 'anomalyId'] as const;

/** A value that may go into the body as an id: anything but text holding an email address. */
const isSafeId = (value: unknown): boolean =>
  typeof value !== 'string' || maskEmails(value) === value;

export function buildWebhookBody(event: DomainEvent): Record<string, unknown> {
  const raw = event.payload as Record<string, unknown> | undefined;
  const payload: Record<string, unknown> = {};
  for (const field of PAYLOAD_ID_FIELDS) {
    const value = raw?.[field];
    if (value && isSafeId(value)) payload[field] = value;
  }

  return {
    eventId: event.eventId,
    eventType: event.type,
    timestamp: event.timestamp,
    ...(isSafeId(event.aggregateId) ? { aggregateId: event.aggregateId } : {}),
    payload,
  };
}

/**
 * Body of an attempt recorded before attempts kept theirs: what the retry poller always sent for
 * such an attempt (no aggregate, no ids).
 */
export function legacyWebhookBody(attempt: {
  eventId: string;
  eventType: string;
}): Record<string, unknown> {
  return {
    eventId: attempt.eventId,
    eventType: attempt.eventType,
    timestamp: new Date().toISOString(),
    aggregateId: '',
    payload: {},
  };
}
