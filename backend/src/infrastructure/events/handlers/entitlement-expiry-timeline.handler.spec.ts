import { EntitlementExpiryTimelineHandler } from './entitlement-expiry-timeline.handler';
import { DomainEventType } from '../event-types';
import type { DomainEvent } from '../domain-event.interface';
import type {
  EntitlementExpiryFailedPayload,
  EntitlementExpiryRemovedManuallyPayload,
  EntitlementExpiryRetryRequestedPayload,
} from '../event-payloads';
import type { UserEventService } from '../../../modules/identity/user-event.service';
import { requestContext } from '../../middleware/correlation.middleware';

function event<T>(
  type: DomainEventType,
  payload: T,
  tenantId = 'tenant-a',
  actor = 'system',
): DomainEvent<T> {
  return {
    eventId: 'e1',
    type,
    aggregateId: 'id-1',
    timestamp: new Date().toISOString(),
    payload,
    metadata: { correlationId: 'c', depth: 0, emittedBy: 'test', actor, tenantId },
  };
}

const failed = (over: Partial<EntitlementExpiryFailedPayload> = {}, tenantId = 'tenant-a') =>
  event<EntitlementExpiryFailedPayload>(
    DomainEventType.ENTITLEMENT_EXPIRY_FAILED,
    {
      identityId: 'id-1',
      targetSystem: 'okta',
      expiresAt: '2026-11-20T10:00:00.000Z',
      reason: 'okta: Request failed with status code 403 (HTTP 403)',
      retryable: false,
      attempts: 1,
      ...over,
    },
    tenantId,
  );

describe('EntitlementExpiryTimelineHandler', () => {
  const tenants: string[] = [];
  const recordEvent = jest.fn(async () => {
    tenants.push(requestContext.getStore()?.tenantId ?? '');
    return {};
  });
  const handler = new EntitlementExpiryTimelineHandler({
    recordEvent,
  } as unknown as UserEventService);
  const entries = () => recordEvent.mock.calls.map((c) => (c as unknown[])[0]);

  beforeEach(() => {
    recordEvent.mockClear();
    tenants.length = 0;
  });

  it('records expired access that was removed, in the event tenant', async () => {
    await handler.handleExpired(
      event(DomainEventType.ENTITLEMENT_EXPIRED, {
        identityId: 'id-1',
        targetSystem: 'scim',
        expiresAt: new Date('2026-11-22T09:00:00.000Z'),
        email: 'ada@acme.test',
      }),
    );
    expect(entries()).toEqual([
      {
        userId: 'id-1',
        actor: 'system',
        type: 'USER_DEPROVISIONED',
        severity: 'success',
        title: 'Access expired, removed: scim',
        description: 'Time-bound access ended 2026-11-22T09:00:00.000Z.',
        targetSystem: 'scim',
        metadata: { expiresAt: '2026-11-22T09:00:00.000Z' },
      },
    ]);
    expect(tenants).toEqual(['tenant-a']);
    expect(JSON.stringify(entries())).not.toContain('ada@acme.test');
  });

  it('records a failure that is not retried as an error, saying the access stays', async () => {
    await handler.handleExpiryFailed(failed());
    expect(entries()).toEqual([
      expect.objectContaining({
        userId: 'id-1',
        type: 'USER_DEPROVISIONED',
        severity: 'error',
        title: 'Expired access not removed: okta',
        description:
          'okta: Request failed with status code 403 (HTTP 403). Not retried: the access stays ' +
          'until it is removed in okta and marked removed manually, an admin ' +
          'retries it after fixing the cause, or the expiry date changes.',
        targetSystem: 'okta',
        metadata: expect.objectContaining({ retryable: false, attempts: 1 }),
      }),
    ]);
  });

  it('records a retryable failure as a warning with the next attempt', async () => {
    await handler.handleExpiryFailed(
      failed({
        targetSystem: 'scim',
        reason: 'scim: Request failed with status code 503',
        retryable: true,
        attempts: 2,
        nextAttemptAt: '2026-11-22T13:00:00.000Z',
      }),
    );
    expect(entries()).toEqual([
      expect.objectContaining({
        severity: 'warning',
        title: 'Expired access not removed: scim',
        description:
          'scim: Request failed with status code 503. Tried again from 2026-11-22T13:00:00.000Z.',
        metadata: expect.objectContaining({ retryable: true, attempts: 2 }),
      }),
    ]);
  });

  it('says when the account was already gone or the target keeps no account', async () => {
    const ended = (outcome: string, detail: string) =>
      event(DomainEventType.ENTITLEMENT_EXPIRED, {
        identityId: 'id-1',
        targetSystem: 'ad',
        expiresAt: '2026-11-22T09:00:00.000Z',
        outcome: outcome as 'already-gone',
        detail,
      });
    await handler.handleExpired(ended('already-gone', 'no such object'));
    await handler.handleExpired(ended('not-applicable', 'keeps no account'));
    expect(entries()).toEqual([
      expect.objectContaining({
        title: 'Access expired, no account left: ad',
        metadata: {
          expiresAt: '2026-11-22T09:00:00.000Z',
          outcome: 'already-gone',
          detail: 'no such object',
        },
      }),
      expect.objectContaining({ title: 'Access expired, the target keeps no account: ad' }),
    ]);
  });

  it('records an admin retry and a removal by hand with the admin as actor', async () => {
    const base = {
      identityId: 'id-1',
      targetSystem: 'okta',
      expiresAt: '2026-11-20T10:00:00.000Z',
      failureReason: 'okta: Request failed with status code 403 (HTTP 403)',
    };
    await handler.handleRetryRequested(
      event<EntitlementExpiryRetryRequestedPayload>(
        DomainEventType.ENTITLEMENT_EXPIRY_RETRY_REQUESTED,
        base,
        'tenant-a',
        'admin@a.example',
      ),
    );
    await handler.handleRemovedManually(
      event<EntitlementExpiryRemovedManuallyPayload>(
        DomainEventType.ENTITLEMENT_EXPIRY_REMOVED_MANUALLY,
        { ...base, reason: 'Deactivated in the Okta admin console' },
        'tenant-a',
        'admin@a.example',
      ),
    );
    expect(entries()).toEqual([
      {
        userId: 'id-1',
        actor: 'admin@a.example',
        type: 'USER_DEPROVISIONED',
        severity: 'info',
        title: 'Expired access removal retried: okta',
        description:
          'The failure was cleared (okta: Request failed with status code 403 (HTTP 403)). ' +
          'The next hourly expiry run tries to remove the access again.',
        targetSystem: 'okta',
        metadata: { expiresAt: '2026-11-20T10:00:00.000Z' },
      },
      {
        userId: 'id-1',
        actor: 'admin@a.example',
        type: 'USER_DEPROVISIONED',
        severity: 'success',
        title: 'Expired access removed manually: okta',
        description: 'Deactivated in the Okta admin console',
        targetSystem: 'okta',
        metadata: {
          expiresAt: '2026-11-20T10:00:00.000Z',
          outcome: 'removed-manually',
          failureReason: 'okta: Request failed with status code 403 (HTTP 403)',
        },
      },
    ]);
    expect(tenants).toEqual(['tenant-a', 'tenant-a']);
  });

  it('survives a failing write and skips an event without a tenant', async () => {
    recordEvent.mockRejectedValueOnce(new Error('db down'));
    await expect(handler.handleExpiryFailed(failed())).resolves.toBeUndefined();

    recordEvent.mockClear();
    await handler.handleExpiryFailed(failed({}, ''));
    expect(recordEvent).not.toHaveBeenCalled();
  });
});
