/**
 * Onboarding Workflow Tests
 *
 * Uses pure Jest mocks instead of TestWorkflowEnvironment.
 * Mocks activities with deterministic results. Asserts workflow completes and
 * correct activity sequence is called.
 *
 * @see docs/tasks/CURRENT_TASK_23.md
 */

const mockActivities: Record<string, jest.Mock> = {};
/** [activity, taskQueue] per call; taskQueue undefined = the workflow's (default) queue. */
const mockActivityQueues: Array<[string, string | undefined]> = [];
const mockPatched = jest.fn((_id: string) => true);

jest.mock('@temporalio/workflow', () => ({
  proxyActivities: jest.fn(
    (options?: { taskQueue?: string }) =>
      new Proxy(
        {},
        {
          get:
            (_target: unknown, prop: string) =>
            (...args: unknown[]) => {
              mockActivityQueues.push([prop, options?.taskQueue]);
              if (!mockActivities[prop]) mockActivities[prop] = jest.fn();
              return mockActivities[prop](...args);
            },
        },
      ),
  ),
  patched: (id: string) => mockPatched(id),
  defineQuery: jest.fn(() => Symbol('query')),
  defineSignal: jest.fn(() => Symbol('signal')),
  setHandler: jest.fn(),
  sleep: jest.fn().mockResolvedValue(undefined),
  condition: jest.fn().mockResolvedValue(true),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  // Classes: the workflow tells an activity failure that created an Entra ID account by instanceof
  ActivityFailure: jest.requireActual('@temporalio/common').ActivityFailure,
  ApplicationFailure: class ApplicationFailure extends Error {
    static nonRetryable(msg: string, type?: string) {
      const err = new Error(msg);
      (err as any).type = type;
      return err;
    }
  },
  workflowInfo: jest.fn(() => ({ workflowId: 'test-workflow-id' })),
  executeChild: jest.fn().mockResolvedValue(undefined),
  ParentClosePolicy: {
    PARENT_CLOSE_POLICY_TERMINATE: 1,
    PARENT_CLOSE_POLICY_ABANDON: 2,
  },
}));

jest.mock('../infrastructure/config/retry-policies', () => ({
  RECONCILIATION_RETRY: { maximumAttempts: 2 },
  CONNECTOR_RETRY: { maximumAttempts: 5 },
  HEALTH_CHECK_RETRY: { maximumAttempts: 3 },
  QUERY_RETRY: { maximumAttempts: 2 },
  BATCH_OPERATION_RETRY: { maximumAttempts: 3 },
  ACCESS_REVIEW_RETRY: { maximumAttempts: 3 },
  ARCHIVAL_RETRY: { maximumAttempts: 3 },
  SCHEDULED_SYNC_RETRY: { maximumAttempts: 2 },
}));

jest.mock('../infrastructure/temporal/task-queue.config', () => ({
  QUEUE_NAMES: {
    default: 'provisioning-default',
    entra: 'provisioning-entra',
    'entra-id': 'provisioning-entra',
    ad: 'provisioning-ad',
    'active-directory': 'provisioning-ad',
    scim: 'provisioning-scim',
    okta: 'provisioning-okta',
  },
  DEFAULT_PROVISIONING_QUEUE: 'provisioning-default',
  PROVISIONING_QUEUE_PREFIX: 'provisioning',
  CONNECTOR_QUEUES: ['entra', 'ad', 'scim'],
  ALL_PROVISIONING_QUEUES: [
    'provisioning-default',
    'provisioning-entra',
    'provisioning-ad',
    'provisioning-scim',
  ],
  registerConnectorQueue: jest.fn(),
  normalizeConnectorType: jest.fn((t: string) => t),
  getTaskQueueForConnector: jest.fn((t: string) => `provisioning-${t}`),
}));

import { onboardingWorkflow, type OnboardingWorkflowInput } from './onboarding.workflow';
import { createMockUser } from '../testing/mock-factories';

/** An all-users run's input (no targetEmail): only histories from before the patch have one. */
const ALL_USERS = { tenantId: 'test-tenant' } as unknown as OnboardingWorkflowInput;

const mockUser = createMockUser({
  email: 'onboard-test@test.com',
  firstName: 'Onboard',
  lastName: 'Test',
});

