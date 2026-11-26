/**
 * The write-back to the identity (onboarding and admin-account provisioning, after a target
 * created the account) through the real DomainEventEmitterService (zod payload schema) on the
 * real Nest event emitter, to the real identity.updated handlers: mover, onboarding, user
 * timeline, audit and access-graph sync. The Hub write (pushSourceAndReconcile), identity lookups,
 * workflow starts and the stores the handlers write to are stubbed.
 *
 * Plan 2.0du: the write-back emitted identity.updated without changedFields. Outside production
 * the emitter threw after the write, so the activity failed and Temporal retried a write that had
 * succeeded; in production the event was dead-lettered and its timeline and audit entries lost.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken } from '@nestjs/mongoose';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { AuditEventHandler } from '@infrastructure/events/handlers/audit-event.handler';
import { MoverEventHandler } from '@infrastructure/events/handlers/mover.handler';
import { OnboardingEventHandler } from '@infrastructure/events/handlers/onboarding.handler';
import { UserTimelineHandler } from '@infrastructure/events/handlers/user-timeline.handler';
import { GraphService } from '@infrastructure/graph/graph.service';
import { GraphSyncService } from '../modules/access-explorer/graph-sync.service';
import { AuditService } from '../modules/audit/audit.service';
import { DeadLetterService } from '../modules/dead-letter/dead-letter.service';
import { IdentityService } from '../modules/identity/identity.service';
import { UserEventService } from '../modules/identity/user-event.service';
import { MoverService } from '../modules/mover/mover.service';
import { OnboardingService } from '../modules/onboarding/onboarding.service';
import { WritebackActivities } from './writeback.activities';
import { JoinerEvent } from '../modules/joiners/schemas/joiner-event.schema';

const ID = '64b7f0c2a1b2c3d4e5f60718';
const EMAIL = 'ada@corp.example';
const TENANT = 'tenant-a';

/** Lets the setImmediate-scheduled handlers of identity.updated (`async: true`) finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * The identity after the write-back. Onboarding marks the target SYNCED after the write-back, so
 * the first write-back sees no SYNCED target: an edit of a trigger attribute would onboard it.
 */
const RECONCILED = {
  _id: ID,
  tenantId: TENANT,
  profile: { email: EMAIL, departmentName: 'Finance' },
  provisioning: [],
};

/** Entra ID's result for a new account: its object id and the generated mail and UPN. */
const ENTRA_RESULT = {
  objectId: 'entra-object-1',
  generatedAttributes: { mail: EMAIL, userPrincipalName: EMAIL },
};
const WRITTEN = ['mail', 'userPrincipalName', 'objectId', 'email'];

