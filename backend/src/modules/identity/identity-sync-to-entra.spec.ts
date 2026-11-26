/**
 * PATCH /identity/:id?syncToEntra=true over HTTP, with the real controller, the real onboarding
 * handler on the real Nest event emitter (EventsModule options) and the real
 * DomainEventEmitterService, an identity update that emits identity.updated as
 * IdentityMutationService does, and an onboarding start that behaves like Temporal's
 * WorkflowIdConflictPolicy.FAIL (one running run per workflow id).
 *
 * Plan 2.0da: identity.updated (async onboarding handler) and the controller's
 * identity.provision_requested each started onboarding under the same workflow id. When the
 * handler won, the response said `triggered: false, 'Workflow trigger failed'` for a run that
 * had started.
 *
 * Plan 2.0df: the real mover handler as well, with a mover start that behaves like Temporal's
 * FAIL policy. An edit that moves a provisioned identity's access starts the mover, never also
 * onboarding: two runs must not change the same identity's access at once.
 */
import { INestApplication } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from '@anatine/zod-nestjs';
import * as request from 'supertest';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { OnboardingEventHandler } from '@infrastructure/events/handlers/onboarding.handler';
import { MoverEventHandler } from '@infrastructure/events/handlers/mover.handler';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DeadLetterService } from '../dead-letter/dead-letter.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import type { OnboardingTarget } from '../onboarding/onboarding.service';
import { MoverService } from '../mover/mover.service';
import type { MoverStartInput } from '../mover/mover.service';
import { changedAccessAttributes } from '@shared/utils/access-baseline';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { maskEmailValues } from './identity-pii';
import { getModelToken } from '@nestjs/mongoose';
import { JoinerEvent } from '../joiners/schemas/joiner-event.schema';

const ID = '64b7f0c2a1b2c3d4e5f60718';
const EMAIL = 'ada@corp.example';
const TENANT = 'tenant-a';
const WORKFLOW_ID = `t-${TENANT}-onboard-${ID}`;
const MOVER_ID = `t-${TENANT}-mover-${ID}`;

/** The identity as stored before the PATCH: in Sales, not provisioned unless a test says so. */
function storedIdentity(provisioning: Array<{ targetSystem: string; status: string }> = []) {
  return {
    _id: ID,
    tenantId: TENANT,
    profile: { email: EMAIL, firstName: 'Ada', departmentName: 'Sales' },
    provisioning,
  };
}
const SYNCED = [{ targetSystem: 'entra-id', status: 'SYNCED' }];

