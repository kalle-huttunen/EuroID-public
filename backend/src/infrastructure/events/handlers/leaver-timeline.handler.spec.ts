import { LeaverTimelineHandler } from './leaver-timeline.handler';
import { DomainEventType } from '../event-types';
import type { DomainEvent } from '../domain-event.interface';
import type { UserEventService } from '../../../modules/identity/user-event.service';
import { requestContext } from '../../middleware/correlation.middleware';

function event<T>(type: DomainEventType, payload: T, tenantId = 'tenant-a'): DomainEvent<T> {
  return {
    eventId: 'e1',
    type,
    aggregateId: 'id-1',
    timestamp: new Date().toISOString(),
    payload,
    metadata: {
      correlationId: 'c',
      depth: 0,
      emittedBy: 'test',
      actor: 'system:leaver-detection',
      tenantId,
    },
  };
}

describe('LeaverTimelineHandler', () => {
  const tenants: string[] = [];
  const recordEvent = jest.fn(async () => {
    tenants.push(requestContext.getStore()?.tenantId ?? '');
    return {};
  });
  const handler = new LeaverTimelineHandler({ recordEvent } as unknown as UserEventService);

  beforeEach(() => {
    recordEvent.mockClear();
    tenants.length = 0;
  });

  it('puts a detection on the identity timeline, saying when it waits for approval', async () => {
    await handler.handleLeaverDetected(
      event(DomainEventType.LEAVER_DETECTED, {
        identityId: 'id-1',
        leaverEventId: 'le-1',
        reason: 'missing-from-source' as const,
        sourceName: 'csv-hr',
        paused: true,
        batchId: 'b-1',
      }),
    );

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'id-1',
        type: 'LEAVER_DETECTED',
        severity: 'warning',
        title: 'Leaver detected: missing from the HR feed',
        description: expect.stringContaining('Waiting for approval'),
        metadata: expect.objectContaining({ reason: 'missing-from-source', batchId: 'b-1' }),
      }),
    );
    expect(tenants).toEqual(['tenant-a']);
  });

  it('records the offboarding workflow the leaver started', async () => {
    await handler.handleOffboardingStarted(
      event(
        DomainEventType.LEAVER_OFFBOARDING_STARTED,
        {
          identityId: 'id-1',
          leaverEventId: 'le-1',
          reason: 'terminated' as const,
          workflowId: 't-tenant-b-offboard-id-1',
        },
        'tenant-b',
      ),
    );

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'id-1',
        type: 'WORKFLOW_STARTED',
        title: 'Offboarding started',
        description: 'Leaver: terminated in HR',
        metadata: expect.objectContaining({ workflowId: 't-tenant-b-offboard-id-1' }),
      }),
    );
    expect(tenants).toEqual(['tenant-b']);
  });

  it('skips an event without a tenant', async () => {
    await handler.handleOffboardingStarted(
      event(
        DomainEventType.LEAVER_OFFBOARDING_STARTED,
        { identityId: 'id-1', leaverEventId: 'le-1', reason: 'end-date' as const, workflowId: 'w' },
        '',
      ),
    );
    expect(recordEvent).not.toHaveBeenCalled();
  });
});
