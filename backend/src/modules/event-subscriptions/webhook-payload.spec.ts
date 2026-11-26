/**
 * The body of a webhook delivery carries ids only (2.0dl). Before: buildPayload copied
 * aggregateId and identityId as they came, and an emitter that falls back to the email for an id
 * (PolicyEngineService.evaluate for a profile without _id, as the mover evaluates it) put the
 * address into the body sent to the receiver.
 */
import type { DomainEvent } from '@infrastructure/events/domain-event.interface';
import { buildWebhookBody } from './webhook-payload';

const event = (aggregateId: string, payload: Record<string, unknown>): DomainEvent =>
  ({
    eventId: 'evt-1',
    type: 'policy.evaluated',
    aggregateId,
    timestamp: '2026-11-23T10:00:00.000Z',
    payload,
    metadata: { correlationId: 'c-1', depth: 0, emittedBy: 'test', actor: 'system', tenantId: 't' },
  }) as DomainEvent;

describe('buildWebhookBody', () => {
  it('keeps the event ids and nothing else of the payload', () => {
    expect(
      buildWebhookBody(
        event('64b7f0c2a1b2c3d4e5f60801', {
          identityId: '64b7f0c2a1b2c3d4e5f60801',
          policyId: 'pol-1',
          email: 'matti@corp.example',
          displayName: 'Matti Meikäläinen',
          matchedPolicies: ['pol-1'],
        }),
      ),
    ).toEqual({
      eventId: 'evt-1',
      eventType: 'policy.evaluated',
      timestamp: '2026-11-23T10:00:00.000Z',
      aggregateId: '64b7f0c2a1b2c3d4e5f60801',
      payload: { identityId: '64b7f0c2a1b2c3d4e5f60801', policyId: 'pol-1' },
    });
  });

  it('leaves out an id whose value is an email address', () => {
    const body = buildWebhookBody(
      event('Matti.Meikalainen@corp.example', {
        identityId: 'Matti.Meikalainen@corp.example',
        policyId: 'pol-1',
      }),
    );

    expect(body).not.toHaveProperty('aggregateId');
    expect(body.payload).toEqual({ policyId: 'pol-1' });
    expect(JSON.stringify(body)).not.toMatch(/@|Meikalainen/);
  });

  it('leaves out every id field that holds an address, not only identityId', () => {
    const body = buildWebhookBody(
      event('agg-1', {
        policyId: 'owner@corp.example',
        campaignId: 'c-1',
        driftId: 'drift for x@corp.example',
        anomalyId: 'a-1',
      }),
    );

    expect(body.payload).toEqual({ campaignId: 'c-1', anomalyId: 'a-1' });
  });
});
