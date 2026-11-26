import { Injectable } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule, OnEvent } from '@nestjs/event-emitter';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { DomainEventEmitterService } from '../event-emitter.service';
import { DomainEventType } from '../event-types';
import { DeadLetterService } from '../../../modules/dead-letter/dead-letter.service';
import { AccessRequestsService } from '../../../modules/access-requests/access-requests.service';
import { OffboardingService } from '../../../modules/offboarding/offboarding.service';
import { OnboardingService } from '../../../modules/onboarding/onboarding.service';
import { IdentityService } from '../../../modules/identity/identity.service';
import { OffboardImpactEventHandler } from './offboard-impact.handler';
import { OffboardingEventHandler } from './offboarding-event.handler';
import { OnboardingEventHandler } from './onboarding.handler';
import { HrMoverSyncHandler } from '../../../modules/mover/hr-mover-sync.handler';
import { HrMoverDetectionService } from '../../../modules/mover/hr-mover-detection.service';
import { JoinerSyncHandler } from '../../../modules/joiners/joiner-sync.handler';
import { JoinerDetectionService } from '../../../modules/joiners/joiner-detection.service';
import { getCurrentTenantId } from '../../multi-tenancy/tenant-context.helper';
import { isMoverSyncSummary } from '@shared/interfaces/mover-sync';
import { isJoinerSyncSummary } from '@shared/interfaces/joiner-sync';
import { getModelToken } from '@nestjs/mongoose';
import { JoinerEvent } from '../../../modules/joiners/schemas/joiner-event.schema';

const IDENTITY_ID = '507f1f77bcf86cd799439011';
const TENANT = { tenantId: 'tenant-a' };

/** Stands in for AuditEventHandler / EventDeliveryService, which listen to every event. */
@Injectable()
class CatchAllAsyncListener {
  @OnEvent('**', { async: true })
  async handleAny(): Promise<void> {}
}

/**
 * The identity controller reads results[0] of emitAndWait for these request/response events.
 * Runs the real DomainEventEmitterService on the real Nest event emitter (same EventEmitter2
 * options as EventsModule): a handler registered with `async: true` hands back a setImmediate
 * handle instead of its return value.
 */
