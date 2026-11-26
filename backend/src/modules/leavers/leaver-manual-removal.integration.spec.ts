/**
 * Closing a failed offboarding target by hand (in-memory MongoDB, tenant plugin), keyed by the
 * offboarding's workflow id: the target's result becomes removed-manually with the admin and
 * their note, the identity side is asked to mark it gone (and to delete the Golden Record once
 * nothing is left failed), only a failed target can be closed and only once, a failed identity
 * update reopens the target, and the open list holds only this tenant's offboardings with a
 * failed target. Offboardings started by DELETE /identity/:id have no leaver event and are
 * listed and closed the same way. The identity handler is stubbed here;
 * test/workflows/offboarding-per-system.workflow.e2e-spec.ts runs the real one.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type {
  OffboardingLinkedAdminResult,
  OffboardingSystemResult,
} from '@shared/types/deprovision';
import { Identity, IdentitySchema, IdentityDocument } from '../identity/schemas/identity.schema';
import { LeaverEvent, LeaverEventSchema, LeaverEventDocument } from './schemas/leaver-event.schema';
import {
  OffboardingRecord,
  OffboardingRecordDocument,
  OffboardingRecordSchema,
} from './schemas/offboarding-record.schema';
import { LeaverManualRemovalService } from './leaver-manual-removal.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';
const ADMIN = 'admin@tenant-a.example';

describe('Offboarding: failed target removed manually (MongoDB)', () => {
  let moduleRef: TestingModule;
  let service: LeaverManualRemovalService;
  let identityModel: Model<IdentityDocument>;
  let eventModel: Model<LeaverEventDocument>;
  let recordModel: Model<OffboardingRecordDocument>;
  const events = { emit: jest.fn(), emitAndWait: jest.fn() };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: LeaverEvent.name, schema: LeaverEventSchema },
          { name: OffboardingRecord.name, schema: OffboardingRecordSchema },
        ]),
      ],
      providers: [
        LeaverManualRemovalService,
        { provide: DomainEventEmitterService, useValue: events },
      ],
    }).compile();
    service = moduleRef.get(LeaverManualRemovalService);
    identityModel = moduleRef.get(getModelToken(Identity.name));
    eventModel = moduleRef.get(getModelToken(LeaverEvent.name));
    recordModel = moduleRef.get(getModelToken(OffboardingRecord.name));
    await recordModel.createIndexes();
  });

  beforeEach(() => {
    events.emitAndWait.mockReset().mockResolvedValue(['suspended']);
  });

  afterEach(async () => {
    await identityModel.deleteMany({}, { skipTenantScope: true });
    await eventModel.deleteMany({}, { skipTenantScope: true });
    await recordModel.deleteMany({}, { skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  /**
   * An identity whose offboarding reported `systems` (its offboarding record), started by a
   * leaver event or, with `leaver: false`, by DELETE /identity/:id.
   */
  async function offboarded(
    tenantId: string,
    systems: OffboardingSystemResult[],
    {
      name = 'ada',
      leaver = true,
      linkedAdmins,
    }: { name?: string; leaver?: boolean; linkedAdmins?: OffboardingLinkedAdminResult[] } = {},
  ): Promise<{ workflowId: string; identityId: string; eventId?: string }> {
    return withTenantContext(tenantId, async () => {
      const identity = await identityModel.create({
        tenantId,
        profile: { firstName: name, lastName: 'Test', email: `${name}@corp.example` },
      });
      const identityId = String(identity._id);
      const workflowId = `t-${tenantId}-offboard-${identityId}`;
      const failed =
        systems.some((s) => s.outcome === 'failed') ||
        (linkedAdmins ?? []).some((a) => a.outcome === 'failed');
      await recordModel.create({
        tenantId,
        workflowId,
        identityId,
        status: failed ? 'partial-failure' : 'completed',
        hubStatus: failed ? 'suspended' : 'deleted',
        systems,
        ...(linkedAdmins ? { linkedAdmins } : {}),
        finishedAt: new Date(),
      });
      if (!leaver) return { workflowId, identityId };
      const event = await eventModel.create({
        tenantId,
        identityId,
        sourceName: 'csv-hr',
        reason: 'terminated',
        eventKey: `k-${identityId}`,
        status: 'started',
        open: false,
        detectedAt: new Date(),
        workflowId,
      });
      return { workflowId, identityId, eventId: String(event._id) };
    });
  }

  const failed = (system: string): OffboardingSystemResult => ({
    system,
    outcome: 'failed',
    reason: `${system}: remove it by hand`,
  });

  const failedAdmin: OffboardingLinkedAdminResult = {
    identityId: '6740a0000000000000000001',
    workflowId: `t-${A}-offboard-6740a0000000000000000001`,
    outcome: 'failed',
    reason: 'Offboarding partial failure for 6740a0000000000000000001: 1 target(s) failed',
  };

  const stored = (workflowId: string) =>
    withTenantContext(A, () => recordModel.findOne({ workflowId }).lean().exec());

  it('records the admin and note on the target and leaves the Golden Record suspended while another target is failed', async () => {
    const { workflowId, identityId, eventId } = await offboarded(A, [
      { system: 'okta', outcome: 'deprovisioned', detail: 'deactivated' },
      failed('github'),
      failed('servicenow'),
    ]);

    const item = await withTenantContext(A, () =>
      service.markRemoved(workflowId, 'github', ADMIN, 'Removed from the org on 2026-11-22'),
    );

    const github = item.offboarding.systems.find((s) => s.system === 'github');
    expect(github).toMatchObject({
      outcome: 'removed-manually',
      reason: 'github: remove it by hand',
      manualRemoval: { by: ADMIN, reason: 'Removed from the org on 2026-11-22' },
    });
    expect(Date.parse(github!.manualRemoval!.at)).not.toBeNaN();
    expect(item.offboarding).toMatchObject({ status: 'partial-failure', hubStatus: 'suspended' });
    expect(item.leaver).toMatchObject({ leaverEventId: eventId, reason: 'terminated' });
    expect(events.emitAndWait).toHaveBeenCalledWith(
      DomainEventType.IDENTITY_OFFBOARDING_TARGET_REMOVED_MANUALLY,
      identityId,
      {
        identityId,
        leaverEventId: eventId,
        workflowId,
        system: 'github',
        reason: 'Removed from the org on 2026-11-22',
        offboardingComplete: false,
      },
      { tenantId: A, actor: ADMIN },
    );
  });

  it('completes the offboarding when the last failed target is closed', async () => {
    const { workflowId } = await offboarded(A, [failed('github'), failed('servicenow')]);
    await withTenantContext(A, () => service.markRemoved(workflowId, 'github', ADMIN, 'gone'));
    events.emitAndWait.mockResolvedValue(['deleted']);

    const item = await withTenantContext(A, () =>
      service.markRemoved(workflowId, 'servicenow', ADMIN, 'deactivated by the ServiceNow team'),
    );

    expect(events.emitAndWait.mock.calls[1][2]).toMatchObject({
      system: 'servicenow',
      offboardingComplete: true,
    });
    expect(item.offboarding).toMatchObject({ status: 'completed', hubStatus: 'deleted' });
    expect(item.offboarding.systems.map((s) => s.outcome)).toEqual([
      'removed-manually',
      'removed-manually',
    ]);
  });

  it('keeps the Golden Record suspended when the last failed target is closed while a linked admin account failed', async () => {
    const { workflowId } = await offboarded(A, [failed('github')], {
      linkedAdmins: [failedAdmin],
    });

    const item = await withTenantContext(A, () =>
      service.markRemoved(workflowId, 'github', ADMIN, 'Removed from the org'),
    );

    // The admin account may still exist: no deletion is asked for, the record stays incomplete
    expect(events.emitAndWait.mock.calls[0][2]).toMatchObject({
      system: 'github',
      offboardingComplete: false,
    });
    expect(item.offboarding).toMatchObject({
      status: 'partial-failure',
      hubStatus: 'suspended',
      linkedAdmins: [failedAdmin],
    });
  });

  it('refuses to close the last failed target while a linked admin identity of the person is live', async () => {
    const { workflowId, identityId } = await offboarded(A, [failed('github')]);
    // One admin account still live (its offboarding runs elsewhere), one already offboarded
    const [live, gone] = await withTenantContext(A, () =>
      identityModel.create([
        {
          tenantId: A,
          parentIdentityId: identityId,
          profile: { firstName: 'adm', lastName: 'Test', email: 'adm-ada@corp.example' },
        },
        {
          tenantId: A,
          parentIdentityId: identityId,
          deletedAt: new Date(),
          profile: { firstName: 'adm2', lastName: 'Test', email: 'adm2-ada@corp.example' },
        },
      ]),
    );

    const error = await withTenantContext(A, () =>
      service
        .markRemoved(workflowId, 'github', ADMIN, 'Removed from the org')
        .catch((e: unknown) => e),
    );

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toContain(`linked admin identity ${String(live._id)}`);
    expect((error as Error).message).not.toContain(String(gone._id));
    // Nothing changed: the target stays failed, the identity is not asked to delete anything
    expect(events.emitAndWait).not.toHaveBeenCalled();
    const record = await stored(workflowId);
    expect(record?.systems).toEqual([failed('github')]);
    expect(record).toMatchObject({ status: 'partial-failure', hubStatus: 'suspended' });
  });

  it('closes a failed target of an offboarding started by deleting the user (no leaver event)', async () => {
    const { workflowId, identityId } = await offboarded(A, [failed('github')], { leaver: false });
    events.emitAndWait.mockResolvedValue(['deleted']);

    const item = await withTenantContext(A, () =>
      service.markRemoved(workflowId, 'github', ADMIN, 'Removed from the org'),
    );

    expect(item).toMatchObject({ workflowId, identityId, displayName: 'ada Test' });
    expect(item.leaver).toBeUndefined();
    expect(item.offboarding).toMatchObject({ status: 'completed', hubStatus: 'deleted' });
    const payload = events.emitAndWait.mock.calls[0][2] as Record<string, unknown>;
    expect(payload).toEqual({
      identityId,
      workflowId,
      system: 'github',
      reason: 'Removed from the org',
      offboardingComplete: true,
    });
  });

  it('closes a target only while it is failed, and only once', async () => {
    const { workflowId } = await offboarded(A, [
      { system: 'okta', outcome: 'deprovisioned', detail: 'deactivated' },
      failed('github'),
    ]);

    await expect(
      withTenantContext(A, () => service.markRemoved(workflowId, 'okta', ADMIN, 'x')),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      withTenantContext(A, () => service.markRemoved(workflowId, 'scim', ADMIN, 'x')),
    ).rejects.toBeInstanceOf(ConflictException);

    const first = withTenantContext(A, () => service.markRemoved(workflowId, 'github', ADMIN, 'a'));
    const second = withTenantContext(A, () =>
      service.markRemoved(workflowId, 'github', ADMIN, 'b'),
    );
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: expect.any(ConflictException),
    });
    expect(events.emitAndWait).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for another tenant's offboarding or an unknown workflow id", async () => {
    const { workflowId } = await offboarded(B, [failed('github')]);
    await expect(
      withTenantContext(A, () => service.markRemoved(workflowId, 'github', ADMIN, 'x')),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      withTenantContext(A, () =>
        service.markRemoved('t-tenant-a-offboard-x', 'github', ADMIN, 'x'),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    const untouched = await withTenantContext(B, () =>
      recordModel.findOne({ workflowId }).lean().exec(),
    );
    expect(untouched?.systems[0].outcome).toBe('failed');
  });

  it('reopens the target when the identity could not be updated', async () => {
    const { workflowId } = await offboarded(A, [failed('github')]);
    events.emitAndWait.mockRejectedValue(new Error('identity store down'));

    await expect(
      withTenantContext(A, () => service.markRemoved(workflowId, 'github', ADMIN, 'x')),
    ).rejects.toThrow('identity store down');

    const after = await stored(workflowId);
    expect(after?.systems[0]).toEqual(failed('github'));
    expect(after).toMatchObject({ status: 'partial-failure', hubStatus: 'suspended' });
  });

  it("lists only this tenant's offboardings that still have a failed target, leaver or not", async () => {
    const leaver = await offboarded(A, [failed('github')], { name: 'ada' });
    const deleted = await offboarded(A, [failed('okta')], { name: 'dee', leaver: false });
    await offboarded(A, [{ system: 'okta', outcome: 'deprovisioned' }], { name: 'bo' });
    await offboarded(B, [failed('github')], { name: 'cy' });

    const items = await withTenantContext(A, () => service.listOpen());

    expect(items.map((i) => i.workflowId).sort()).toEqual(
      [leaver.workflowId, deleted.workflowId].sort(),
    );
    expect(items.find((i) => i.workflowId === leaver.workflowId)).toMatchObject({
      displayName: 'ada Test',
      email: 'ada@corp.example',
      leaver: { leaverEventId: leaver.eventId, sourceName: 'csv-hr', reason: 'terminated' },
    });
    const manual = items.find((i) => i.workflowId === deleted.workflowId);
    expect(manual).toMatchObject({ displayName: 'dee Test', identityId: deleted.identityId });
    expect(manual?.leaver).toBeUndefined();
  });

  it('lists an offboarding whose only failure is a linked admin account, with the account', async () => {
    const person = await offboarded(A, [{ system: 'okta', outcome: 'deprovisioned' }], {
      linkedAdmins: [failedAdmin],
    });
    await offboarded(A, [{ system: 'okta', outcome: 'deprovisioned' }], {
      name: 'bo',
      linkedAdmins: [{ ...failedAdmin, outcome: 'offboarded', reason: undefined }],
    });

    const items = await withTenantContext(A, () => service.listOpen());

    expect(items.map((i) => i.workflowId)).toEqual([person.workflowId]);
    expect(items[0].offboarding).toMatchObject({
      status: 'partial-failure',
      hubStatus: 'suspended',
      linkedAdmins: [failedAdmin],
    });
  });
});
