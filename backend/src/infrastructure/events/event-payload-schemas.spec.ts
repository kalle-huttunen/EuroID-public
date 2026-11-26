/**
 * No event payload schema has a key for an email address, a phone number or a person's name
 * (plan 2.0dn). Every event reaches the audit log and the tenant websocket, many the analytics
 * index, and a failed handler stores the payload in the dead-letter store, where an address
 * cannot be masked afterwards. A handler that needs the address reads it from the identity by
 * the event's identityId.
 *
 * Together with event-payload-emitters.spec (an emit call passes only keys its schema knows, and
 * the emitter strips any other) this keeps such a value out of every event that has a schema.
 * Events without a schema are not covered, nor values under a key that says nothing (the masked
 * before-values of identity.updated are a record; identity-mutation.service.spec covers them).
 */
import { z } from 'zod';
import { EVENT_SCHEMAS } from './event-payload-schemas';
import { DomainEventType } from './event-types';

/**
 * "event type.key path": why the event still carries it. Each is an open issue, not a pattern.
 * Empty since the final sweep of the 2026-11-23 round: identity.provision_requested and
 * identity.offboard_requested name the identity only, and their handlers read the address by it.
 */
const KNOWN: Record<string, string> = {};

/** `managerEmail`, `E-mail`, `mobile_phone`, `First Name` -> compared lowercase, letters only. */
function isPersonalKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z]/g, '');
  return (
    k.includes('email') ||
    k.includes('phone') ||
    ['firstname', 'lastname', 'displayname', 'fullname'].includes(k)
  );
}

/** Key paths of a schema, through objects, optionals, arrays and unions. */
function keyPaths(schema: z.ZodTypeAny, prefix: string): string[] {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return keyPaths(schema.unwrap(), prefix);
  }
  if (schema instanceof z.ZodArray) return keyPaths(schema.element, prefix);
  if (schema instanceof z.ZodUnion) {
    return (schema.options as z.ZodTypeAny[]).flatMap((option) => keyPaths(option, prefix));
  }
  if (schema instanceof z.ZodEffects) return keyPaths(schema.innerType(), prefix);
  if (!(schema instanceof z.ZodObject)) return [];
  return Object.entries(schema.shape as Record<string, z.ZodTypeAny>).flatMap(([key, field]) => [
    `${prefix}.${key}`,
    ...keyPaths(field, `${prefix}.${key}`),
  ]);
}

const personalKeys = (): string[] =>
  Object.entries(EVENT_SCHEMAS).flatMap(([type, schema]) =>
    keyPaths(schema as z.ZodTypeAny, type).filter((path) =>
      isPersonalKey(path.slice(path.lastIndexOf('.') + 1)),
    ),
  );

describe('event payload schemas: no email, phone or name', () => {
  it('finds such a key at any depth', () => {
    const schema = z.object({
      identityId: z.string(),
      approver: z.object({ managerEmail: z.string() }).optional(),
      rows: z.array(z.object({ 'Mobile Phone': z.string(), status: z.string() })),
    });
    expect(keyPaths(schema, 'x').filter((p) => isPersonalKey(p.split('.').pop()!))).toEqual([
      'x.approver.managerEmail',
      'x.rows.Mobile Phone',
    ]);
  });

  it('has none outside the known open issues', () => {
    expect(personalKeys().filter((path) => !(path in KNOWN))).toEqual([]);
  });

  it('lists no known issue that is gone', () => {
    const found = new Set(personalKeys());
    expect(Object.keys(KNOWN).filter((path) => !found.has(path))).toEqual([]);
  });

  // The emitter validates against these; a stored expiresAt is a Date until a dead-letter
  // retry sends it again as JSON.
  it.each([
    DomainEventType.ENTITLEMENT_EXPIRED,
    DomainEventType.ENTITLEMENT_EXPIRING_SOON,
    DomainEventType.ENTITLEMENT_EXPIRING_TOMORROW,
  ])('keeps a %s payload of the expiry run whole, with its Date or ISO expiresAt', (type) => {
    const schema = EVENT_SCHEMAS[type]!;
    for (const expiresAt of [new Date('2026-12-01T00:00:00Z'), '2026-12-01T00:00:00.000Z']) {
      const payload = { identityId: 'id-1', targetSystem: 'entra-id', expiresAt };
      expect(schema.parse(payload)).toEqual(payload);
    }
    expect(
      schema.parse({ identityId: 'id-1', targetSystem: 'scim', expiresAt: 'x', email: 'a@b.c' }),
    ).not.toHaveProperty('email');
  });

  // The nightly credential run's summary per tenant: counts, nothing about a person or account
  it('keeps the counts of credential.inventory_updated and drops any other key', () => {
    const schema = EVENT_SCHEMAS[DomainEventType.CREDENTIAL_INVENTORY_UPDATED]!;
    const counts = { refreshed: 4, changed: 2, unknown: 1, removed: 0 };

    expect(schema.parse({ ...counts, identityId: 'id-1', externalId: 'CN=Ada,OU=Staff' })).toEqual(
      counts,
    );
    expect(schema.safeParse({ ...counts, changed: -1 }).success).toBe(false);
    expect(schema.safeParse({ refreshed: 4 }).success).toBe(false);
  });

  // HX-E4: the emitter keeps only the keys a schema names, so the access request id of a refused
  // fulfilment or removal must be one of them to reach the audit log and webhooks
  it('keeps the access request id of provisioning.failed', () => {
    const schema = EVENT_SCHEMAS[DomainEventType.PROVISIONING_FAILED]!;
    const payload = {
      identityId: 'id-1',
      accessRequestId: 'req-1',
      connector: 'entra-id',
      error: 'entra-id: refused',
      retryable: false,
    };

    expect(schema.parse(payload)).toEqual(payload);
  });
});
