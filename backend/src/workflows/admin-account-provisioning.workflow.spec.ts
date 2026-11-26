/**
 * Admin Account Provisioning Workflow Tests
 *
 * Uses pure Jest mocks (no TestWorkflowEnvironment) for Windows compatibility.
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
  workflowInfo: () => ({ workflowId: 'admin-workflow-id' }),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  // Classes: the workflow tells an activity failure that created an Entra ID account by instanceof
  ActivityFailure: jest.requireActual('@temporalio/common').ActivityFailure,
  ApplicationFailure: class ApplicationFailure extends Error {
    static nonRetryable(message: string) {
      return new Error(message);
    }
  },
}));

jest.mock('../infrastructure/config/retry-policies', () => ({
  CONNECTOR_RETRY: { maximumAttempts: 5 },
  HEALTH_CHECK_RETRY: { maximumAttempts: 3 },
  QUERY_RETRY: { maximumAttempts: 2 },
}));

jest.mock('../infrastructure/temporal/task-queue.config', () => ({
  QUEUE_NAMES: {
    entra: 'provisioning-entra',
    'entra-id': 'provisioning-entra',
    ad: 'provisioning-ad',
    scim: 'provisioning-scim',
    okta: 'provisioning-okta',
  },
}));

jest.mock('../shared/utils/normalize-system-name', () => ({
  normalizeSystemName: (name: string | undefined | null): string =>
    (name ?? '').toLowerCase().replace(/-/g, ''),
  getSystemType: (system: string | undefined | null): 'entra' | 'ad' | 'unknown' => {
    const n = (system ?? '').toLowerCase().replace(/-/g, '');
    if (n === 'entra' || n === 'entraid') return 'entra';
    if (n === 'ad' || n === 'activedirectory') return 'ad';
    return 'unknown';
  },
}));

import { adminAccountProvisioningWorkflow } from './admin-account-provisioning.workflow';

describe('Admin Account Provisioning Workflow', () => {
  beforeEach(() => {
    Object.keys(mockActivities).forEach((key) => delete mockActivities[key]);
    mockActivityQueues.length = 0;
    mockPatched.mockReset().mockReturnValue(true);
    // Entra ID has a config (patch admin-account-provisioning:entra-not-configured asks first)
    mockActivities.isEntraConfigured = jest.fn().mockResolvedValue(true);
  });

  it('completes when no active target systems', async () => {
    mockActivities.getOrCreateLinkedAdminIdentity = jest.fn().mockResolvedValue({
      adminIdentityId: 'admin-id-1',
      adminProfile: { email: 'admin@test.com', firstName: 'Admin', lastName: 'User' },
    });
    mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue([]);

    const result = await adminAccountProvisioningWorkflow({
      parentIdentityId: 'parent-1',
      adminTier: 'TIER_1',
      adminOperations: [],
      tenantId: 'test-tenant',
    });

    expect(result).toContain('Admin account admin@test.com provisioned');
    expect(mockActivities.getOrCreateLinkedAdminIdentity).toHaveBeenCalledWith(
      'parent-1',
      'TIER_1',
      'test-tenant',
    );
    expect(mockActivities.getActiveTargetSystems).toHaveBeenCalledWith('test-tenant');
  });

  it('throws when getOrCreateLinkedAdminIdentity fails', async () => {
    mockActivities.getOrCreateLinkedAdminIdentity = jest
      .fn()
      .mockRejectedValue(new Error('Identity creation failed'));
    mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue([]);

    await expect(
      adminAccountProvisioningWorkflow({
        parentIdentityId: 'parent-fail',
        adminTier: 'TIER_1',
        adminOperations: [],
        tenantId: 'test-tenant',
      }),
    ).rejects.toThrow(/Identity creation failed/);

    expect(mockActivities.getOrCreateLinkedAdminIdentity).toHaveBeenCalledWith(
      'parent-fail',
      'TIER_1',
      'test-tenant',
    );
  });

  it('provisions admin to entra when active target systems include entra-id', async () => {
    const adminProfile = { email: 'admin@test.com', firstName: 'Admin', lastName: 'User' };
    mockActivities.getOrCreateLinkedAdminIdentity = jest.fn().mockResolvedValue({
      adminIdentityId: 'admin-id-2',
      adminProfile,
    });
    mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue(['entra-id']);
    mockActivities.getConnectorConfig = jest
      .fn()
      .mockResolvedValue({ tenantId: 'entra-tenant', clientId: 'c1' });
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.provisionUserToEntra = jest.fn().mockResolvedValue({
      success: true,
      objectId: 'entra-obj-1',
      generatedAttributes: {},
    });
    mockActivities.writebackToIdentity = jest.fn().mockResolvedValue(undefined);
    mockActivities.recordProvisioningOutcome = jest.fn().mockResolvedValue(undefined);

    const result = await adminAccountProvisioningWorkflow({
      parentIdentityId: 'parent-2',
      adminTier: 'TIER_1',
      adminOperations: [
        {
          type: 'group',
          action: 'add',
          target: 'entra-id',
          targetId: 'admin-group-1',
          sourcePolicy: 'pam-policy',
          adminTier: 'TIER_1' as const,
        },
      ],
      tenantId: 'test-tenant',
    });

    expect(result).toContain('Admin account admin@test.com provisioned');
    expect(mockActivities.getActiveTargetSystems).toHaveBeenCalledWith('test-tenant');
    expect(mockActivities.setProvisioningStatus).toHaveBeenCalledWith(
      'admin-id-2',
      'entra-id',
      'SYNCING',
      undefined,
      'test-tenant',
    );
    expect(mockActivities.provisionUserToEntra).toHaveBeenCalled();
    expect(mockActivities.recordProvisioningOutcome).toHaveBeenCalledWith('test-tenant', true);
  });

  describe('the standing state (patch admin-account-provisioning:settle-standing-state)', () => {
    const provisionToEntra = () => {
      mockActivities.getOrCreateLinkedAdminIdentity = jest.fn().mockResolvedValue({
        adminIdentityId: 'admin-id-9',
        adminProfile: { email: 'admin@test.com', firstName: 'Admin', lastName: 'User' },
      });
      mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue(['entra-id']);
      mockActivities.getConnectorConfig = jest.fn().mockResolvedValue(null);
      mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
      mockActivities.provisionUserToEntra = jest.fn().mockResolvedValue({ success: true });
      mockActivities.recordProvisioningOutcome = jest.fn().mockResolvedValue(undefined);
      mockActivities.settleAdminAccountState = jest.fn().mockResolvedValue(true);
      return adminAccountProvisioningWorkflow({
        parentIdentityId: 'parent-9',
        adminTier: 'TIER_0',
        adminOperations: [
          {
            type: 'role',
            action: 'add',
            target: 'entra-id',
            targetId: 'global-admin',
            sourcePolicy: 'pam-policy',
            adminTier: 'TIER_0' as const,
          },
        ],
        tenantId: 'test-tenant',
      });
    };

    it('asks for a disable-only session run once a target is provisioned', async () => {
      await provisionToEntra();

      expect(mockActivities.settleAdminAccountState).toHaveBeenCalledWith(
        'admin-id-9',
        'test-tenant',
        'admin-workflow-id',
      );
      const calls = mockActivityQueues.map(([name]) => name);
      expect(calls.indexOf('settleAdminAccountState')).toBeGreaterThan(
        calls.lastIndexOf('setProvisioningStatus'),
      );
    });

    it('does not ask in histories recorded before the patch', async () => {
      mockPatched.mockImplementation(
        (id: string) => id !== 'admin-account-provisioning:settle-standing-state',
      );
      await provisionToEntra();
      expect(mockActivities.settleAdminAccountState).not.toHaveBeenCalled();
    });
  });

  describe('Entra ID without a config (patch admin-account-provisioning:entra-not-configured)', () => {
    const provision = () => {
      mockActivities.getOrCreateLinkedAdminIdentity = jest.fn().mockResolvedValue({
        adminIdentityId: 'admin-id-7',
        adminProfile: { email: 'admin@test.com', firstName: 'Admin', lastName: 'User' },
      });
      mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue(['entra']);
      mockActivities.getConnectorConfig = jest.fn().mockResolvedValue(null);
      mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
      mockActivities.provisionUserToEntra = jest.fn().mockResolvedValue({ success: true });
      mockActivities.recordProvisioningOutcome = jest.fn().mockResolvedValue(undefined);
      return adminAccountProvisioningWorkflow({
        parentIdentityId: 'parent-7',
        adminTier: 'TIER_1',
        adminOperations: [
          {
            type: 'group',
            action: 'add',
            target: 'all',
            targetId: 'admins',
            sourcePolicy: 'pam-policy',
            adminTier: 'TIER_1' as const,
          },
        ],
        tenantId: 'test-tenant',
      });
    };

    it('leaves Entra ID out of the run, on its queue, without failing', async () => {
      mockActivities.isEntraConfigured.mockResolvedValue(false);

      await expect(provision()).resolves.toContain('provisioned');

      expect(mockActivityQueues).toContainEqual(['isEntraConfigured', 'provisioning-entra']);
      expect(mockActivities.provisionUserToEntra).not.toHaveBeenCalled();
      expect(mockActivities.setProvisioningStatus).not.toHaveBeenCalled();
    });

    it('does not ask in histories recorded before the patch', async () => {
      mockPatched.mockImplementation(
        (id: string) => id !== 'admin-account-provisioning:entra-not-configured',
      );
      await provision();
      expect(mockActivities.isEntraConfigured).not.toHaveBeenCalled();
      expect(mockActivities.provisionUserToEntra).toHaveBeenCalledTimes(1);
    });
  });

  it('skips systems with no matching operations', async () => {
    const adminProfile = { email: 'admin@test.com', firstName: 'Admin', lastName: 'User' };
    mockActivities.getOrCreateLinkedAdminIdentity = jest.fn().mockResolvedValue({
      adminIdentityId: 'admin-id-3',
      adminProfile,
    });
    // AD is active but the operation targets entra only
    mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue(['ad']);
    mockActivities.getConnectorConfig = jest.fn().mockResolvedValue({ host: 'ldap://ad' });
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);

    const result = await adminAccountProvisioningWorkflow({
      parentIdentityId: 'parent-3',
      adminTier: 'TIER_1',
      adminOperations: [
        {
          type: 'group',
          action: 'add',
          target: 'entra-id',
          targetId: 'admin-group-1',
          sourcePolicy: 'pam-policy',
          adminTier: 'TIER_1' as const,
        },
      ],
      tenantId: 'test-tenant',
    });

    expect(result).toContain('Admin account admin@test.com provisioned');
    // setProvisioningStatus should NOT have been called since AD had no matching ops
    expect(mockActivities.setProvisioningStatus).not.toHaveBeenCalled();
  });

  it('marks provisioning ERROR and rethrows when connector fails', async () => {
    const adminProfile = { email: 'admin@test.com', firstName: 'Admin', lastName: 'User' };
    mockActivities.getOrCreateLinkedAdminIdentity = jest.fn().mockResolvedValue({
      adminIdentityId: 'admin-id-4',
      adminProfile,
    });
    mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue(['entra-id']);
    mockActivities.getConnectorConfig = jest.fn().mockResolvedValue({ tenantId: 'entra-tenant' });
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.provisionUserToEntra = jest.fn().mockRejectedValue(new Error('Entra API down'));
    mockActivities.recordProvisioningOutcome = jest.fn().mockResolvedValue(undefined);

    await expect(
      adminAccountProvisioningWorkflow({
        parentIdentityId: 'parent-4',
        adminTier: 'TIER_1',
        adminOperations: [
          {
            type: 'group',
            action: 'add',
            target: 'entra-id',
            targetId: 'admin-group-1',
            sourcePolicy: 'pam-policy',
            adminTier: 'TIER_1' as const,
          },
        ],
        tenantId: 'test-tenant',
      }),
    ).rejects.toThrow(/Entra API down/);

    expect(mockActivities.setProvisioningStatus).toHaveBeenCalledWith(
      'admin-id-4',
      'entra-id',
      'ERROR',
      'Entra API down',
      'test-tenant',
    );
    expect(mockActivities.recordProvisioningOutcome).toHaveBeenCalledWith('test-tenant', false);
  });
});

describe('Admin Account Provisioning Workflow: Okta and SCIM queues', () => {
  const adminProfile = { email: 'admin@test.com', firstName: 'Admin', lastName: 'User' };
  const scimConfig = { baseUrl: 'https://scim.example.test/v2', authType: 'bearer' };
  const adminOp = (target: string) => ({
    type: 'group',
    action: 'add',
    target,
    targetId: `${target}-admins`,
    sourcePolicy: 'pam-policy',
    adminTier: 'TIER_1' as const,
  });
  const opWithoutTier = (target: string) => {
    const { adminTier: _tier, ...op } = adminOp(target);
    return op;
  };
  const run = () =>
    adminAccountProvisioningWorkflow({
      parentIdentityId: 'parent-5',
      adminTier: 'TIER_1',
      adminOperations: [adminOp('okta'), adminOp('scim')],
      tenantId: 'test-tenant',
    });

  beforeEach(() => {
    Object.keys(mockActivities).forEach((key) => delete mockActivities[key]);
    mockActivityQueues.length = 0;
    mockPatched.mockReset().mockReturnValue(true);
    mockActivities.getOrCreateLinkedAdminIdentity = jest.fn().mockResolvedValue({
      adminIdentityId: 'admin-id-5',
      adminProfile,
    });
    mockActivities.getActiveTargetSystems = jest.fn().mockResolvedValue(['okta', 'scim']);
    mockActivities.getConnectorConfig = jest
      .fn()
      .mockImplementation(async (id: string) => (id === 'scim' ? scimConfig : null));
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.recordProvisioningOutcome = jest.fn().mockResolvedValue(undefined);
    mockActivities.provisionUserToOkta = jest.fn().mockResolvedValue({ success: true });
    mockActivities.provisionUserToScim = jest.fn().mockResolvedValue({ success: true });
  });

  it('calls Okta and SCIM on their plugin queues, SCIM as (config, user, tenantId, correlationId)', async () => {
    await run();

    expect(mockActivityQueues).toEqual(
      expect.arrayContaining([
        ['provisionUserToOkta', 'provisioning-okta'],
        ['provisionUserToScim', 'provisioning-scim'],
      ]),
    );
    expect(mockActivityQueues).not.toContainEqual(['provisionUserToOkta', undefined]);
    expect(mockActivityQueues).not.toContainEqual(['provisionUserToScim', undefined]);
    expect(mockActivities.provisionUserToOkta).toHaveBeenCalledWith(
      adminProfile,
      { operations: [opWithoutTier('okta')] },
      undefined,
      'test-tenant',
      'admin-workflow-id',
    );
    expect(mockActivities.getConnectorConfig).toHaveBeenCalledWith(
      'scim',
      'test-tenant',
      'admin-workflow-id',
    );
    expect(mockActivities.provisionUserToScim).toHaveBeenCalledWith(
      scimConfig,
      adminProfile,
      'test-tenant',
      'admin-workflow-id',
    );
    expect(mockPatched).toHaveBeenCalledWith('admin-account-provisioning:connector-queue-routing');
    expect(mockActivities.setProvisioningStatus).toHaveBeenCalledWith(
      'admin-id-5',
      'scim',
      'SYNCED',
      undefined,
      'test-tenant',
    );
  });

  it('marks SCIM ERROR without a SCIM connector config on the canvas', async () => {
    mockActivities.getConnectorConfig = jest.fn().mockResolvedValue(null);

    await expect(run()).rejects.toThrow('No SCIM connector config on the canvas for scim');
    expect(mockActivities.provisionUserToScim).not.toHaveBeenCalled();
    expect(mockActivities.setProvisioningStatus).toHaveBeenCalledWith(
      'admin-id-5',
      'scim',
      'ERROR',
      'No SCIM connector config on the canvas for scim',
      'test-tenant',
    );
  });

  it('keeps the default-queue calls for histories recorded before the patch', async () => {
    mockPatched.mockReturnValue(false);

    await run();

    expect(mockActivityQueues).toEqual(
      expect.arrayContaining([
        ['provisionUserToOkta', undefined],
        ['provisionUserToScim', undefined],
      ]),
    );
    // provisionUserToX(user, intent, config, tenantId): the pre-patch call, kept for replay
    expect(mockActivities.provisionUserToScim).toHaveBeenCalledWith(
      adminProfile,
      { operations: [opWithoutTier('scim')] },
      undefined,
      'test-tenant',
    );
    expect(mockActivities.getConnectorConfig).not.toHaveBeenCalled();
  });
});
