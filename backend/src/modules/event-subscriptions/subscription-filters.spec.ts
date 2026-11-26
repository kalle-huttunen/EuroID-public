/**
 * The two filters of a subscription outside the service (2.0dl): the event type patterns, also as
 * a MongoDB condition, which the webhook retry poller claims with, and filters.severityMin.
 */
import { DomainEventType } from '@infrastructure/events/event-types';
import { CreateEventSubscriptionSchema } from './dtos/create-event-subscription.dto';
import { UpdateEventSubscriptionSchema } from './dtos/update-event-subscription.dto';
import { eventTypeCondition, matchesEventType, meetsSeverityMin } from './subscription-filters';

describe('matchesEventType', () => {
  it.each([
    // exact event type
    ['identity.created', 'identity.created', true],
    // wildcard segment
    ['identity.*', 'identity.created', true],
    ['identity.*', 'identity.updated', true],
    // a wildcard is one segment: different depths do not match
    ['identity.*', 'identity.status.changed', false],
    // catch-all patterns
    ['*', 'identity', true],
    ['**', 'anything', true],
    // different types
    ['policy.*', 'identity.created', false],
  ])('pattern %p, event type %p: %p', (pattern, eventType, expected) => {
    expect(matchesEventType(pattern, eventType)).toBe(expected);
  });
});

describe('eventTypeCondition', () => {
  const TYPES = [
    'identity.created',
    'identity.updated',
    'identity.status.changed',
    'policy.evaluated',
    'drift.detected',
    'identity',
    'identityXcreated',
  ];
  /** Whether MongoDB would select an attempt of eventType with the condition. */
  const selects = (condition: Record<string, unknown>, eventType: string): boolean => {
    const rule = condition.eventType as { $regex?: string; $in?: string[] } | undefined;
    if (rule === undefined) return true;
    if (rule.$in) return rule.$in.includes(eventType);
    return new RegExp(rule.$regex as string).test(eventType);
  };

  it.each([
    [['identity.created']],
    [['identity.*']],
    [['identity.*', 'policy.evaluated']],
    [['*.detected']],
    [['*']],
    [['**']],
    [['identity.*', '*']],
  ])('selects exactly the types matchesEventType matches for %p', (patterns) => {
    for (const type of TYPES) {
      expect([type, selects(eventTypeCondition(patterns), type)]).toEqual([
        type,
        patterns.some((p) => matchesEventType(p, type)),
      ]);
    }
  });

  it('selects nothing for an empty pattern list', () => {
    expect(TYPES.some((t) => selects(eventTypeCondition([]), t))).toBe(false);
  });

  it('treats regex characters in a pattern literally', () => {
    expect(selects(eventTypeCondition(['identity.(created|x)']), 'identity.created')).toBe(false);
  });
});

describe('meetsSeverityMin', () => {
  it.each([
    [undefined, { severity: 'LOW' }, true],
    ['HIGH', { severity: 'MEDIUM' }, false],
    ['HIGH', { severity: 'HIGH' }, true],
    ['HIGH', { severity: 'CRITICAL' }, true],
    ['MEDIUM', { severity: 'low' }, false],
    ['MEDIUM', { severity: 'high' }, true],
    // No severity, or one outside LOW..CRITICAL: nothing to compare, so the event passes.
    ['CRITICAL', { identityId: 'id-1' }, true],
    ['CRITICAL', { severity: 'warning' }, true],
    ['CRITICAL', { severity: 3 }, true],
    ['CRITICAL', undefined, true],
  ])('severityMin %p, payload %p: %p', (minimum, payload, expected) => {
    expect(meetsSeverityMin(minimum, payload)).toBe(expected);
  });
});

/**
 * credential.rotated and credential.rotation_failed are withdrawn: nothing emitted them since the
 * nightly credential run stopped resetting passwords. A subscription naming them stays valid and
 * keeps its other event types; the names match no event type EuroID has, so they deliver nothing,
 * as before. credential.* still delivers the credential events that remain.
 */
describe('a subscription naming a withdrawn event type', () => {
  const WITHDRAWN = ['credential.rotated', 'credential.rotation_failed'];
  const EVENT_TYPES = Object.values(DomainEventType) as string[];

  it('is still accepted on create and edit, like any event type name', () => {
    const filters = { eventTypes: [...WITHDRAWN, 'credential.expiring_soon'] };
    expect(
      CreateEventSubscriptionSchema.safeParse({
        name: 'SIEM',
        filters,
        webhook: { url: 'https://siem.example.com/hooks/euroid', signingSecret: 'a'.repeat(32) },
      }).success,
    ).toBe(true);
    expect(UpdateEventSubscriptionSchema.safeParse({ filters }).success).toBe(true);
  });

  it('matches no event type EuroID has, so those names deliver nothing', () => {
    for (const pattern of WITHDRAWN) {
      expect([pattern, EVENT_TYPES.filter((type) => matchesEventType(pattern, type))]).toEqual([
        pattern,
        [],
      ]);
    }
  });

  it('leaves credential.* matching the credential events that remain', () => {
    expect(EVENT_TYPES.filter((type) => matchesEventType('credential.*', type)).sort()).toEqual([
      'credential.expiring_soon',
      'credential.inventory_updated',
    ]);
  });
});
