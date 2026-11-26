/**
 * Offboarding a person also offboards their linked admin accounts (PAM), end to end on the
 * time-skipping Temporal test server and in-memory MongoDB. Opt-in via TEMPORAL_E2E=1.
 *
 * The real offboardingWorkflow runs with the real identity, PAM and offboarding activities and
 * services, the Leavers record handler and the manual-removal service; the Entra ID activity runs
 * on its own queue with Microsoft Graph's delete mocked. Admin identities are created by
 * PrivilegedAccessService as the PAM flow does, provisioned to Entra ID with the object id admin
 * provisioning writes back.
 *
 * Proves (patch offboarding:linked-admin-cascade):
 *   - Each live linked admin identity is offboarded first by a child offboardingWorkflow under
 *     `t-<tenant>-offboard-<adminId>` (the TenantId search attribute inherited), one after
 *     another, then the person's own targets; all three Golden Records end deleted and the
 *     result lists the admin accounts. A deleted admin identity is left alone. An admin account
 *     deactivated through PAM keeps its provisioning and is removed; so is one whose entries a
 *     PAM deactivation marked DEPROVISIONED.
 *   - An admin account whose offboarding fails leaves the person suspended (not deleted) with a
 *     partial failure naming the admin identity; the person's own targets are still removed.
 *   - An admin identity whose offboarding already runs is recorded as running elsewhere and is
 *     not waited for, but a person is never deleted while one of their admin identities is
 *     still live: read again right before the delete, it leaves the person suspended with a
 *     partial failure naming it, and a rerun after its offboarding finished deletes the person.
 *     One whose offboarding finished before that check does not hold the person.
 *   - A history recorded before the patch (a person with a linked admin account, left alone)
 *     still replays.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { Worker } from '@temporalio/worker';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure, WorkflowNotFoundError } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { closeTestDb, testDbUri } from '@testing/test-db';
import { tenantPlugin } from '../../src/infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '../../src/infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '../../src/infrastructure/events/event-emitter.service';
import { OutboxEvent } from '../../src/infrastructure/events/schemas/outbox-event.schema';
import { OffboardingManualRemovalHandler } from '../../src/infrastructure/events/handlers/offboarding-manual-removal.handler';
import { DeadLetterService } from '../../src/modules/dead-letter/dead-letter.service';
import { LoggerFactoryService } from '../../src/infrastructure/observability/contextual-logger.service';
import { CorrelationHashService } from '../../src/infrastructure/services/correlation-hash.service';
import { getTenantWorkflow } from '../../src/infrastructure/temporal/tenant-workflow';
import type { PamConfig } from '../../src/infrastructure/config/pam.config';
import {
  DEFAULT_PROVISIONING_QUEUE,
  QUEUE_NAMES,
} from '../../src/infrastructure/temporal/task-queue.config';
import { offboardingWorkflow } from '../../src/workflows/offboarding.workflow';
import { IdentityActivities } from '../../src/activities/identity.activities';
import { OffboardingActivities } from '../../src/activities/offboarding.activities';
import { PrivilegedAccessActivities } from '../../src/activities/privileged-access.activities';
import { EntraActivities } from '../../src/activities/entra.activities';
import type { EntraService } from '../../src/modules/connectors/entra-connector/entra.service';
import { PrivilegedAccessService } from '../../src/modules/privileged-access/privileged-access.service';
import { PrivilegedSessionService } from '../../src/modules/privileged-access/privileged-session.service';
import { PamSessionStateService } from '../../src/modules/privileged-access/pam-session-state.service';
import { asPamSessionService, inlinePamSessions } from '../../src/testing/inline-pam-sessions';
import { IdentityService } from '../../src/modules/identity/identity.service';
import { IdentityQueryService } from '../../src/modules/identity/identity-query.service';
import { IdentityMutationService } from '../../src/modules/identity/identity-mutation.service';
import { IdentityCorrelationService } from '../../src/modules/identity/identity-correlation.service';
import { IdentityUncorrelatedService } from '../../src/modules/identity/identity-uncorrelated.service';
import { IdentityProvisioningService } from '../../src/modules/identity/identity-provisioning.service';
import { IdentityOnionService } from '../../src/modules/identity/identity-onion.service';
import { IdentityControlsService } from '../../src/modules/identity/identity-controls.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { IdentityDeletedMatchService } from '../../src/modules/identity/identity-deleted-match.service';
import { ReconciliationService } from '../../src/modules/identity/reconciliation.service';
import { ReconciliationConfigService } from '../../src/modules/identity/reconciliation-config.service';
import { CorrelationConfigService } from '../../src/modules/correlation-config/correlation-config.service';
import { CorrelationRuleEngine } from '../../src/modules/identity/correlation/correlation-rule.engine';
import { UserEventService } from '../../src/modules/identity/user-event.service';
import {
  Identity,
  IdentitySchema,
  IdentityDocument,
} from '../../src/modules/identity/schemas/identity.schema';
import { UserEvent, UserEventSchema } from '../../src/modules/identity/schemas/user-event.schema';
import {
  LeaverEvent,
  LeaverEventSchema,
} from '../../src/modules/leavers/schemas/leaver-event.schema';
import { LeaverOffboardingResultHandler } from '../../src/modules/leavers/leaver-offboarding-result.handler';
import { LeaverManualRemovalService } from '../../src/modules/leavers/leaver-manual-removal.service';
import {
  OffboardingRecord,
  OffboardingRecordSchema,
  OffboardingRecordDocument,
} from '../../src/modules/leavers/schemas/offboarding-record.schema';
import { historyJSON } from '../helpers/history-json';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';

mongoose.plugin(tenantPlugin);

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/offboarding.workflow.ts');
/**
 * Recorded with the workflow before offboarding:linked-admin-cascade (offboarding.workflow.ts as
 * of 0b4ca735, last changed in 8bb6d8b9): a person with a linked admin account offboarded, the
 * admin account left alone.
 */