describe('request/response handlers called through emitAndWait', () => {
  let moduleRef: TestingModule;
  let events: DomainEventEmitterService;
  const findActiveRequestsForIdentity = jest.fn();
  const triggerOffboarding = jest.fn();
  const triggerOnboarding = jest.fn();
  const evaluateSync = jest.fn();
  const evaluateJoiners = jest.fn();
  /** The tenant each identity read ran in. */
  const identityReads: Array<[string, string]> = [];
  // The onboarding and offboarding events carry no email: the handlers read it by the id
  const findIdentityById = jest.fn(async (id: string) => {
    identityReads.push([id, getCurrentTenantId()]);
    return { _id: id, profile: { email: 'ada@example.com' } } as unknown;
  });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [
        OffboardImpactEventHandler,
        OffboardingEventHandler,
        OnboardingEventHandler,
        // joiner_events: no identity is an open HR joiner
        {
          provide: getModelToken(JoinerEvent.name),
          useValue: { exists: () => ({ exec: async () => null }) },
        },
        HrMoverSyncHandler,
        JoinerSyncHandler,
        CatchAllAsyncListener,
        { provide: AccessRequestsService, useValue: { findActiveRequestsForIdentity } },
        { provide: OffboardingService, useValue: { triggerOffboarding } },
        { provide: OnboardingService, useValue: { triggerOnboarding } },
        { provide: IdentityService, useValue: { findIdentityById } },
        { provide: HrMoverDetectionService, useValue: { evaluateSync } },
        { provide: JoinerDetectionService, useValue: { evaluateSync: evaluateJoiners } },
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
    identityReads.length = 0;
    findIdentityById.mockClear();
    triggerOffboarding.mockReset();
    triggerOnboarding.mockReset();
  });

  it('returns the active access requests for the offboard impact preview', async () => {
    const requests = [
      { requestId: 'AR-1', entitlements: [{ system: 'entra-id', entitlementName: 'Finance-RO' }] },
    ];
    findActiveRequestsForIdentity.mockResolvedValue(requests);

    const results = await events.emitAndWait(
      DomainEventType.IDENTITY_OFFBOARD_IMPACT_QUERY,
      IDENTITY_ID,
      { identityId: IDENTITY_ID },
      TENANT,
    );

    expect(findActiveRequestsForIdentity).toHaveBeenCalledWith(IDENTITY_ID);
    expect(results[0]).toEqual(requests);
  });

  it('returns the offboarding workflow id, with the email read from the identity', async () => {
    triggerOffboarding.mockResolvedValue('offboarding-wf-1');

    const results = await events.emitAndWait(
      DomainEventType.IDENTITY_OFFBOARD_REQUESTED,
      IDENTITY_ID,
      { userId: IDENTITY_ID },
      TENANT,
    );

    // The event carries no email (audit log, websocket, dead letters): read by id, in its tenant.
    // A manual DELETE carries no reason.
    expect(identityReads).toEqual([[IDENTITY_ID, 'tenant-a']]);
    expect(triggerOffboarding).toHaveBeenCalledWith(IDENTITY_ID, 'ada@example.com', undefined);
    expect(results[0]).toBe('offboarding-wf-1');
  });

  it('starts no offboarding for an identity that is gone or has no email', async () => {
    findIdentityById.mockResolvedValueOnce(null);

    const results = await events.emitAndWait(
      DomainEventType.IDENTITY_OFFBOARD_REQUESTED,
      IDENTITY_ID,
      { userId: IDENTITY_ID },
      TENANT,
    );

    expect(triggerOffboarding).not.toHaveBeenCalled();
    expect(results.find((r) => typeof r === 'string')).toBeUndefined();
  });

  it('passes an HR leaver reason through to the offboarding workflow', async () => {
    triggerOffboarding.mockResolvedValue('offboarding-wf-2');

    const results = await events.emitAndWait(
      DomainEventType.IDENTITY_OFFBOARD_REQUESTED,
      IDENTITY_ID,
      { userId: IDENTITY_ID, reason: 'leaver:terminated' },
      TENANT,
    );

    expect(triggerOffboarding).toHaveBeenCalledWith(
      IDENTITY_ID,
      'ada@example.com',
      'leaver:terminated',
    );
    expect(results[0]).toBe('offboarding-wf-2');
  });

  it('returns the onboarding workflow id for a provision request', async () => {
    triggerOnboarding.mockResolvedValue('onboarding-wf-1');

    const results = await events.emitAndWait(
      DomainEventType.IDENTITY_PROVISION_REQUESTED,
      IDENTITY_ID,
      {},
      TENANT,
    );

    // The workflow id is built from the identity (the event's aggregate), never the email. The
    // event carries no email: the handler reads it from the identity, in the event's tenant.
    expect(identityReads).toEqual([[IDENTITY_ID, 'tenant-a']]);
    expect(triggerOnboarding).toHaveBeenCalledWith(
      { identityId: IDENTITY_ID, email: 'ada@example.com' },
      undefined,
    );
    expect(results[0]).toBe('onboarding-wf-1');
  });

  it('starts no onboarding for an identity without an email', async () => {
    findIdentityById.mockResolvedValueOnce({ _id: IDENTITY_ID, profile: {} });

    const results = await events.emitAndWait(
      DomainEventType.IDENTITY_PROVISION_REQUESTED,
      IDENTITY_ID,
      {},
      TENANT,
    );

    expect(triggerOnboarding).not.toHaveBeenCalled();
    expect(results.find((r) => typeof r === 'string')).toBeUndefined();
  });

  it('asks onboarding to push to Entra ID again for a syncToEntra provision request', async () => {
    triggerOnboarding.mockResolvedValue('onboarding-wf-2');

    await events.emitAndWait(
      DomainEventType.IDENTITY_PROVISION_REQUESTED,
      IDENTITY_ID,
      { syncToEntra: true },
      TENANT,
    );

    expect(triggerOnboarding).toHaveBeenCalledWith(
      { identityId: IDENTITY_ID, email: 'ada@example.com' },
      { syncToEntra: true },
    );
  });

  it('passes the reason of an HR joiner on to onboarding, for the workflow memo', async () => {
    triggerOnboarding.mockResolvedValue('onboarding-wf-3');

    const results = await events.emitAndWait(
      DomainEventType.IDENTITY_PROVISION_REQUESTED,
      IDENTITY_ID,
      { reason: 'joiner:hr-sync:csv-hr' },
      TENANT,
    );

    expect(triggerOnboarding).toHaveBeenCalledWith(
      { identityId: IDENTITY_ID, email: 'ada@example.com' },
      { reason: 'joiner:hr-sync:csv-hr' },
    );
    expect(results[0]).toBe('onboarding-wf-3');
  });

  // Nest suppresses a handler's error unless suppressErrors is false: the controller then saw
  // only "no workflow id" and could not tell an onboarding run already in progress from a failure.
  it('rejects with the start error, so the controller can report a run already in progress', async () => {
    const alreadyStarted = new WorkflowExecutionAlreadyStartedError(
      'Workflow execution already started',
      `t-tenant-a-onboard-${IDENTITY_ID}`,
      'onboardingWorkflow',
    );
    triggerOnboarding.mockRejectedValueOnce(alreadyStarted);

    await expect(
      events.emitAndWait(
        DomainEventType.IDENTITY_PROVISION_REQUESTED,
        IDENTITY_ID,
        { syncToEntra: true },
        TENANT,
      ),
    ).rejects.toBe(alreadyStarted);
  });

  it('returns the HR mover summary, detected in the tenant of the sync', async () => {
    const summary = { kind: 'mover-sync-summary', sourceName: 'csv-hr', detected: 0 };
    evaluateSync.mockImplementation(async () => {
      expect(getCurrentTenantId()).toBe('tenant-a');
      return summary;
    });
    const run = {
      connectorName: 'csv-hr',
      sourceName: 'csv-hr',
      startedAt: '2026-11-22T10:00:00.000Z',
      completedAt: '2026-11-22T10:00:05.000Z',
      fetched: 3,
      skipped: 0,
      ingested: 3,
      errorCount: 0,
    };

    const results = await events.emitAndWait(
      DomainEventType.HR_SYNC_MOVERS_REQUESTED,
      'csv-hr',
      run,
      TENANT,
    );

    expect(evaluateSync).toHaveBeenCalledWith('tenant-a', run);
    expect(results.find(isMoverSyncSummary)).toEqual(summary);
  });

  it('returns the HR joiner summary, detected in the tenant of the sync', async () => {
    const summary = { kind: 'joiner-sync-summary', sourceName: 'csv-hr', detected: 2 };
    evaluateJoiners.mockImplementation(async () => {
      expect(getCurrentTenantId()).toBe('tenant-a');
      return summary;
    });
    const run = {
      connectorName: 'csv-hr',
      sourceName: 'csv-hr',
      startedAt: '2026-11-23T10:00:00.000Z',
      completedAt: '2026-11-23T10:00:05.000Z',
      fetched: 2,
      skipped: 0,
      ingested: 2,
      errorCount: 0,
    };

    const results = await events.emitAndWait(
      DomainEventType.HR_SYNC_JOINERS_REQUESTED,
      'csv-hr',
      run,
      TENANT,
    );

    expect(evaluateJoiners).toHaveBeenCalledWith('tenant-a', run);
    expect(results.find(isJoinerSyncSummary)).toEqual(summary);
  });
});