describe('write-back to the identity: identity.updated', () => {
  let moduleRef: TestingModule;
  let events: DomainEventEmitterService;
  let writeback: WritebackActivities;
  const pushSourceAndReconcile = jest.fn();
  const findIdentityById = jest.fn();
  const triggerMover = jest.fn();
  const triggerOnboarding = jest.fn();
  const recordEvent = jest.fn();
  const auditLog = jest.fn();
  const runWriteQuery = jest.fn();
  const capture = jest.fn();

  beforeAll(async () => {
    const identityService = { pushSourceAndReconcile, findIdentityById };
    moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [
        MoverEventHandler,
        OnboardingEventHandler,
        // joiner_events: no identity is an open HR joiner
        {
          provide: getModelToken(JoinerEvent.name),
          useValue: { exists: () => ({ exec: async () => null }) },
        },
        UserTimelineHandler,
        AuditEventHandler,
        GraphSyncService,
        { provide: IdentityService, useValue: identityService },
        { provide: MoverService, useValue: { triggerMover } },
        { provide: OnboardingService, useValue: { triggerOnboarding } },
        { provide: UserEventService, useValue: { recordEvent } },
        { provide: AuditService, useValue: { log: auditLog } },
        { provide: GraphService, useValue: { runWriteQuery } },
        // GraphSyncService reads the identity's email (identity.updated carries none)
        {
          provide: getModelToken('Identity'),
          useValue: {
            findOne: () => ({ select: () => ({ lean: () => ({ exec: async () => RECONCILED }) }) }),
          },
        },
        // GraphSyncService reads a system's catalog on discovery.completed, which no test emits
        { provide: getModelToken('EntitlementCatalog'), useValue: {} },
      ],
    }).compile();
    await moduleRef.init();

    events = new DomainEventEmitterService(
      moduleRef.get(EventEmitter2),
      { capture } as unknown as DeadLetterService,
      {} as never,
      { get: jest.fn().mockReturnValue('test') } as never,
    );
    writeback = new WritebackActivities(
      identityService as unknown as IdentityService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      events,
    );
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    pushSourceAndReconcile.mockReset().mockResolvedValue(RECONCILED);
    findIdentityById.mockReset().mockResolvedValue(RECONCILED);
    triggerMover.mockReset().mockResolvedValue(`t-${TENANT}-mover-${ID}`);
    triggerOnboarding.mockReset().mockResolvedValue(`t-${TENANT}-onboard-ada`);
    recordEvent.mockReset().mockResolvedValue({});
    auditLog.mockReset().mockResolvedValue(undefined);
    runWriteQuery.mockReset().mockResolvedValue([]);
    capture.mockReset();
  });

  it('completes after the write: its identity.updated passes the payload schema', async () => {
    await expect(
      writeback.writebackToIdentity(ID, 'entra-id', ENTRA_RESULT, TENANT, 'corr-1'),
    ).resolves.toEqual({ success: true, updatedFields: WRITTEN });
    await settle();

    expect(pushSourceAndReconcile).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
  });

  it('records the written fields and the target system in the timeline and the audit log', async () => {
    await writeback.writebackToIdentity(ID, 'entra-id', ENTRA_RESULT, TENANT, 'corr-1');
    await settle();

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ID,
        type: 'USER_UPDATED',
        title: `Updated: ${WRITTEN.join(', ')}`,
        targetSystem: 'entra-id',
        metadata: { changedFields: WRITTEN, source: 'writeback' },
      }),
    );
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: DomainEventType.IDENTITY_UPDATED,
        resourceId: ID,
        tenantId: TENANT,
        payload: {
          metadata: expect.objectContaining({
            identityId: ID,
            changedFields: WRITTEN,
            source: 'writeback',
            targetSystem: 'entra-id',
          }),
        },
      }),
    );
  });

  it("keeps the identity's email on its access-graph node", async () => {
    await writeback.writebackToIdentity(ID, 'entra-id', ENTRA_RESULT, TENANT, 'corr-1');
    await settle();

    // Plan 2.0dn: the event names no email (the audit entry shows its payload); the graph
    // sync reads the identity's
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain(EMAIL);

    expect(runWriteQuery).toHaveBeenCalledWith(
      expect.stringContaining('MERGE (i:Identity'),
      expect.objectContaining({
        id: ID,
        email: EMAIL,
        source: 'writeback',
        changedFields: WRITTEN,
      }),
    );
  });

  it('starts neither a mover nor another onboarding run, also for a trigger attribute', async () => {
    // A connector that returns a profile attribute with the account it created
    await writeback.writebackToIdentity(
      ID,
      'scim',
      { objectId: 'scim-1', generatedAttributes: { departmentName: 'Finance' } },
      TENANT,
      'corr-1',
    );
    await settle();

    expect(triggerMover).not.toHaveBeenCalled();
    expect(triggerOnboarding).not.toHaveBeenCalled();

    // The same change saved by an operator onboards the identity (not provisioned yet)
    events.emit(
      DomainEventType.IDENTITY_UPDATED,
      ID,
      { identityId: ID, changedFields: ['departmentName'], source: 'operator' },
      { tenantId: TENANT },
    );
    await settle();
    expect(triggerOnboarding).toHaveBeenCalledWith({ identityId: ID, email: EMAIL });
    expect(triggerMover).not.toHaveBeenCalled();
  });
});
