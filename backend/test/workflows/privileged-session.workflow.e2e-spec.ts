/**
 * Privileged sessions (PAM just-in-time access) end to end on the time-skipping Temporal test
 * server and in-memory MongoDB. Opt-in via TEMPORAL_E2E=1.
 *
 * privilegedSessionWorkflow runs with the real session activities (PrivilegedAccessActivities over
 * PamSessionStateService: the admin identity's accounts and the session state in MongoDB) and
 * mocked connector activities on their queues (Entra ID enableEntraUser / disableEntraUser, AD
 * setAdUserEnabled). PamSessionService starts and signals the runs as the API does.
 *
 * Proves:
 *   - Activation enables the admin's account in each target system, and the entry shows ACTIVE
 *     (with expiresAt) only after: while the accounts are being enabled it is ACTIVATING.
 *   - The durable timer disables them all when the session expires; a deactivate (signal) ends it
 *     early and disables them.
 *   - An enable failure in one system disables the others too, the entry turns INACTIVE with the
 *     reason, and nothing is recorded ACTIVE.
 *   - A deleted admin identity is never enabled; offboarding's signal during the activation stops
 *     the enabling and disables what was enabled.
 *   - deactivate without a running session starts a disable-only run (signal-with-start), and a
 *     second activation while a session runs is refused (409).
 */
import mongoose, { Model } from 'mongoose';
import { ConflictException } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import * as path from 'path';
import { connectTestDb, clearTestDb, closeTestDb } from '../../src/testing/test-db';
import { createMockLoggerFactory } from '../../src/testing/test-helpers';
import { tenantPlugin } from '../../src/infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '../../src/infrastructure/multi-tenancy/tenant-context.helper';
import type { DomainEventEmitterService } from '../../src/infrastructure/events/event-emitter.service';
import type { LoggerFactoryService } from '../../src/infrastructure/observability/contextual-logger.service';
import type { TemporalClientProvider } from '../../src/infrastructure/temporal/temporal-client.provider';
import {
  DEFAULT_PROVISIONING_QUEUE,
  QUEUE_NAMES,
} from '../../src/infrastructure/temporal/task-queue.config';
import {
  Identity,
  IdentitySchema,
  type IdentityDocument,
} from '../../src/modules/identity/schemas/identity.schema';
import { PamSessionStateService } from '../../src/modules/privileged-access/pam-session-state.service';
import { PamSessionService } from '../../src/modules/privileged-access/pam-session.service';
import type { PrivilegedAccessService } from '../../src/modules/privileged-access/privileged-access.service';
import { PrivilegedAccessActivities } from '../../src/activities/privileged-access.activities';
import {
  endPrivilegedSessionSignal,
  privilegedSessionWorkflow,
} from '../../src/workflows/privileged-session.workflow';
import { privilegedSessionWorkflowId } from '../../src/workflows/privileged-session-id';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';

mongoose.plugin(tenantPlugin);

const WORKFLOWS_PATH = path.resolve(
  __dirname,
  '../../src/workflows/privileged-session.workflow.ts',
);
const TENANT = 'tenant-a';
const HOUR = 60 * 60 * 1000;
const ENTRA_CONFIG = { tenantId: 'entra-tenant', clientId: 'c', clientSecret: 's' };
const AD_CONFIG = { host: 'dc.corp.example', rootBaseDn: 'DC=corp,DC=example' };
const AD_DN = 'CN=adm-eero,OU=Admins,DC=corp,DC=example';

