/**
 * identity.updated from an operator's edit (PATCH /identity/:id, IdentityMutationService) through
 * the real DomainEventEmitterService (zod payload schema) on the real Nest event emitter, to the
 * real mover and onboarding handlers. Identity lookup and workflow starts are stubbed.
 *
 * Plan 2.0df: the payload schema had no previousAttributes and zod strips unknown keys, so the
 * mover handler returned on every edit and onboarding started instead.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { DomainEventEmitterService } from '../event-emitter.service';
import { DomainEventType } from '../event-types';
import type { IdentityUpdatedPayload } from '../event-payloads';
import { DeadLetterService } from '../../../modules/dead-letter/dead-letter.service';
import { IdentityService } from '../../../modules/identity/identity.service';
import { MoverService } from '../../../modules/mover/mover.service';
import { OnboardingService } from '../../../modules/onboarding/onboarding.service';
import { MoverEventHandler } from './mover.handler';
import { OnboardingEventHandler } from './onboarding.handler';
import { getModelToken } from '@nestjs/mongoose';
import { JoinerEvent } from '../../../modules/joiners/schemas/joiner-event.schema';

const ID = '64b7f0c2a1b2c3d4e5f60718';
const EMAIL = 'ada@corp.example';
const TENANT = 'tenant-a';

/** Lets the setImmediate-scheduled handlers of identity.updated (`async: true`) finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** The identity as stored after the edit. */
function identity(provisioning: Array<Record<string, unknown>>) {
  return {
    _id: ID,
    tenantId: TENANT,
    profile: { email: EMAIL, departmentName: 'Finance' },
    provisioning,
  };
}

const PROVISIONED = identity([{ targetSystem: 'entra-id', status: 'SYNCED' }]);