/** Lets the setImmediate-scheduled handlers of identity.updated (`async: true`) finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('PATCH /identity/:id?syncToEntra=true', () => {
  let app: INestApplication;
  let events: DomainEventEmitterService;

  /** Workflow ids with a running onboarding run. */
  const running = new Set<string>();
  // OnboardingService.triggerOnboarding's workflow id and conflict policy FAIL
  const triggerOnboarding = jest.fn(
    async (target: OnboardingTarget, _options?: { syncToEntra?: boolean }) => {
      const workflowId = `t-${getCurrentTenantId()}-onboard-${target.identityId}`;
      if (running.has(workflowId)) {
        throw new WorkflowExecutionAlreadyStartedError(
          'Workflow execution already started',
          workflowId,
          'onboardingWorkflow',
        );
      }
      running.add(workflowId);
      return workflowId;
    },
  );

  // MoverService.triggerMover's workflow id and conflict policy FAIL
  const triggerMover = jest.fn(async (input: MoverStartInput, _options?: unknown) => {
    const workflowId = `t-${getCurrentTenantId()}-mover-${input.identityId}`;
    if (running.has(workflowId)) {
      throw new WorkflowExecutionAlreadyStartedError(
        'Workflow execution already started',
        workflowId,
        'moverWorkflow',
      );
    }
    running.add(workflowId);
    return workflowId;
  });
  /** Edits queued on an open mover run (MoverService.startOrQueueMover signals that run). */
  const queuedEdits: MoverStartInput[] = [];
  // As MoverService.startOrQueueMover: start, or queue the edit on the open run
  const startOrQueueMover = jest.fn(async (input: MoverStartInput, options?: unknown) => {
    try {
      return { workflowId: await triggerMover(input, options), queued: false };
    } catch (error: unknown) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      queuedEdits.push(input);
      return { workflowId: error.workflowId, queued: true };
    }
  });

  let stored: ReturnType<typeof storedIdentity> = storedIdentity();

  const identityService = {
    // As IdentityMutationService.updateWithChanges: save, emit identity.updated with the options
    // it was given and the before-values of the access attributes the edit changed, then read
    // the identity back (a database round trip, during which the async handlers of
    // identity.updated run) and answer it with the changes the event reported.
    updateWithChanges: jest.fn(
      async (
        id: string,
        dto: Record<string, unknown>,
        actor?: string,
        options?: { syncToEntra?: boolean; moverRequested?: boolean },
      ) => {
        const changedFields = Object.keys(dto);
        const previousAttributes = maskEmailValues(
          changedAccessAttributes(stored.profile, { ...stored.profile, ...dto }, changedFields),
        );
        events.emit(
          DomainEventType.IDENTITY_UPDATED,
          id,
          {
            identityId: id,
            changedFields,
            source: actor || 'ui-editor',
            syncToEntra: options?.syncToEntra,
            ...(options?.moverRequested ? { moverRequested: true } : {}),
            previousAttributes,
          },
          { actor: actor || 'ui-editor' },
        );
        await new Promise((resolve) => setImmediate(resolve));
        return { user: { _id: id, email: EMAIL, ...dto }, changedFields, previousAttributes };
      },
    ),
    findIdentityById: jest.fn(async () => stored),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      controllers: [IdentityController],
      providers: [
        OnboardingEventHandler,
        // joiner_events: no identity is an open HR joiner
        {
          provide: getModelToken(JoinerEvent.name),
          useValue: { exists: () => ({ exec: async () => null }) },
        },
        MoverEventHandler,
        {
          provide: DomainEventEmitterService,
          inject: [EventEmitter2],
          useFactory: (emitter: EventEmitter2) =>
            new DomainEventEmitterService(
              emitter,
              { capture: jest.fn() } as unknown as DeadLetterService,
              {} as never,
              { get: jest.fn().mockReturnValue('test') } as never,
            ),
        },
        { provide: IdentityService, useValue: identityService },
        { provide: OnboardingService, useValue: { triggerOnboarding } },
        { provide: MoverService, useValue: { triggerMover, startOrQueueMover } },
      ],
    })
      .useMocker(() => ({}))
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    // As CorrelationMiddleware with TenantContextInterceptor: the request runs in its tenant
    app.use((_req: unknown, _res: unknown, next: () => void) =>
      requestContext.run(
        { correlationId: 'test', actor: 'tester', tenantId: TENANT, startTime: Date.now() },
        next,
      ),
    );
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    events = moduleRef.get(DomainEventEmitterService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    running.clear();
    stored = storedIdentity();
    triggerOnboarding.mockClear();
    triggerMover.mockClear();
    queuedEdits.length = 0;
    identityService.updateWithChanges.mockClear();
  });

  it.each([
    ['a field onboarding does not watch', { firstName: 'Ada' }],
    ['a critical field', { departmentName: 'Finance' }],
  ])(
    'starts onboarding once for an edit of %s and reports the run it started',
    async (_case, body) => {
      const res = await request(app.getHttpServer())
        .patch(`/identity/${ID}?syncToEntra=true`)
        .send(body)
        .expect(200);
      await settle();

      expect(res.body.workflow).toEqual({
        triggered: true,
        workflowType: 'onboarding',
        workflowId: WORKFLOW_ID,
        trackingUrl: expect.stringContaining(WORKFLOW_ID),
      });
      expect(triggerOnboarding).toHaveBeenCalledTimes(1);
      expect(triggerOnboarding).toHaveBeenCalledWith(
        { identityId: ID, email: EMAIL },
        { syncToEntra: true },
      );
      expect(triggerMover).not.toHaveBeenCalled();
    },
  );

  it('reports an onboarding run already in progress with its id, not as a failed sync', async () => {
    running.add(WORKFLOW_ID); // e.g. started by an HR sync a moment ago

    const res = await request(app.getHttpServer())
      .patch(`/identity/${ID}?syncToEntra=true`)
      .send({ firstName: 'Ada' })
      .expect(200);
    await settle();

    expect(res.body.workflow).toEqual({
      triggered: false,
      workflowType: 'onboarding',
      workflowId: WORKFLOW_ID,
      trackingUrl: expect.stringContaining(WORKFLOW_ID),
      error: expect.stringContaining('already in progress'),
    });
    expect(triggerOnboarding).toHaveBeenCalledTimes(1);
  });

  it('reports any other failed start as failed, without the internal error', async () => {
    triggerOnboarding.mockRejectedValueOnce(new Error('Temporal client is not connected'));

    const res = await request(app.getHttpServer())
      .patch(`/identity/${ID}?syncToEntra=true`)
      .send({ firstName: 'Ada' })
      .expect(200);
    await settle();

    expect(res.body.workflow).toEqual({
      triggered: false,
      workflowType: 'onboarding',
      error: 'Workflow trigger failed',
    });
    expect(res.text).not.toContain('Temporal client');
    expect(triggerOnboarding).toHaveBeenCalledTimes(1);
  });

  it('starts nothing without syncToEntra when no field onboarding watches changed', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/identity/${ID}`)
      .send({ firstName: 'Ada' })
      .expect(200);
    await settle();

    expect(res.body.workflow).toBeNull();
    expect(triggerOnboarding).not.toHaveBeenCalled();
  });

  describe('an identity provisioned to a target system (the mover applies)', () => {
    beforeEach(() => {
      stored = storedIdentity(SYNCED);
    });

    // Plan 2.0dq: the run carries the sync, so it pushes the attributes to Entra ID also when it
    // changes no access there (mover workflow, patch mover:sync-to-entra)
    it('starts the mover for a trigger edit with the sync to Entra ID, not onboarding, and says so', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/identity/${ID}?syncToEntra=true`)
        .send({ departmentName: 'Finance' })
        .expect(200);
      await settle();

      expect(res.body.workflow).toEqual({
        triggered: true,
        workflowType: 'mover',
        workflowId: MOVER_ID,
        trackingUrl: expect.stringContaining(MOVER_ID),
      });
      expect(triggerMover).toHaveBeenCalledTimes(1);
      expect(triggerMover).toHaveBeenCalledWith(
        {
          identityId: ID,
          tenantId: TENANT,
          changedFields: ['departmentName'],
          previousAttributes: { departmentName: 'Sales' },
          trigger: 'attribute-change',
          syncToEntra: true,
        },
        { requestedBy: 'tester' },
      );
      expect(triggerOnboarding).not.toHaveBeenCalled();
    });

    // Plan 2.0dn: identity.move_requested reaches the audit log and the websocket as well
    it('asks the mover with the old manager masked', async () => {
      stored = {
        ...storedIdentity(SYNCED),
        profile: { ...storedIdentity().profile, managerEmail: 'old.boss@corp.example' },
      } as ReturnType<typeof storedIdentity>;

      await request(app.getHttpServer())
        .patch(`/identity/${ID}?syncToEntra=true`)
        .send({ managerEmail: 'new.boss@corp.example' })
        .expect(200);
      await settle();

      expect(triggerMover).toHaveBeenCalledTimes(1);
      expect(triggerMover.mock.calls[0][0]).toMatchObject({
        changedFields: ['managerEmail'],
        previousAttributes: { managerEmail: 'o•••@corp.example' },
      });
      expect(JSON.stringify(triggerMover.mock.calls)).not.toContain('old.boss@');
    });

    // Hunt 2026-11-25 03 F5: the edit met an open run and was dropped; now it is queued on it
    it('queues the edit with its sync on a mover run already in progress and says so', async () => {
      running.add(MOVER_ID); // e.g. an HR-driven mover started a moment ago

      const res = await request(app.getHttpServer())
        .patch(`/identity/${ID}?syncToEntra=true`)
        .send({ departmentName: 'Finance' })
        .expect(200);
      await settle();

      expect(res.body.workflow).toEqual({
        triggered: false,
        queued: true,
        workflowType: 'mover',
        workflowId: MOVER_ID,
        trackingUrl: expect.stringContaining(MOVER_ID),
        message: expect.stringContaining('applies this access change when it has finished'),
      });
      expect(queuedEdits).toEqual([
        expect.objectContaining({ changedFields: ['departmentName'], syncToEntra: true }),
      ]);
      expect(triggerOnboarding).not.toHaveBeenCalled();
    });

    it.each([
      ['a field onboarding does not watch', { firstName: 'Augusta' }],
      ['a trigger attribute sent unchanged', { departmentName: 'Sales', firstName: 'Augusta' }],
    ])('syncs to Entra ID with onboarding for an edit of %s', async (_case, body) => {
      const res = await request(app.getHttpServer())
        .patch(`/identity/${ID}?syncToEntra=true`)
        .send(body)
        .expect(200);
      await settle();

      expect(res.body.workflow).toEqual({
        triggered: true,
        workflowType: 'onboarding',
        workflowId: WORKFLOW_ID,
        trackingUrl: expect.stringContaining(WORKFLOW_ID),
      });
      expect(triggerOnboarding).toHaveBeenCalledTimes(1);
      expect(triggerMover).not.toHaveBeenCalled();
    });

    // The PATCH asks the mover itself now, so its answer can report the run or the queued change
    it('starts the mover once for a trigger edit without syncToEntra and reports the run', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/identity/${ID}`)
        .send({ departmentName: 'Finance' })
        .expect(200);
      await settle();

      expect(res.body.workflow).toEqual({
        triggered: true,
        workflowType: 'mover',
        workflowId: MOVER_ID,
        trackingUrl: expect.stringContaining(MOVER_ID),
      });
      expect(triggerMover).toHaveBeenCalledTimes(1);
      expect(triggerMover.mock.calls[0][0]).toMatchObject({
        changedFields: ['departmentName'],
        previousAttributes: { departmentName: 'Sales' },
        trigger: 'attribute-change',
      });
      expect(triggerMover.mock.calls[0][0]).not.toHaveProperty('syncToEntra');
      expect(triggerOnboarding).not.toHaveBeenCalled();
    });

    it('queues an edit without syncToEntra on a mover run in progress and says so', async () => {
      running.add(MOVER_ID);

      const res = await request(app.getHttpServer())
        .patch(`/identity/${ID}`)
        .send({ jobTitle: 'Lead' })
        .expect(200);
      await settle();

      expect(res.body.workflow).toMatchObject({ queued: true, workflowId: MOVER_ID });
      expect(queuedEdits).toHaveLength(1);
      expect(queuedEdits[0]).toMatchObject({ changedFields: ['jobTitle'] });
      expect(queuedEdits[0]).not.toHaveProperty('syncToEntra');
      expect(triggerOnboarding).not.toHaveBeenCalled();
    });

    it('asks no mover for an edit that moves no trigger attribute', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/identity/${ID}`)
        .send({ firstName: 'Augusta' })
        .expect(200);
      await settle();

      expect(res.body.workflow).toBeNull();
      expect(triggerMover).not.toHaveBeenCalled();
    });
  });
});