/** A promise and the function that settles it: the test waits for an activity, not for time. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describeTemporalE2E('privilegedSessionWorkflow (e2e)', () => {
  let harness: WorkflowTestHarness;
  let identityModel: Model<IdentityDocument>;
  let pam: PamSessionService;
  const emitted = jest.fn();
  const enableEntraUser = jest.fn();
  const disableEntraUser = jest.fn();
  const setAdUserEnabled = jest.fn();
  /** Calls to the targets in order: [system, enabled]. */
  let calls: Array<[string, boolean]>;
  /** The entry's status each time an account was enabled. */
  let statusWhileEnabling: string[];
  let activated: ReturnType<typeof deferred>;
  let enabling: ReturnType<typeof deferred>;

  const stored = (id: unknown) =>
    withTenantContext(TENANT, () => identityModel.findById(id).lean().exec());

  const entryStatus = async (adminId: string) => {
    const admin = await stored(adminId);
    const parent = await stored(admin!.parentIdentityId);
    return parent!.linkedAdminAccounts!.find((la) => la.identityId === adminId)!;
  };

  beforeAll(async () => {
    await connectTestDb();
    identityModel = (mongoose.models[Identity.name] ??
      mongoose.model(Identity.name, IdentitySchema)) as unknown as Model<IdentityDocument>;
    const logger = createMockLoggerFactory().factory as unknown as LoggerFactoryService;
    const state = new PamSessionStateService(
      identityModel,
      { emit: emitted } as unknown as DomainEventEmitterService,
      logger,
    );
    // The activities' PamSessionService (cascade signals) is not under test here
    const activities = new PrivilegedAccessActivities(
      {} as PrivilegedAccessService,
      state,
      {} as PamSessionService,
    );
    const bind = (name: keyof PrivilegedAccessActivities) =>
      (activities[name] as (...args: unknown[]) => unknown).bind(activities);

    harness = await createWorkflowTestHarness({
      workflowsPath: WORKFLOWS_PATH,
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      activities: {
        getConnectorConfig: async (id: unknown) =>
          id === 'entra-id' ? ENTRA_CONFIG : id === 'ad' ? AD_CONFIG : null,
        getPrivilegedSessionTargets: bind('getPrivilegedSessionTargets'),
        markPrivilegedSessionActivating: bind('markPrivilegedSessionActivating'),
        recordPrivilegedSessionActive: async (...args: unknown[]) => {
          const result = await bind('recordPrivilegedSessionActive')(...args);
          activated.resolve();
          return result;
        },
        recordPrivilegedSessionFailed: bind('recordPrivilegedSessionFailed'),
        recordPrivilegedSessionEnded: bind('recordPrivilegedSessionEnded'),
      },
      queueWorkers: [
        {
          taskQueue: QUEUE_NAMES['entra'],
          activities: {
            enableEntraUser: (...args: unknown[]) => enableEntraUser(...args),
            disableEntraUser: (...args: unknown[]) => disableEntraUser(...args),
          },
        },
        {
          taskQueue: QUEUE_NAMES['ad'],
          activities: { setAdUserEnabled: (...args: unknown[]) => setAdUserEnabled(...args) },
        },
      ],
    });
    await harness.env.connection.operatorService.addSearchAttributes({
      namespace: harness.env.namespace ?? 'default',
      searchAttributes: {
        TenantId: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
      },
    });
    pam = new PamSessionService({
      isConnected: () => true,
      getClient: () => harness.env.client,
    } as unknown as TemporalClientProvider);
  }, 180_000);

  afterAll(async () => {
    await harness?.shutdown();
    await closeTestDb();
  }, 60_000);

  beforeEach(() => {
    calls = [];
    statusWhileEnabling = [];
    activated = deferred();
    enabling = deferred();
    emitted.mockReset();
    const record = (system: string, enabled: boolean) => calls.push([system, enabled]);
    enableEntraUser.mockReset().mockImplementation(async (account: unknown) => {
      record('entra', true);
      statusWhileEnabling.push((await entryStatus(adminIdOf(account))).status);
      enabling.resolve();
      return true;
    });
    disableEntraUser.mockReset().mockImplementation(async () => {
      record('entra', false);
      return true;
    });
    setAdUserEnabled.mockReset().mockImplementation(async (_dn: unknown, enabled: unknown) => {
      record('ad', enabled === true);
      return { outcome: 'done' };
    });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  /** The Entra object id below names its admin identity: obj-<adminId>. */
  const adminIdOf = (account: unknown) => String(account).replace(/^obj-/, '');

  /** A live person's TIER_1 admin identity provisioned to Entra ID and AD, never activated. */
  async function adminAccount(extra: Record<string, unknown> = {}) {
    return withTenantContext(TENANT, async () => {
      const parent = await identityModel.create({
        tenantId: TENANT,
        profile: {
          firstName: 'Eero',
          lastName: 'Admin',
          email: 'eero@corp.example',
          status: 'ACTIVE',
        },
        sources: [],
      });
      const admin = new identityModel({
        tenantId: TENANT,
        profile: {
          firstName: 'Eero',
          lastName: 'Admin',
          email: 'adm-eero@corp.example',
          status: 'PENDING',
          employmentType: 'ADMIN_ACCOUNT',
          sourceSystem: 'euroid-pam',
        },
        parentIdentityId: String(parent._id),
        adminTier: 'TIER_1',
        provisioning: [
          { targetSystem: 'entra', status: 'SYNCED', provisionedAt: new Date() },
          { targetSystem: 'ad', status: 'SYNCED', provisionedAt: new Date() },
        ],
        ...extra,
      });
      admin.set('sources', [
        { sourceName: 'entra-id', externalId: `obj-${admin._id}`, sourceRole: 'target' },
        { sourceName: 'ad', externalId: AD_DN, sourceRole: 'target' },
      ]);
      await admin.save();
      const adminId = String(admin._id);
      await identityModel.updateOne(
        { _id: parent._id },
        {
          $set: {
            linkedAdminAccounts: [{ identityId: adminId, adminTier: 'TIER_1', status: 'PENDING' }],
          },
        },
      );
      return adminId;
    });
  }

  const handleOf = (adminId: string) =>
    harness.env.client.workflow.getHandle(privilegedSessionWorkflowId(TENANT, adminId));

  it('enables each account, shows ACTIVE only after, and disables them all when it expires', async () => {
    const adminId = await adminAccount();

    await pam.startSession(adminId, TENANT, 'session-1', 24 * HOUR);
    await activated.promise;

    // Enabled in each target first, while the entry still said ACTIVATING
    expect(calls).toEqual([
      ['entra', true],
      ['ad', true],
    ]);
    expect(statusWhileEnabling).toEqual(['ACTIVATING']);
    expect(enableEntraUser).toHaveBeenCalledWith(
      `obj-${adminId}`,
      TENANT,
      expect.any(String),
      ENTRA_CONFIG,
    );
    expect(setAdUserEnabled).toHaveBeenCalledWith(
      AD_DN,
      true,
      AD_CONFIG,
      TENANT,
      expect.any(String),
    );
    const active = await entryStatus(adminId);
    expect(active).toMatchObject({ status: 'ACTIVE', sessionId: 'session-1' });
    expect(active.expiresAt!.getTime() - active.activatedAt!.getTime()).toBe(24 * HOUR);
    const admin = await stored(adminId);
    expect(admin!.profile.status).toBe('ACTIVE');
    expect(admin!.pamTargetState).toBe('enabled');

    // The durable timer (time skips while the result is awaited)
    await expect(handleOf(adminId).result()).resolves.toEqual({
      outcome: 'ended',
      reason: 'expired',
      disableFailures: [],
    });
    expect(calls.slice(2)).toEqual([
      ['entra', false],
      ['ad', false],
    ]);
    const ended = await entryStatus(adminId);
    expect(ended.status).toBe('INACTIVE');
    expect(ended.deactivatedAt).toBeInstanceOf(Date);
    const after = await stored(adminId);
    expect(after!.profile.status).toBe('INACTIVE');
    expect(after!.pamTargetState).toBe('disabled');
  }, 60_000);

  it('a deactivate ends the session early and disables the accounts', async () => {
    const adminId = await adminAccount();
    await pam.startSession(adminId, TENANT, 'session-2', 8 * HOUR);
    await activated.promise;

    await pam.endSession(adminId, TENANT, 'deactivated');

    await expect(handleOf(adminId).result()).resolves.toEqual({
      outcome: 'ended',
      reason: 'deactivated',
      disableFailures: [],
    });
    expect(calls).toEqual([
      ['entra', true],
      ['ad', true],
      ['entra', false],
      ['ad', false],
    ]);
    expect((await entryStatus(adminId)).status).toBe('INACTIVE');
    expect(emitted.mock.calls.map(([type]) => type)).toEqual([
      'admin_account.activated',
      'admin_account.deactivated',
    ]);
  }, 60_000);

  it('an enable failure in one system disables the others and reports the activation failed', async () => {
    const adminId = await adminAccount();
    setAdUserEnabled.mockImplementation(async (_dn: unknown, enabled: unknown) => {
      calls.push(['ad', enabled === true]);
      if (enabled === true) {
        throw ApplicationFailure.nonRetryable(
          'ad: insufficient access rights (HTTP 403)',
          'DeprovisionRejected',
        );
      }
      return { outcome: 'done' };
    });

    await pam.startSession(adminId, TENANT, 'session-3', 8 * HOUR);
    const result = await handleOf(adminId).result();

    expect(result).toEqual({
      outcome: 'activation-failed',
      reason: 'ad: insufficient access rights (HTTP 403)',
      disableFailures: [],
    });
    // Entra ID was enabled, AD refused: every account is disabled again
    expect(calls).toEqual([
      ['entra', true],
      ['ad', true],
      ['entra', false],
      ['ad', false],
    ]);
    const entry = await entryStatus(adminId);
    expect(entry).toMatchObject({
      status: 'INACTIVE',
      sessionId: 'session-3',
      activationError: 'ad: insufficient access rights (HTTP 403)',
    });
    const admin = await stored(adminId);
    expect(admin!.profile.status).toBe('PENDING');
    expect(admin!.pamTargetState).toBe('disabled');
    expect(emitted).not.toHaveBeenCalledWith(
      'admin_account.activated',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  }, 60_000);

  it('never enables a deleted admin identity', async () => {
    const adminId = await adminAccount({ deletedAt: new Date('2026-11-20T10:00:00Z') });

    await pam.startSession(adminId, TENANT, 'session-4', 8 * HOUR);
    const result = await handleOf(adminId).result();

    expect(result.outcome).toBe('activation-failed');
    expect(result.reason).toMatch(/deleted: it is never enabled/);
    expect(calls.filter(([, enabled]) => enabled)).toEqual([]);
    expect((await entryStatus(adminId)).status).toBe('INACTIVE');
  }, 60_000);

  it("offboarding's signal during the activation stops the enabling and disables what was enabled", async () => {
    const adminId = await adminAccount();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    enableEntraUser.mockImplementation(async () => {
      calls.push(['entra', true]);
      enabling.resolve();
      await held;
      return true;
    });

    await pam.startSession(adminId, TENANT, 'session-5', 8 * HOUR);
    await enabling.promise;
    // Offboarding of the admin identity starts (getLinkedAdminIdentities signals it)
    await expect(pam.endIfRunning(adminId, TENANT, 'offboarded')).resolves.toBe(true);
    release();

    const result = await handleOf(adminId).result();
    expect(result).toEqual({
      outcome: 'activation-failed',
      reason: 'the session was ended before it was active (offboarded)',
      disableFailures: [],
    });
    // AD was never enabled; Entra ID, enabled meanwhile, is disabled again
    expect(calls).toEqual([
      ['entra', true],
      ['entra', false],
      ['ad', false],
    ]);
    expect((await entryStatus(adminId)).status).toBe('INACTIVE');
  }, 60_000);

  it('deactivate without a running session disables the accounts, and one session runs at a time', async () => {
    const adminId = await adminAccount();
    await withTenantContext(TENANT, () =>
      identityModel.updateOne({ _id: adminId }, { $set: { 'profile.status': 'ACTIVE' } }).exec(),
    );

    await pam.endSession(adminId, TENANT, 'deactivated');
    await expect(handleOf(adminId).result()).resolves.toEqual({
      outcome: 'disabled',
      reason: 'deactivated',
      disableFailures: [],
    });
    expect(calls).toEqual([
      ['entra', false],
      ['ad', false],
    ]);
    const admin = await stored(adminId);
    expect(admin!.profile.status).toBe('INACTIVE');
    expect(admin!.pamTargetState).toBe('disabled');
    // A disable-only run of a PENDING entry leaves it PENDING
    expect((await entryStatus(adminId)).status).toBe('PENDING');

    await pam.startSession(adminId, TENANT, 'session-6', 8 * HOUR);
    await expect(pam.startSession(adminId, TENANT, 'session-7', 8 * HOUR)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await activated.promise;
    await pam.endSession(adminId, TENANT, 'deactivated');
    await handleOf(adminId).result();
  }, 60_000);
});