describe('identity.updated from an operator edit: mover or onboarding', () => {
  let moduleRef: TestingModule;
  let events: DomainEventEmitterService;
  const findIdentityById = jest.fn();
  const triggerMover = jest.fn();
  /** MoverService.startOrQueueMover: the run started (triggerMover), or the edit queued. */
  const startOrQueueMover = jest.fn();
  const triggerOnboarding = jest.fn();

  beforeAll(async () => {
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
        { provide: IdentityService, useValue: { findIdentityById } },
        { provide: MoverService, useValue: { startOrQueueMover } },
        { provide: OnboardingService, useValue: { triggerOnboarding } },
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
    findIdentityById.mockReset().mockResolvedValue(PROVISIONED);
    triggerMover.mockReset().mockResolvedValue(`t-${TENANT}-mover-${ID}`);
    startOrQueueMover.mockReset().mockImplementation(async (input, options) => ({
      workflowId: await triggerMover(input, options),
      queued: false,
    }));
    triggerOnboarding.mockReset().mockResolvedValue(`t-${TENANT}-onboard-ada`);
  });

  /** As IdentityMutationService emits it for an operator's PATCH. */
  async function edit(payload: Partial<IdentityUpdatedPayload>): Promise<void> {
    events.emit<IdentityUpdatedPayload>(
      DomainEventType.IDENTITY_UPDATED,
      ID,
      {
        identityId: ID,
        changedFields: [],
        source: 'operator@corp.example',
        ...payload,
      },
      { tenantId: TENANT, actor: 'operator@corp.example' },
    );
    await settle();
  }

  // PROVISIONED has no access baseline (provisioned before it existed): the edit's values before
  // the change are the "before", and the completed run records the first baseline
  it('hands the before-values through the payload schema to the mover', async () => {
    await edit({
      changedFields: ['departmentName'],
      previousAttributes: { departmentName: 'Sales' },
    });

    expect(triggerMover).toHaveBeenCalledWith(
      {
        identityId: ID,
        tenantId: TENANT,
        changedFields: ['departmentName'],
        previousAttributes: { departmentName: 'Sales' },
        trigger: 'attribute-change',
      },
      { requestedBy: 'operator@corp.example' },
    );
  });

  it.each([
    ['departmentName', 'Sales'],
    ['jobTitle', 'Analyst'],
    ['location', 'Tampere'],
    // IdentityMutationService masks the old manager (plan 2.0dn)
    ['managerEmail', 'o•••@corp.example'],
  ])('starts the mover once and onboarding not at all for an edit of %s', async (field, before) => {
    await edit({ changedFields: [field], previousAttributes: { [field]: before } });

    expect(triggerMover).toHaveBeenCalledTimes(1);
    expect(triggerMover.mock.calls[0][0]).toMatchObject({ changedFields: [field] });
    expect(triggerOnboarding).not.toHaveBeenCalled();
  });

  it('starts neither for an edit of a field outside the trigger attributes', async () => {
    await edit({ changedFields: ['firstName'], previousAttributes: {} });

    expect(triggerMover).not.toHaveBeenCalled();
    expect(triggerOnboarding).not.toHaveBeenCalled();
  });

  // The identity page sends every profile field on save. The trigger attributes it did not
  // change carry no before-value, so they move no access; onboarding starts as it did before.
  it('starts no mover when a full-form save changes no trigger attribute', async () => {
    await edit({
      changedFields: ['firstName', 'departmentName', 'jobTitle', 'location', 'managerEmail'],
      previousAttributes: {},
    });

    expect(triggerMover).not.toHaveBeenCalled();
    expect(triggerOnboarding).toHaveBeenCalledTimes(1);
  });

  it('moves only the trigger attributes whose value the edit changed', async () => {
    await edit({
      changedFields: ['departmentName', 'jobTitle', 'location', 'managerEmail'],
      previousAttributes: { jobTitle: 'Analyst' },
    });

    expect(triggerMover).toHaveBeenCalledTimes(1);
    expect(triggerMover.mock.calls[0][0]).toMatchObject({
      changedFields: ['jobTitle'],
      previousAttributes: { jobTitle: 'Analyst' },
    });
  });

  // The mover's own rule (provisionedSystems): an account once provisioned, until a deprovision.
  // Before, an identity whose only target failed in a mover run (ERROR) went to onboarding,
  // which only adds access.
  it('starts the mover for an identity whose only target is in ERROR after a mover run', async () => {
    findIdentityById.mockResolvedValue(
      identity([{ targetSystem: 'okta', status: 'ERROR', provisionedAt: new Date('2026-11-02') }]),
    );

    await edit({
      changedFields: ['departmentName'],
      previousAttributes: { departmentName: 'Sales' },
    });

    expect(triggerMover).toHaveBeenCalledTimes(1);
    expect(triggerOnboarding).not.toHaveBeenCalled();
  });

  it.each([
    ['no target system', []],
    ['a target still pending', [{ targetSystem: 'entra-id', status: 'PENDING' }]],
    ['a target onboarding failed before any account', [{ targetSystem: 'okta', status: 'ERROR' }]],
    [
      'a deprovisioned target',
      [{ targetSystem: 'okta', status: 'DEPROVISIONED', provisionedAt: null }],
    ],
  ])('leaves an identity with %s to onboarding, which starts once', async (_case, provisioning) => {
    findIdentityById.mockResolvedValue(identity(provisioning));

    await edit({
      changedFields: ['departmentName'],
      previousAttributes: { departmentName: 'Sales' },
    });

    expect(triggerMover).not.toHaveBeenCalled();
    expect(triggerOnboarding).toHaveBeenCalledTimes(1);
    // The event carries no email: onboarding reads it from the identity
    expect(triggerOnboarding).toHaveBeenCalledWith({ identityId: ID, email: EMAIL });
  });

  // Plan 2.0dq: the edit's pre-edit values were the "before", so a change not yet applied (a
  // paused or rejected HR batch, a failed run) was skipped: the access granted for the
  // baseline's value stayed, and the completed run advanced the baseline past it.
  describe('an identity with an access baseline (the profile its access was last applied with)', () => {
    const withBaseline = (attributes: Record<string, unknown>) => ({
      ...PROVISIONED,
      accessBaseline: { attributes, recordedAt: new Date('2026-11-01'), recordedBy: 'mover' },
    });

    it("moves from the baseline's values, not the values before the edit", async () => {
      // HR moved Ada from Sales to Marketing; that batch waits for approval, so her access is
      // still Sales's when the operator moves her to Finance
      findIdentityById.mockResolvedValue(
        withBaseline({ departmentName: 'Sales', jobTitle: 'Rep' }),
      );

      await edit({
        changedFields: ['departmentName'],
        previousAttributes: { departmentName: 'Marketing' },
      });

      expect(triggerMover).toHaveBeenCalledWith(
        {
          identityId: ID,
          tenantId: TENANT,
          changedFields: ['departmentName'],
          previousAttributes: { departmentName: 'Sales' },
          trigger: 'attribute-change',
        },
        { requestedBy: 'operator@corp.example' },
      );
    });

    it('takes null for a trigger attribute the baseline has no value for', async () => {
      findIdentityById.mockResolvedValue(withBaseline({ departmentName: 'Finance' }));

      await edit({ changedFields: ['location'], previousAttributes: { location: 'Tampere' } });

      expect(triggerMover.mock.calls[0][0]).toMatchObject({
        changedFields: ['location'],
        previousAttributes: { location: null },
      });
    });

    it('moves the run PATCH ?syncToEntra=true starts from the baseline too', async () => {
      findIdentityById.mockResolvedValue(withBaseline({ departmentName: 'Sales' }));

      const results = await events.emitAndWait(
        DomainEventType.IDENTITY_MOVE_REQUESTED,
        ID,
        {
          identityId: ID,
          changedFields: ['departmentName'],
          previousAttributes: { departmentName: 'Marketing' },
        },
        { tenantId: TENANT, actor: 'operator@corp.example' },
      );

      expect(results).toContain(`t-${TENANT}-mover-${ID}`);
      expect(triggerMover).toHaveBeenCalledTimes(1);
      expect(triggerMover.mock.calls[0][0]).toMatchObject({
        changedFields: ['departmentName'],
        previousAttributes: { departmentName: 'Sales' },
      });
    });
  });

  it('leaves a PATCH ?syncToEntra=true to the controller, which starts the run itself', async () => {
    await edit({
      changedFields: ['departmentName'],
      previousAttributes: { departmentName: 'Sales' },
      syncToEntra: true,
    });

    expect(triggerMover).not.toHaveBeenCalled();
    expect(triggerOnboarding).not.toHaveBeenCalled();
  });

  it('leaves a PATCH that asks the mover itself (moverRequested) to the controller', async () => {
    await edit({
      changedFields: ['departmentName'],
      previousAttributes: { departmentName: 'Sales' },
      moverRequested: true,
    });

    expect(startOrQueueMover).not.toHaveBeenCalled();
    // Onboarding defers to the mover for a provisioned identity
    expect(triggerOnboarding).not.toHaveBeenCalled();
  });

  // Hunt 2026-11-25 03 F5: a start that met an open run was logged and dropped
  it('queues an edit from another source on the open run instead of dropping it', async () => {
    startOrQueueMover.mockResolvedValue({ workflowId: `t-${TENANT}-mover-${ID}`, queued: true });

    await edit({ changedFields: ['jobTitle'], previousAttributes: { jobTitle: 'Clerk' } });

    expect(startOrQueueMover).toHaveBeenCalledTimes(1);
    expect(startOrQueueMover.mock.calls[0][0]).toMatchObject({ changedFields: ['jobTitle'] });
  });

  it('answers identity.move_requested with the queued edit, and with the run id for a start', async () => {
    const ask = () =>
      events.emitAndWait(
        DomainEventType.IDENTITY_MOVE_REQUESTED,
        ID,
        { identityId: ID, changedFields: ['jobTitle'], previousAttributes: { jobTitle: 'Clerk' } },
        { tenantId: TENANT, actor: 'operator@corp.example' },
      );

    expect(await ask()).toContain(`t-${TENANT}-mover-${ID}`);
    expect(startOrQueueMover.mock.calls[0][0]).not.toHaveProperty('syncToEntra');

    startOrQueueMover.mockResolvedValue({ workflowId: `t-${TENANT}-mover-${ID}`, queued: true });
    expect(await ask()).toContainEqual({
      moverQueued: true,
      workflowId: `t-${TENANT}-mover-${ID}`,
    });
  });
});