const PRE_CASCADE_FIXTURE = path.resolve(
  __dirname,
  '../fixtures/offboarding-pre-linked-admin-cascade.history.json',
);
const TENANT = 'tenant-a';
const ENTRA_CONFIG = { tenantId: 'entra-tenant', clientId: 'c', clientSecret: 's' };
const PAM_CONFIG = {
  tier0MaxHours: 8,
  tier1MaxHours: 24,
  tier2MaxHours: 72,
  adminUpnPattern: 'adm-{firstName}.{lastName}@{domain}',
  adminUpnMaxSuffix: 20,
  activationWaitMs: 2000,
  standingStateSweepLimit: 50,
} as unknown as PamConfig;
const SUPER_ADMIN = ['super-admin'];
/** Graph refuses deleting this object (403): the admin account's offboarding fails. */
const REFUSED_OBJECT = 'adm-refused-obj';

const graphDelete = jest.fn(async (id: string) => {
  if (id === REFUSED_OBJECT) {
    throw Object.assign(new Error('Insufficient privileges to complete the operation'), {
      response: { status: 403 },
    });
  }
  return true;
});

const workflowIdOf = (identityId: string) => `t-${TENANT}-offboard-${identityId}`;

describeTemporalE2E('offboarding: linked admin accounts first (e2e)', () => {
  let harness: WorkflowTestHarness;
  let moduleRef: TestingModule;
  let identityModel: Model<IdentityDocument>;
  let pam: PrivilegedAccessService;
  let workerOptions: Omit<WorkflowTestHarnessOptions, 'workflowsPath'>;
  /**
   * Linked admin lookups that wait until released: the `call`-th lookup of `identityId` (the
   * cascade's is the first of a run, the check before the delete the second).
   */
  let holds: Array<{
    identityId: string;
    call: number;
    reached: () => void;
    release: Promise<void>;
    releaseNow: () => void;
  }> = [];
  const lookups = new Map<string, number>();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        EventEmitterModule.forRoot({ wildcard: true, delimiter: '.', ignoreErrors: false }),
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: UserEvent.name, schema: UserEventSchema },
          { name: LeaverEvent.name, schema: LeaverEventSchema },
          { name: OffboardingRecord.name, schema: OffboardingRecordSchema },
        ]),
      ],
      providers: [
        IdentityService,
        IdentityQueryService,
        IdentityMutationService,
        IdentityCorrelationService,
        IdentityUncorrelatedService,
        IdentityProvisioningService,
        IdentityOnionService,
        IdentityControlsService,
        { provide: AuditService, useValue: { log: jest.fn(), logFireAndForget: jest.fn() } },
        { provide: IdentityDeletedMatchService, useValue: {} },
        ReconciliationService,
        UserEventService,
        {
          provide: ReconciliationConfigService,
          useValue: { getConfig: async () => null, getHrSourceTags: async () => [] },
        },
        // Read when an incomplete offboarding suspends the identity (updateControls reconciles)
        {
          provide: CorrelationConfigService,
          useValue: {
            getCorrelationConfig: async () => ({ rules: [{ strategy: 'email' }] }),
            getPrimaryHrSourceName: async () => null,
            getHrConnectorsWithPriorityFromBlueprint: async () => [],
            getInstalledHrConnectorsWithPriority: async () => [],
          },
        },
        { provide: CorrelationRuleEngine, useValue: {} },
        { provide: CorrelationHashService, useValue: { hash: () => 'h' } },
        {
          provide: LoggerFactoryService,
          useValue: {
            create: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
          },
        },
        DomainEventEmitterService,
        { provide: DeadLetterService, useValue: { capture: jest.fn() } },
        { provide: getModelToken(OutboxEvent.name), useValue: {} },
        LeaverOffboardingResultHandler,
        OffboardingManualRemovalHandler,
        LeaverManualRemovalService,
        IdentityActivities,
        OffboardingActivities,
      ],
    })
      .useMocker(() => ({}))
      .compile();
    await moduleRef.init();
    identityModel = moduleRef.get(getModelToken(Identity.name));

    const emitter = moduleRef.get(DomainEventEmitterService);
    // Privileged sessions run inline (their workflow has a suite of its own)
    const logger = moduleRef.get(LoggerFactoryService);
    const sessionState = new PamSessionStateService(identityModel, emitter, logger);
    const sessions = asPamSessionService(inlinePamSessions(sessionState));
    pam = new PrivilegedAccessService(
      identityModel,
      moduleRef.get(IdentityService),
      emitter,
      logger,
      PAM_CONFIG,
      new PrivilegedSessionService(identityModel, sessions, logger, PAM_CONFIG, emitter),
    );
    const pamActivities = new PrivilegedAccessActivities(pam, sessionState, sessions);
    const entraActivities = new EntraActivities(
      { deleteUser: graphDelete } as unknown as EntraService,
      { emit: jest.fn() } as unknown as DomainEventEmitterService,
      {} as never,
      moduleRef.get(IdentityService),
    );
    const identity = moduleRef.get(IdentityActivities);
    const outcome = moduleRef.get(OffboardingActivities);
    const bind = <T extends object>(obj: T, name: keyof T) =>
      (obj[name] as (...args: unknown[]) => unknown).bind(obj);

    workerOptions = {
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      activities: {
        getConnectorConfig: async (id: unknown) => (id === 'entra-id' ? ENTRA_CONFIG : null),
        getProvisionedTargets: bind(identity, 'getProvisionedTargets'),
        getOffboardingTargets: bind(identity, 'getOffboardingTargets'),
        setProvisioningStatus: bind(identity, 'setProvisioningStatus'),
        markDeleted: bind(identity, 'markDeleted'),
        suspendIdentity: bind(identity, 'suspendIdentity'),
        recordOffboardingOutcome: bind(outcome, 'recordOffboardingOutcome'),
        getLinkedAdminIdentities: async (...args: unknown[]) => {
          const identityId = String(args[0]);
          const call = (lookups.get(identityId) ?? 0) + 1;
          lookups.set(identityId, call);
          const held = holds.find((h) => h.identityId === identityId && h.call === call);
          if (held) {
            held.reached();
            await held.release;
          }
          return pamActivities.getLinkedAdminIdentities(
            ...(args as Parameters<typeof pamActivities.getLinkedAdminIdentities>),
          );
        },
      },
      queueWorkers: [
        {
          taskQueue: QUEUE_NAMES['entra'],
          activities: { deleteUser: bind(entraActivities, 'deleteUser') },
        },
      ],
    };
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workerOptions });
    // A deployment registers TenantId (docker-compose / Temporal setup); the test server must too.
    await harness.env.connection.operatorService.addSearchAttributes({
      namespace: harness.env.namespace ?? 'default',
      searchAttributes: {
        TenantId: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
      },
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.shutdown();
    await moduleRef?.close();
    await closeTestDb();
  }, 60_000);

  beforeEach(() => {
    graphDelete.mockClear();
    holds = [];
    lookups.clear();
  });

  // A held activity that a failed assertion never released would keep the worker from stopping
  afterEach(() => holds.forEach((h) => h.releaseNow()));

  /** Hold the `call`-th linked admin lookup of `identityId`: resolves once it is reached. */
  const hold = (identityId: string, call: number) => {
    let release!: () => void;
    let reached!: () => void;
    const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    holds.push({ identityId, call, reached, release: released, releaseNow: () => release() });
    return { reached: reachedPromise, release: () => release() };
  };

  /** A person provisioned to Entra ID (SYNCED, with the object id written back). */
  const person = (email: string, objectId: string) =>
    withTenantContext(TENANT, async () => {
      const [firstName, lastName] = email.split('@')[0].split('.');
      const doc = await identityModel.create({
        tenantId: TENANT,
        profile: { firstName, lastName, email, status: 'ACTIVE' },
        sources: [{ sourceName: 'entra-id', externalId: objectId, sourceRole: 'target' }],
        provisioning: [{ targetSystem: 'entra', status: 'SYNCED', provisionedAt: new Date() }],
      });
      return String(doc._id);
    });

  /**
   * The person's linked admin account of `tier` as PrivilegedAccessService creates it, provisioned
   * to Entra ID as admin provisioning leaves it (SYNCED, object id written back). Its UPN gets the
   * tier in front: the UPN pattern has no tier, so a second tier would collide.
   */
  const adminAccount = (parentId: string, tier: string, objectId: string) =>
    withTenantContext(TENANT, async () => {
      const admin = await pam.createLinkedAdminIdentity(parentId, tier, TENANT);
      const email = `${tier.toLowerCase()}.${admin.profile.email}`;
      await identityModel
        .updateOne(
          { _id: admin._id },
          {
            $set: {
              'profile.email': email,
              'profile.userPrincipalName': email,
              'profile.status': 'ACTIVE',
              sources: [{ sourceName: 'entra-id', externalId: objectId, sourceRole: 'target' }],
              provisioning: [
                { targetSystem: 'entra', status: 'SYNCED', provisionedAt: new Date() },
              ],
            },
          },
        )
        .exec();
      return { id: String(admin._id), email };
    });

  /** Started as OffboardingService starts it: TenantId search attribute and memo. */
  const startOptions = (identityId: string) => ({
    taskQueue: DEFAULT_PROVISIONING_QUEUE,
    workflowId: workflowIdOf(identityId),
    searchAttributes: { TenantId: [TENANT] },
    memo: {
      triggeredBy: 'OffboardingService',
      targetDescription: `Offboarding: identity ${identityId}`,
    },
  });

  const offboard = (identityId: string, email: string) =>
    harness.env.client.workflow.execute(offboardingWorkflow, {
      args: [{ userId: identityId, userEmail: email, tenantId: TENANT }],
      ...startOptions(identityId),
    });

  const stored = (identityId: string) =>
    withTenantContext(TENANT, () => identityModel.findById(identityId).lean().exec());

  const offboardingRecord = (identityId: string) =>
    withTenantContext(TENANT, () =>
      moduleRef
        .get<Model<OffboardingRecordDocument>>(getModelToken(OffboardingRecord.name))
        .findOne({ workflowId: workflowIdOf(identityId) })
        .lean()
        .exec(),
    );

  /**
   * The result event's handlers run after the emit returns: probe the record until their write
   * is there (each read is a database round trip, no timer).
   */
  async function eventually<T>(
    read: () => T | Promise<T>,
    done: (value: T) => boolean,
  ): Promise<T> {
    let value = await read();
    for (let attempt = 0; attempt < 500 && !done(value); attempt++) value = await read();
    return value;
  }

  const deletedObjects = () => graphDelete.mock.calls.map(([id]) => id);

  it("offboards each live linked admin account in turn, then the person's own targets", async () => {
    const parentId = await person('eero.virtanen@corp.example', 'person-obj');
    // TIER_0: activated and deactivated through PAM, which keeps its provisioning entries
    const tier0 = await adminAccount(parentId, 'TIER_0', 'adm0-obj');
    await withTenantContext(TENANT, async () => {
      await pam.activateAdminAccount(tier0.id, undefined, SUPER_ADMIN);
      await pam.deactivateAdminAccount(tier0.id, undefined, SUPER_ADMIN);
    });
    // TIER_1: active, its entry marked DEPROVISIONED as a PAM deactivation would have left it
    const tier1 = await adminAccount(parentId, 'TIER_1', 'adm1-obj');
    await withTenantContext(TENANT, async () => {
      await pam.activateAdminAccount(tier1.id, undefined, SUPER_ADMIN);
      await identityModel
        .updateOne({ _id: tier1.id }, { $set: { 'provisioning.0.status': 'DEPROVISIONED' } })
        .exec();
    });
    // TIER_2: offboarded before, left alone
    const tier2 = await adminAccount(parentId, 'TIER_2', 'adm2-obj');
    await withTenantContext(TENANT, () =>
      identityModel.updateOne({ _id: tier2.id }, { $set: { deletedAt: new Date() } }).exec(),
    );
    expect((await stored(tier0.id))!.provisioning[0].status).toBe('SYNCED');

    const result = await offboard(parentId, 'eero.virtanen@corp.example');

    // Privileged accounts first, one after another, then the person's own account
    expect(deletedObjects()).toEqual(['adm0-obj', 'adm1-obj', 'person-obj']);
    expect(result).toEqual({
      identityId: parentId,
      workflowId: workflowIdOf(parentId),
      status: 'completed',
      hubStatus: 'deleted',
      systems: [{ system: 'entra', outcome: 'deprovisioned', detail: 'deleted' }],
      linkedAdmins: [
        { identityId: tier0.id, workflowId: workflowIdOf(tier0.id), outcome: 'offboarded' },
        { identityId: tier1.id, workflowId: workflowIdOf(tier1.id), outcome: 'offboarded' },
      ],
    });
    for (const id of [parentId, tier0.id, tier1.id]) {
      const doc = await stored(id);
      expect(doc?.deletedAt).toBeInstanceOf(Date);
      expect(doc?.provisioning[0].status).toBe('DEPROVISIONED');
    }
    // No entry of the person counts as an active admin account any more
    const entries = (await stored(parentId))!.linkedAdminAccounts!;
    expect(entries.map((e) => [e.identityId, e.status])).toEqual([
      [tier0.id, 'INACTIVE'],
      [tier1.id, 'INACTIVE'],
      [tier2.id, 'PENDING'],
    ]);

    // Each child: the service's id convention, readable by the tenant, a memo of its own
    for (const admin of [tier0, tier1]) {
      const { description } = await getTenantWorkflow(
        harness.env.client,
        workflowIdOf(admin.id),
        TENANT,
      );
      expect(description.status.name).toBe('COMPLETED');
      expect(description.memo?.targetDescription).toBe(
        `Offboarding: identity ${admin.id} (linked admin account of identity ${parentId})`,
      );
    }
    await expect(
      harness.env.client.workflow.getHandle(workflowIdOf(tier2.id)).describe(),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);

    const record = await eventually(
      () => offboardingRecord(parentId),
      (r) => Boolean(r),
    );
    expect(record).toMatchObject({
      status: 'completed',
      linkedAdmins: result && typeof result === 'object' ? result.linkedAdmins : [],
    });
  }, 120_000);

  it('leaves the person suspended with a partial failure naming the admin account whose offboarding failed', async () => {
    const parentId = await person('aino.lahti@corp.example', 'person2-obj');
    const admin = await adminAccount(parentId, 'TIER_1', REFUSED_OBJECT);

    const error = await offboard(parentId, 'aino.lahti@corp.example').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkflowFailedError);
    const failure = (error as WorkflowFailedError).cause as ApplicationFailure;
    expect(failure.type).toBe('OffboardingPartialFailure');
    expect(failure.message).toContain(
      `1 linked admin account(s) failed (linked admin identity ${admin.id}:`,
    );
    expect(failure.details?.[0]).toEqual({
      identityId: parentId,
      workflowId: workflowIdOf(parentId),
      status: 'partial-failure',
      hubStatus: 'suspended',
      // The person's own account is still removed
      systems: [{ system: 'entra', outcome: 'deprovisioned', detail: 'deleted' }],
      linkedAdmins: [
        {
          identityId: admin.id,
          workflowId: workflowIdOf(admin.id),
          outcome: 'failed',
          reason: expect.stringContaining('Insufficient privileges'),
        },
      ],
    });
    expect(deletedObjects()).toEqual([REFUSED_OBJECT, 'person2-obj']);

    const parent = await stored(parentId);
    expect(parent?.deletedAt).toBeFalsy();
    expect(parent?.controls?.isLoginDisabled).toBe(true);
    const adminDoc = await stored(admin.id);
    expect(adminDoc?.deletedAt).toBeFalsy();
    expect(adminDoc?.controls?.isLoginDisabled).toBe(true);

    // Both offboardings are on the Failed offboardings list: the admin account's own (its failed
    // target can be closed there) and the person's (its linked admin account failed)
    await eventually(
      () => offboardingRecord(parentId),
      (r) => Boolean(r),
    );
    await eventually(
      () => offboardingRecord(admin.id),
      (r) => Boolean(r),
    );
    const open = await withTenantContext(TENANT, () =>
      moduleRef.get(LeaverManualRemovalService).listOpen(),
    );
    expect(open.map((i) => i.workflowId)).toEqual(
      expect.arrayContaining([workflowIdOf(parentId), workflowIdOf(admin.id)]),
    );
    expect(open.find((i) => i.workflowId === workflowIdOf(parentId))?.offboarding).toMatchObject({
      linkedAdmins: [{ identityId: admin.id, outcome: 'failed' }],
    });
  }, 120_000);

  it('does not wait for an admin account whose offboarding already runs, and keeps the person suspended while it is live', async () => {
    const parentId = await person('ville.niemi@corp.example', 'person3-obj');
    const admin = await adminAccount(parentId, 'TIER_0', 'adm3-obj');
    // The admin account's own offboarding (another trigger), held at its first activity
    const adminRun = hold(admin.id, 1);
    const running = await harness.env.client.workflow.start(offboardingWorkflow, {
      args: [{ userId: admin.id, userEmail: admin.email, tenantId: TENANT }],
      ...startOptions(admin.id),
    });
    await adminRun.reached;

    const error = await offboard(parentId, 'ville.niemi@corp.example').catch((e: unknown) => e);

    // Not waited for, but still live when the person would have been deleted
    expect(error).toBeInstanceOf(WorkflowFailedError);
    const failure = (error as WorkflowFailedError).cause as ApplicationFailure;
    expect(failure.type).toBe('OffboardingPartialFailure');
    expect(failure.message).toContain(`linked admin identity ${admin.id}: its offboarding`);
    expect(failure.details?.[0]).toEqual({
      identityId: parentId,
      workflowId: workflowIdOf(parentId),
      status: 'partial-failure',
      hubStatus: 'suspended',
      systems: [{ system: 'entra', outcome: 'deprovisioned', detail: 'deleted' }],
      linkedAdmins: [
        {
          identityId: admin.id,
          workflowId: workflowIdOf(admin.id),
          outcome: 'failed',
          reason:
            `its offboarding (${workflowIdOf(admin.id)}) had not finished when the person's ` +
            "offboarding ended: rerun the person's offboarding once it has finished",
        },
      ],
    });
    expect(deletedObjects()).toEqual(['person3-obj']);
    const parent = await stored(parentId);
    expect(parent?.deletedAt).toBeFalsy();
    expect(parent?.controls?.isLoginDisabled).toBe(true);
    // On the Failed offboardings list, so someone reruns it
    await eventually(
      () => offboardingRecord(parentId),
      (r) => Boolean(r),
    );
    const open = await withTenantContext(TENANT, () =>
      moduleRef.get(LeaverManualRemovalService).listOpen(),
    );
    expect(open.map((i) => i.workflowId)).toContain(workflowIdOf(parentId));

    // That run owns the admin account's outcome
    adminRun.release();
    await expect(running.result()).resolves.toMatchObject({ status: 'completed' });
    expect(deletedObjects()).toEqual(['person3-obj', 'adm3-obj']);
    expect((await stored(admin.id))?.deletedAt).toBeInstanceOf(Date);

    // Rerun once it has finished: no admin account is live, the person is deleted
    await expect(offboard(parentId, 'ville.niemi@corp.example')).resolves.toEqual({
      identityId: parentId,
      workflowId: workflowIdOf(parentId),
      status: 'completed',
      hubStatus: 'deleted',
      systems: [],
    });
    expect((await stored(parentId))?.deletedAt).toBeInstanceOf(Date);
  }, 120_000);

  it('deletes the person when the admin account offboarding elsewhere finished before the check', async () => {
    const parentId = await person('saara.koski@corp.example', 'person4-obj');
    const admin = await adminAccount(parentId, 'TIER_1', 'adm4-obj');
    const adminRun = hold(admin.id, 1);
    // The person's check right before the delete, after the cascade found it running elsewhere
    const check = hold(parentId, 2);
    const running = await harness.env.client.workflow.start(offboardingWorkflow, {
      args: [{ userId: admin.id, userEmail: admin.email, tenantId: TENANT }],
      ...startOptions(admin.id),
    });
    await adminRun.reached;
    const personRun = await harness.env.client.workflow.start(offboardingWorkflow, {
      args: [{ userId: parentId, userEmail: 'saara.koski@corp.example', tenantId: TENANT }],
      ...startOptions(parentId),
    });
    await check.reached;

    // The admin account's offboarding finishes between the cascade and the check
    adminRun.release();
    await expect(running.result()).resolves.toMatchObject({ status: 'completed' });
    check.release();

    await expect(personRun.result()).resolves.toEqual({
      identityId: parentId,
      workflowId: workflowIdOf(parentId),
      status: 'completed',
      hubStatus: 'deleted',
      systems: [{ system: 'entra', outcome: 'deprovisioned', detail: 'deleted' }],
      linkedAdmins: [
        {
          identityId: admin.id,
          workflowId: workflowIdOf(admin.id),
          outcome: 'running-elsewhere',
          reason: expect.stringContaining('already running'),
        },
      ],
    });
    expect(deletedObjects()).toEqual(['person4-obj', 'adm4-obj']);
    expect((await stored(parentId))?.deletedAt).toBeInstanceOf(Date);
  }, 120_000);

  it('replays a history recorded before the linked-admin-cascade patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_CASCADE_FIXTURE, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.LINKED_ADMIN_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (LINKED_ADMIN_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workerOptions,
      });
      try {
        const parentId = await person('kalle.koski@corp.example', 'person-pre-obj');
        await adminAccount(parentId, 'TIER_1', 'adm-pre-obj');
        const handle = await pre.env.client.workflow.start(offboardingWorkflow, {
          args: [{ userId: parentId, userEmail: 'kalle.koski@corp.example', tenantId: TENANT }],
          taskQueue: DEFAULT_PROVISIONING_QUEUE,
          workflowId: workflowIdOf(parentId),
        });
        await handle.result();
        // The pre-patch code leaves the admin account alone
        expect(deletedObjects()).toEqual(['person-pre-obj']);
        fs.writeFileSync(PRE_CASCADE_FIXTURE, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