beforeEach(() => {
  Object.keys(mockActivities).forEach((key) => delete mockActivities[key]);
  mockActivityQueues.length = 0;
  jest.clearAllMocks();
  // Most cases run the per-person journey through the all-users input (no targetEmail), the path
  // histories from before onboarding:target-required keep; the patched start is tested below and
  // in test/workflows/onboarding-target-required.workflow.e2e-spec.ts
  mockPatched.mockImplementation((id: string) => id !== 'onboarding:target-required');
  // Entra ID has a config to run on unless a test says otherwise
  mockActivities.isEntraConfigured = jest.fn().mockResolvedValue(true);
  // No target excluded by an access review unless a test says otherwise
  mockActivities.getReviewExcludedTargets = jest.fn().mockResolvedValue([]);
});

describe('Onboarding Workflow', () => {
  it('fails a run started without its person before any activity (onboarding:target-required)', async () => {
    mockPatched.mockReturnValue(true);

    await expect(onboardingWorkflow(ALL_USERS)).rejects.toMatchObject({
      type: 'OnboardingTargetRequired',
    });
    expect(mockActivityQueues).toEqual([]);
  });

  it('provisions a new hire to Entra ID with the Entra ID operations, then marks it SYNCED', async () => {
    const entraGroup = { target: 'entra-id', type: 'group', action: 'add', targetId: 'g-eng' };
    const allLicense = { target: 'all', type: 'license', action: 'add', targetId: 'E3' };
    const oktaGroup = { target: 'okta', type: 'group', action: 'add', targetId: 'okta-eng' };
    mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue(['entra']);
    mockActivities.getConnectorConfig = jest.fn().mockResolvedValue(null);
    mockActivities.getEdgeConditions = jest.fn().mockResolvedValue(null);
    mockActivities.fetchNewHires = jest.fn().mockResolvedValue([mockUser]);
    mockActivities.saveToHub = jest.fn().mockResolvedValue(undefined);
    mockActivities.getUserByEmail = jest.fn().mockResolvedValue(mockUser);
    mockActivities.getIdentityByEmail = jest
      .fn()
      .mockResolvedValue({ _id: 'identity-1', profile: mockUser, provisioning: [] });
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.evaluateUser = jest
      .fn()
      .mockResolvedValue({ operations: [entraGroup, allLicense, oktaGroup] });
    mockActivities.getPipelineStatus = jest.fn().mockResolvedValue('DEPLOYED');
    mockActivities.recordProvisioningOutcome = jest.fn().mockResolvedValue(undefined);
    mockActivities.checkEntraHealth = jest.fn().mockResolvedValue(true);
    mockActivities.provisionUserToEntra = jest
      .fn()
      .mockResolvedValue({ success: true, objectId: 'entra-123' });
    mockActivities.writebackToIdentity = jest
      .fn()
      .mockResolvedValue({ success: true, updatedFields: [] });
    mockActivities.writebackToHrSource = jest.fn().mockResolvedValue(undefined);

    const result = await onboardingWorkflow(ALL_USERS);

    expect(result).toBe('Dynamic onboarding complete for all users.');
    expect(mockActivities.saveToHub).toHaveBeenCalledWith(
      mockUser,
      'test-tenant',
      'test-workflow-id',
    );
    // (user, Entra ID's own and the 'all' operations, config, tenantId, correlationId, _, mustExist)
    expect(mockActivities.provisionUserToEntra).toHaveBeenCalledWith(
      mockUser,
      { operations: [entraGroup, allLicense] },
      undefined,
      'test-tenant',
      'test-workflow-id',
      undefined,
      false,
    );
    expect(mockActivities.writebackToIdentity).toHaveBeenCalledWith(
      'identity-1',
      'entra-id',
      expect.objectContaining({ objectId: 'entra-123' }),
      'test-tenant',
      'test-workflow-id',
    );
    expect(mockActivities.setProvisioningStatus.mock.calls.map((c) => c.slice(1, 3))).toEqual([
      ['entra', 'SYNCING'],
      ['entra', 'SYNCED'],
    ]);
    expect(mockActivities.recordProvisioningOutcome).toHaveBeenCalledWith(
      'test-tenant',
      true,
      'test-workflow-id',
    );
  });

  it('completes without provisioning when fetchNewHires returns empty list', async () => {
    mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue(['entra']);
    mockActivities.getConnectorConfig = jest.fn().mockResolvedValue(null);
    mockActivities.getEdgeConditions = jest.fn().mockResolvedValue(null);
    mockActivities.fetchNewHires = jest.fn().mockResolvedValue([]);
    mockActivities.saveToHub = jest.fn().mockResolvedValue(undefined);
    mockActivities.getUserByEmail = jest.fn().mockResolvedValue(mockUser);
    mockActivities.getIdentityByEmail = jest.fn().mockResolvedValue(null);
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.evaluateUser = jest.fn().mockResolvedValue({ operations: [] });
    mockActivities.getPipelineStatus = jest.fn().mockResolvedValue('DEPLOYED');
    mockActivities.recordProvisioningOutcome = jest.fn().mockResolvedValue(undefined);
    mockActivities.checkEntraHealth = jest.fn().mockResolvedValue(true);
    mockActivities.provisionUserToEntra = jest
      .fn()
      .mockResolvedValue({ success: true, objectId: 'entra-123' });
    mockActivities.writebackToIdentity = jest
      .fn()
      .mockResolvedValue({ success: true, updatedFields: [] });
    mockActivities.writebackToHrSource = jest.fn().mockResolvedValue(undefined);

    const result = await onboardingWorkflow(ALL_USERS);

    expect(result).toContain('Dynamic onboarding complete');
    expect(mockActivities.provisionUserToEntra).not.toHaveBeenCalled();
  });

  it('fails a one-person run for an unknown address without naming the address', async () => {
    // Failure messages stay in clear in the Temporal history: the payload codec covers payloads
    mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue([]);
    mockActivities.getIdentityByEmail = jest.fn().mockResolvedValue(null);
    mockActivities.getUserByEmail = jest.fn().mockResolvedValue(null);

    const error = (await onboardingWorkflow({
      targetEmail: 'nobody@test.com',
      tenantId: 'test-tenant',
    }).catch((e: unknown) => e)) as Error & { type?: string };

    expect(error.type).toBe('UserNotFound');
    expect(error.message).toBe('The requested person was not found in Hub');
    expect(error.message).not.toContain('nobody@test.com');
  });

  it('throws when provisionUserToEntra fails', async () => {
    mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue(['entra']);
    mockActivities.getConnectorConfig = jest.fn().mockResolvedValue(null);
    mockActivities.getEdgeConditions = jest.fn().mockResolvedValue(null);
    mockActivities.fetchNewHires = jest.fn().mockResolvedValue([mockUser]);
    mockActivities.saveToHub = jest.fn().mockResolvedValue(undefined);
    mockActivities.getUserByEmail = jest.fn().mockResolvedValue(mockUser);
    mockActivities.getIdentityByEmail = jest.fn().mockResolvedValue(null);
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.evaluateUser = jest.fn().mockResolvedValue({ operations: [] });
    mockActivities.getPipelineStatus = jest.fn().mockResolvedValue('DEPLOYED');
    mockActivities.recordProvisioningOutcome = jest.fn().mockResolvedValue(undefined);
    mockActivities.checkEntraHealth = jest.fn().mockResolvedValue(true);
    mockActivities.provisionUserToEntra = jest
      .fn()
      .mockRejectedValue(new Error('Entra API unavailable'));
    mockActivities.writebackToIdentity = jest
      .fn()
      .mockResolvedValue({ success: true, updatedFields: [] });
    mockActivities.writebackToHrSource = jest.fn().mockResolvedValue(undefined);

    await expect(onboardingWorkflow(ALL_USERS)).rejects.toThrow();
  });

  it('calls non-Entra health checks and generic provisioning with the tenant in the tenantId slot', async () => {
    const adConfig = { host: 'dc1.corp', baseDn: 'DC=corp' };
    mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue(['ad', 'okta']);
    mockActivities.saveToHub = jest.fn().mockResolvedValue(undefined);
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.recordProvisioningOutcome = jest.fn().mockResolvedValue(undefined);
    mockActivities.getConnectorConfig = jest
      .fn()
      .mockImplementation(async (id: string) => (id === 'ad' ? adConfig : null));
    mockActivities.getEdgeConditions = jest.fn().mockResolvedValue(null);
    mockActivities.fetchNewHires = jest.fn().mockResolvedValue([mockUser]);
    mockActivities.getUserByEmail = jest.fn().mockResolvedValue(mockUser);
    mockActivities.getIdentityByEmail = jest.fn().mockResolvedValue(null);
    mockActivities.evaluateUser = jest.fn().mockResolvedValue({ operations: [] });
    mockActivities.getPipelineStatus = jest.fn().mockResolvedValue('DEPLOYED');
    mockActivities.checkAdHealth = jest.fn().mockResolvedValue(true);
    mockActivities.checkOktaHealth = jest.fn().mockResolvedValue(true);
    mockActivities.provisionUserToAd = jest.fn().mockResolvedValue({ success: true });
    mockActivities.provisionUserToOkta = jest.fn().mockResolvedValue({ success: true });

    await onboardingWorkflow(ALL_USERS);

    // Signatures: check<X>Health(config, tenantId, correlationId) and
    // provisionUserToOkta(user, intent, config, tenantId, correlationId). AD is checked on its
    // canvas config (patch onboarding:ad-not-configured), the one provisionUserToAd gets.
    expect(mockActivities.checkAdHealth).toHaveBeenCalledWith(
      adConfig,
      'test-tenant',
      'test-workflow-id',
    );
    expect(mockActivities.checkOktaHealth).toHaveBeenCalledWith(
      undefined,
      'test-tenant',
      'test-workflow-id',
    );
    expect(mockActivities.provisionUserToOkta).toHaveBeenCalledWith(
      mockUser,
      { operations: [] },
      undefined,
      'test-tenant',
      'test-workflow-id',
    );
  });
});

