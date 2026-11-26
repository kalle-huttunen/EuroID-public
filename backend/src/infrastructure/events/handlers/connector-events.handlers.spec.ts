/**
 * Connector events through the real emitter and the real audit and timeline handlers (same
 * EventEmitter2 options as EventsModule):
 * - provisioning.completed / provisioning.failed of AD, SCIM, GitHub and ServiceNow reach the
 *   identity timeline, as Entra ID's and Okta's do;
 * - provisioning.deprovisioned reaches the audit log only. Offboarding, entitlement expiry and
 *   access review write the timeline entry for the same removal themselves.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { DomainEventEmitterService } from '../event-emitter.service';
import { DomainEventType } from '../event-types';
import { DeadLetterService } from '../../../modules/dead-letter/dead-letter.service';
import { AuditService } from '../../../modules/audit/audit.service';
import { UserEventService } from '../../../modules/identity/user-event.service';
import { withTenantContext } from '../../multi-tenancy/tenant-context.helper';
import { AuditEventHandler } from './audit-event.handler';
import { UserTimelineHandler } from './user-timeline.handler';
import { OffboardingTimelineHandler } from './offboarding-timeline.handler';
import { EntitlementExpiryTimelineHandler } from './entitlement-expiry-timeline.handler';
import { AccessReviewTimelineHandler } from './access-review-timeline.handler';
import { JoinerTimelineHandler } from './joiner-timeline.handler';
import { LeaverTimelineHandler } from './leaver-timeline.handler';
import { MoverTimelineHandler } from './mover-timeline.handler';

describe('connector events: identity timeline and audit log', () => {
  let moduleRef: TestingModule;
  let events: DomainEventEmitterService;
  const log = jest.fn(async () => ({}));
  const recordEvent = jest.fn(async () => ({}));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [
        AuditEventHandler,
        UserTimelineHandler,
        OffboardingTimelineHandler,
        EntitlementExpiryTimelineHandler,
        AccessReviewTimelineHandler,
        JoinerTimelineHandler,
        LeaverTimelineHandler,
        MoverTimelineHandler,
        { provide: AuditService, useValue: { log } },
        { provide: UserEventService, useValue: { recordEvent } },
      ],
    }).compile();
    await moduleRef.init();
    events = new DomainEventEmitterService(
      moduleRef.get(EventEmitter2),
      { capture: jest.fn() } as unknown as DeadLetterService,
      {} as never,
      { get: jest.fn().mockReturnValue('test') } as never,
    );
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    log.mockClear();
    recordEvent.mockClear();
  });

  const emit = (type: DomainEventType, aggregateId: string, payload: object) =>
    withTenantContext('tenant-a', () => events.emit(type, aggregateId, payload));
  /** The handlers run `async: true` (setImmediate after the emit): let them finish. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  it.each(['ad', 'scim', 'github', 'servicenow'])(
    'shows a %s provisioning and a failed one on the identity timeline',
    async (connector) => {
      await emit(DomainEventType.PROVISIONING_COMPLETED, 'id-1', {
        identityId: 'id-1',
        connector,
        operations: [],
        durationMs: 1,
      });
      await emit(DomainEventType.PROVISIONING_FAILED, 'id-1', {
        identityId: 'id-1',
        connector,
        error: `${connector}: refused`,
        retryable: false,
      });
      await settle();

      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'id-1',
          type: 'USER_PROVISIONED',
          title: `Provisioned to ${connector}`,
          targetSystem: connector,
        }),
      );
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'id-1',
          severity: 'error',
          title: `Provisioning failed to ${connector}`,
          description: `${connector}: refused`,
        }),
      );
      expect(log).toHaveBeenCalledTimes(2);
    },
  );

  it('records a deprovision in the audit log only, never as a second timeline entry', async () => {
    await emit(DomainEventType.PROVISIONING_DEPROVISIONED, 'id-1', {
      identityId: 'id-1',
      connector: 'entra-id',
      targetUserId: 'entra-obj-1',
      detail: 'deleted',
    });
    await settle();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'provisioning.deprovisioned',
        resourceType: 'provisioning',
        resourceId: 'id-1',
        tenantId: 'tenant-a',
        payload: {
          metadata: expect.objectContaining({
            identityId: 'id-1',
            connector: 'entra-id',
            targetUserId: 'entra-obj-1',
            detail: 'deleted',
          }),
        },
      }),
    );
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('audits a deletion of no identity (orphan cleanup, bulk delete) under its connector', async () => {
    await emit(DomainEventType.PROVISIONING_DEPROVISIONED, 'entra-id', {
      connector: 'entra-id',
      detail: 'deleted',
    });
    await settle();

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'provisioning.deprovisioned', resourceId: 'entra-id' }),
    );
    expect(recordEvent).not.toHaveBeenCalled();
  });
});