describe('Onboarding Workflow: Okta and SCIM queues', () => {
  const scimConfig = { baseUrl: 'https://scim.example.test/v2', authType: 'bearer' };

  beforeEach(() => {
    mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue(['okta', 'scim']);
    mockActivities.getConnectorConfig = jest
      .fn()
      .mockImplementation(async (id: string) => (id === 'scim' ? scimConfig : null));
    mockActivities.getEdgeConditions = jest.fn().mockResolvedValue(null);
    mockActivities.fetchNewHires = jest.fn().mockResolvedValue([mockUser]);
    mockActivities.saveToHub = jest.fn().mockResolvedValue(undefined);
    mockActivities.getUserByEmail = jest.fn().mockResolvedValue(mockUser);
    mockActivities.getIdentityByEmail = jest.fn().mockResolvedValue(null);
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.evaluateUser = jest.fn().mockResolvedValue({ operations: [] });
    mockActivities.getPipelineStatus = jest.fn().mockResolvedValue('DEPLOYED');
    mockActivities.recordProvisioningOutcome = jest.fn().mockResolvedValue(undefined);
    mockActivities.checkOktaHealth = jest.fn().mockResolvedValue(true);
    mockActivities.checkScimHealth = jest.fn().mockResolvedValue({ healthy: true });
    mockActivities.provisionUserToOkta = jest.fn().mockResolvedValue({ success: true });
    mockActivities.provisionUserToScim = jest.fn().mockResolvedValue({ success: true });
  });

  it('fails the health check when the SCIM status is unhealthy', async () => {
    mockActivities.checkScimHealth = jest.fn().mockResolvedValue({ healthy: false });

    await expect(onboardingWorkflow(ALL_USERS)).rejects.toThrow('Critical: scim is unreachable.');
    expect(mockActivities.provisionUserToScim).not.toHaveBeenCalled();
  });

  it('keeps the default-queue calls for histories recorded before the patch', async () => {
    mockPatched.mockReturnValue(false);

    await onboardingWorkflow(ALL_USERS);

    expect(mockActivityQueues).toEqual(
      expect.arrayContaining([
        ['checkScimHealth', undefined],
        ['provisionUserToScim', undefined],
      ]),
    );
    expect(mockActivities.provisionUserToScim).toHaveBeenCalledWith(
      mockUser,
      { operations: [] },
      undefined,
      'test-tenant',
      'test-workflow-id',
    );
    expect(mockActivities.getConnectorConfig).not.toHaveBeenCalledWith(
      'scim',
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('Onboarding Workflow: account id writeback', () => {
  const scimConfig = { baseUrl: 'https://scim.example.test/v2', authType: 'bearer' };
  const identity = (provisioning: Array<Record<string, unknown>>) => ({
    _id: 'identity-1',
    profile: mockUser,
    provisioning,
  });

  beforeEach(() => {
    mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue(['okta', 'scim']);
    mockActivities.getConnectorConfig = jest
      .fn()
      .mockImplementation(async (id: string) => (id === 'scim' ? scimConfig : null));
    mockActivities.getEdgeConditions = jest.fn().mockResolvedValue(null);
    mockActivities.fetchNewHires = jest.fn().mockResolvedValue([mockUser]);
    mockActivities.saveToHub = jest.fn().mockResolvedValue(undefined);
    mockActivities.getUserByEmail = jest.fn().mockResolvedValue(mockUser);
    mockActivities.getIdentityByEmail = jest.fn().mockResolvedValue(identity([]));
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.evaluateUser = jest.fn().mockResolvedValue({ operations: [] });
    mockActivities.getPipelineStatus = jest.fn().mockResolvedValue('DEPLOYED');
    mockActivities.recordProvisioningOutcome = jest.fn().mockResolvedValue(undefined);
    mockActivities.checkOktaHealth = jest.fn().mockResolvedValue(true);
    mockActivities.checkScimHealth = jest.fn().mockResolvedValue({ healthy: true });
    mockActivities.provisionUserToOkta = jest
      .fn()
      .mockResolvedValue({ success: true, oktaUserId: 'okta-1', objectId: 'okta-1' });
    mockActivities.provisionUserToScim = jest
      .fn()
      .mockResolvedValue({ success: true, targetUserId: 'scim-1', objectId: 'scim-1' });
    mockActivities.writebackToIdentity = jest
      .fn()
      .mockResolvedValue({ success: true, updatedFields: [] });
    mockActivities.writebackToHrSource = jest.fn().mockResolvedValue(undefined);
  });

  it('does not write back again once a writeback completed for the target', async () => {
    mockActivities.getIdentityByEmail = jest.fn().mockResolvedValue(
      identity([
        { targetSystem: 'okta', status: 'SYNCED', writebackComplete: true },
        { targetSystem: 'scim', status: 'SYNCED', writebackComplete: true },
      ]),
    );

    await onboardingWorkflow(ALL_USERS);

    expect(mockActivities.writebackToIdentity).not.toHaveBeenCalled();
  });

  it('writes back only PENDING entries for histories recorded before the patch', async () => {
    // A history from before that patch also has none of the later onboarding:target-required
    mockPatched.mockImplementation(
      (id: string) =>
        id !== 'onboarding:writeback-until-complete' && id !== 'onboarding:target-required',
    );

    await onboardingWorkflow(ALL_USERS);

    expect(mockActivities.writebackToIdentity).not.toHaveBeenCalled();
  });
});

describe('Onboarding Workflow: SYNCED targets are not provisioned again', () => {
  const identity = (provisioning: Array<Record<string, unknown>>) => ({
    _id: 'identity-1',
    profile: mockUser,
    provisioning,
  });
  const done = (targetSystem: string) => ({
    targetSystem,
    status: 'SYNCED',
    writebackComplete: true,
  });

  beforeEach(() => {
    mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue(['entra', 'okta']);
    mockActivities.getConnectorConfig = jest.fn().mockResolvedValue(null);
    mockActivities.getEdgeConditions = jest.fn().mockResolvedValue(null);
    mockActivities.getIdentityByEmail = jest.fn().mockResolvedValue(identity([]));
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.evaluateUser = jest.fn().mockResolvedValue({ operations: [] });
    mockActivities.getPipelineStatus = jest.fn().mockResolvedValue('DEPLOYED');
    mockActivities.recordProvisioningOutcome = jest.fn().mockResolvedValue(undefined);
    mockActivities.checkEntraHealth = jest.fn().mockResolvedValue(true);
    mockActivities.checkOktaHealth = jest.fn().mockResolvedValue(true);
    mockActivities.provisionUserToEntra = jest
      .fn()
      .mockResolvedValue({ success: true, objectId: 'entra-1' });
    mockActivities.provisionUserToOkta = jest.fn().mockResolvedValue({ success: true });
    mockActivities.writebackToIdentity = jest
      .fn()
      .mockResolvedValue({ success: true, updatedFields: [] });
    mockActivities.writebackToHrSource = jest.fn().mockResolvedValue(undefined);
  });

  const onboard = (extra: Record<string, unknown> = {}) =>
    onboardingWorkflow({ targetEmail: mockUser.email, tenantId: 'test-tenant', ...extra });

  it('marks a target with nothing to write back complete, so the next run skips it', async () => {
    await onboard();

    // Okta answered without an account id: SYNCED with the writeback complete
    expect(mockActivities.setProvisioningStatus).toHaveBeenCalledWith(
      'identity-1',
      'okta',
      'SYNCED',
      undefined,
      'test-tenant',
      true,
      undefined,
      'test-workflow-id',
    );
  });

  it('provisions a SYNCED target again while its account id was never written back', async () => {
    mockActivities.getIdentityByEmail.mockResolvedValue(
      identity([{ targetSystem: 'entra', status: 'SYNCED' }, done('okta')]),
    );

    await onboard();

    expect(mockActivities.provisionUserToEntra).toHaveBeenCalledTimes(1);
    expect(mockActivities.writebackToIdentity).toHaveBeenCalledWith(
      'identity-1',
      'entra-id',
      expect.objectContaining({ objectId: 'entra-1' }),
      'test-tenant',
      'test-workflow-id',
    );
    expect(mockActivities.provisionUserToOkta).not.toHaveBeenCalled();
  });

  it('pushes to a SYNCED Entra ID again for syncToEntra, and to no other SYNCED target', async () => {
    mockActivities.getIdentityByEmail.mockResolvedValue(identity([done('entra'), done('okta')]));

    await onboard({ syncToEntra: true });

    expect(mockActivities.provisionUserToEntra).toHaveBeenCalledTimes(1);
    expect(mockActivities.provisionUserToOkta).not.toHaveBeenCalled();
  });

  // The sync never creates an account the identity's entry says exists (FOLLOWUPS 2026-11-24)
  it('asks Entra ID for the existing account on a syncToEntra run only', async () => {
    mockActivities.getIdentityByEmail.mockResolvedValue(identity([done('entra')]));
    await onboard({ syncToEntra: true });
    mockActivities.getIdentityByEmail.mockResolvedValue(
      identity([{ targetSystem: 'entra', status: 'ERROR' }]),
    );
    await onboard();

    // The activity's last argument (mustExist): the sync's run, then an onboarding run
    const mustExist = mockActivities.provisionUserToEntra.mock.calls.map((call) => call[6]);
    expect(mustExist).toEqual([true, false]);
  });

  it('provisions every target again for histories recorded before the patch', async () => {
    mockPatched.mockImplementation((id: string) => id !== 'onboarding:skip-synced-targets');
    mockActivities.getIdentityByEmail.mockResolvedValue(identity([done('entra'), done('okta')]));

    await onboard();

    expect(mockActivities.provisionUserToEntra).toHaveBeenCalledTimes(1);
    expect(mockActivities.provisionUserToOkta).toHaveBeenCalledTimes(1);
    expect(mockActivities.setProvisioningStatus).toHaveBeenCalledWith(
      'identity-1',
      'okta',
      'SYNCED',
      undefined,
      'test-tenant',
      undefined,
      undefined,
      'test-workflow-id',
    );
  });
});

describe('Onboarding Workflow: Entra ID not configured', () => {
  const canvasConfig = { tenantId: 'entra-canvas', clientId: 'app-c', clientSecret: 's-c' };

  beforeEach(() => {
    mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue(['entra', 'okta']);
    mockActivities.getConnectorConfig = jest.fn().mockResolvedValue(null);
    mockActivities.getEdgeConditions = jest.fn().mockResolvedValue(null);
    mockActivities.fetchNewHires = jest.fn().mockResolvedValue([mockUser]);
    mockActivities.saveToHub = jest.fn().mockResolvedValue(undefined);
    mockActivities.getUserByEmail = jest.fn().mockResolvedValue(mockUser);
    mockActivities.getIdentityByEmail = jest
      .fn()
      .mockResolvedValue({ _id: 'identity-1', profile: mockUser, provisioning: [] });
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.evaluateUser = jest.fn().mockResolvedValue({ operations: [] });
    mockActivities.getPipelineStatus = jest.fn().mockResolvedValue('DEPLOYED');
    mockActivities.recordProvisioningOutcome = jest.fn().mockResolvedValue(undefined);
    mockActivities.checkEntraHealth = jest.fn().mockResolvedValue(true);
    mockActivities.checkOktaHealth = jest.fn().mockResolvedValue(true);
    mockActivities.provisionUserToEntra = jest.fn().mockResolvedValue({ success: true });
    mockActivities.provisionUserToOkta = jest.fn().mockResolvedValue({ success: true });
  });

  it('leaves an Entra ID with no config anywhere out of the run and provisions the rest', async () => {
    mockActivities.isEntraConfigured.mockResolvedValue(false);

    const result = await onboardingWorkflow(ALL_USERS);

    expect(result).toBe(
      'Dynamic onboarding complete for all users. Skipped entra: not configured.',
    );
    expect(mockActivities.checkEntraHealth).not.toHaveBeenCalled();
    expect(mockActivities.provisionUserToEntra).not.toHaveBeenCalled();
    const entraEntries = mockActivities.setProvisioningStatus.mock.calls.filter(
      ([, system]) => system === 'entra',
    );
    expect(entraEntries).toEqual([]);
    expect(mockActivities.provisionUserToOkta).toHaveBeenCalledTimes(1);
    expect(mockActivityQueues).toContainEqual(['isEntraConfigured', 'provisioning-entra']);
    expect(mockPatched).toHaveBeenCalledWith('onboarding:entra-not-configured');
  });

  it('completes, saying so, when the unconfigured Entra ID was the only target', async () => {
    mockActivities.getActiveTargetSystems.mockResolvedValue(['entra']);
    mockActivities.isEntraConfigured.mockResolvedValue(false);

    await expect(onboardingWorkflow(ALL_USERS)).resolves.toBe(
      'Dynamic onboarding complete for all users. Skipped entra: not configured. ' +
        'No target left to provision.',
    );
    expect(mockActivities.setProvisioningStatus).not.toHaveBeenCalled();
  });

  it('checks the health of Entra ID on the canvas config provisioning gets', async () => {
    mockActivities.getConnectorConfig.mockImplementation(async (id: string) =>
      id === 'entra-id' ? canvasConfig : null,
    );

    await expect(onboardingWorkflow(ALL_USERS)).resolves.toBe(
      'Dynamic onboarding complete for all users.',
    );

    expect(mockActivities.isEntraConfigured).toHaveBeenCalledWith(
      canvasConfig,
      'test-tenant',
      'test-workflow-id',
    );
    expect(mockActivities.checkEntraHealth).toHaveBeenCalledWith(
      canvasConfig,
      'test-tenant',
      'test-workflow-id',
    );
    expect(mockActivities.provisionUserToEntra.mock.calls[0][2]).toEqual(canvasConfig);
  });

  it('fails the run when a configured Entra ID is unhealthy', async () => {
    mockActivities.checkEntraHealth.mockResolvedValue(false);

    await expect(onboardingWorkflow(ALL_USERS)).rejects.toThrow('Critical: entra is unreachable.');
    expect(mockActivities.provisionUserToEntra).not.toHaveBeenCalled();
    expect(mockActivities.provisionUserToOkta).not.toHaveBeenCalled();
  });

  it('checks Entra ID with config undefined for histories recorded before the patch', async () => {
    // A history from before that patch also has none of the later onboarding:target-required
    mockPatched.mockImplementation(
      (id: string) =>
        id !== 'onboarding:entra-not-configured' && id !== 'onboarding:target-required',
    );
    mockActivities.getConnectorConfig.mockImplementation(async (id: string) =>
      id === 'entra-id' ? canvasConfig : null,
    );

    await onboardingWorkflow(ALL_USERS);

    expect(mockActivities.isEntraConfigured).not.toHaveBeenCalled();
    expect(mockActivities.checkEntraHealth).toHaveBeenCalledWith(
      undefined,
      'test-tenant',
      'test-workflow-id',
    );
    expect(mockActivities.provisionUserToEntra).toHaveBeenCalledTimes(1);
  });
});

/**
 * A target an access review excluded for the person (a revoked account item: patch
 * onboarding:review-exclusions) is left out of their provisioning, not failed, and the result
 * names it; histories from before the patch ask nothing and provision it.
 */
describe('Onboarding Workflow: access review exclusions', () => {
  const scimConfig = { baseUrl: 'https://scim.example.test/v2', authType: 'bearer' };

  beforeEach(() => {
    mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue(['okta', 'scim']);
    mockActivities.getConnectorConfig = jest
      .fn()
      .mockImplementation(async (id: string) => (id === 'scim' ? scimConfig : null));
    mockActivities.getEdgeConditions = jest.fn().mockResolvedValue(null);
    mockActivities.getUserByEmail = jest.fn().mockResolvedValue(mockUser);
    mockActivities.getIdentityByEmail = jest
      .fn()
      .mockResolvedValue({ _id: 'identity-1', profile: mockUser, provisioning: [] });
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.evaluateUser = jest.fn().mockResolvedValue({ operations: [] });
    mockActivities.getPipelineStatus = jest.fn().mockResolvedValue('DEPLOYED');
    mockActivities.recordProvisioningOutcome = jest.fn().mockResolvedValue(undefined);
    mockActivities.checkOktaHealth = jest.fn().mockResolvedValue(true);
    mockActivities.checkScimHealth = jest.fn().mockResolvedValue({ healthy: true });
    mockActivities.provisionUserToOkta = jest.fn().mockResolvedValue({ success: true });
    mockActivities.provisionUserToScim = jest.fn().mockResolvedValue({ success: true });
    mockActivities.getReviewExcludedTargets = jest.fn().mockResolvedValue(['scim']);
  });

  const statusesOf = (system: string) =>
    mockActivities.setProvisioningStatus.mock.calls.filter(([, s]) => s === system);

  it('leaves an excluded target out of the person’s provisioning and names it', async () => {
    const result = await onboardingWorkflow({
      targetEmail: mockUser.email,
      tenantId: 'test-tenant',
    });

    expect(mockActivities.getReviewExcludedTargets).toHaveBeenCalledWith(
      'identity-1',
      ['okta', 'scim'],
      'test-tenant',
      'test-workflow-id',
    );
    expect(mockActivities.provisionUserToOkta).toHaveBeenCalledTimes(1);
    expect(mockActivities.provisionUserToScim).not.toHaveBeenCalled();
    expect(statusesOf('scim')).toEqual([]);
    expect(statusesOf('okta').length).toBeGreaterThan(0);
    expect(result).toContain('Left out by an access review exclusion: scim.');
    expect(mockPatched).toHaveBeenCalledWith('onboarding:review-exclusions');
  });

  it('asks nothing and provisions every target in histories from before the patch', async () => {
    mockPatched.mockImplementation((id: string) => id !== 'onboarding:review-exclusions');

    const result = await onboardingWorkflow({
      targetEmail: mockUser.email,
      tenantId: 'test-tenant',
    });

    expect(mockActivities.getReviewExcludedTargets).not.toHaveBeenCalled();
    expect(mockActivities.provisionUserToScim).toHaveBeenCalledTimes(1);
    expect(result).not.toContain('access review');
  });

  it('asks nothing for a person without an identity record', async () => {
    mockActivities.getIdentityByEmail = jest.fn().mockResolvedValue(null);

    await onboardingWorkflow({ targetEmail: mockUser.email, tenantId: 'test-tenant' });

    expect(mockActivities.getReviewExcludedTargets).not.toHaveBeenCalled();
    expect(mockActivities.provisionUserToScim).toHaveBeenCalledTimes(1);
  });
});
