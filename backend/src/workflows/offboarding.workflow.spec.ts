/**
 * Offboarding Workflow Tests: the flow before the patch offboarding:per-system-results, which
 * histories recorded before it still replay (patched() is false for them).
 *
 * Verifies state-based deprovisioning: workflow reads identity.provisioning to discover
 * targets, deprovisions from each. Fails (does not mark Hub deleted) when any target
 * deprovision fails, to avoid permanent orphans.
 * The patched flow: offboarding-per-system.workflow.spec.ts.
 *
 * Uses pure Jest mocks (no TestWorkflowEnvironment) for Windows compatibility.
 */

const mockActivities: Record<string, jest.Mock> = {};
const stableRefs: Record<string, (...args: unknown[]) => unknown> = {};

jest.mock('@temporalio/workflow', () => ({
  proxyActivities: jest.fn(
    () =>
      new Proxy(
        {},
        {
          get: (_target: unknown, prop: string) => {
            if (!stableRefs[prop]) {
              if (!mockActivities[prop]) mockActivities[prop] = jest.fn();
              stableRefs[prop] = (...args: unknown[]) => mockActivities[prop](...args);
            }
            return stableRefs[prop];
          },
        },
      ),
  ),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  patched: jest.fn(() => false),
  workflowInfo: () => ({ workflowId: 'wf-legacy' }),
  ActivityFailure: class ActivityFailure extends Error {},
  ApplicationFailure: {
    nonRetryable: (msg: string, type?: string) => {
      const err = new Error(msg);
      (err as any).type = type;
      return err;
    },
  },
}));

jest.mock('../infrastructure/config/retry-policies', () => ({
  CONNECTOR_RETRY: { maximumAttempts: 5 },
}));

jest.mock('../infrastructure/temporal/task-queue.config', () => ({
  QUEUE_NAMES: {
    entra: 'provisioning-entra',
    'entra-id': 'provisioning-entra',
    ad: 'provisioning-ad',
    scim: 'provisioning-scim',
  },
}));

// The workflow source imports these directly — provide real implementations
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

import { offboardingWorkflow } from './offboarding.workflow';

describe('Offboarding Workflow (before offboarding:per-system-results)', () => {
  beforeEach(() => {
    Object.keys(mockActivities).forEach((key) => delete mockActivities[key]);
  });

  it('deprovisions from multiple systems when provisioning has SYNCED targets', async () => {
    mockActivities.getProvisionedTargets = jest.fn().mockResolvedValue([
      { targetSystem: 'entra-id', externalId: undefined },
      { targetSystem: 'ad', externalId: 'CN=user,OU=Users,DC=corp,DC=local' },
    ]);
    mockActivities.getConnectorConfig = jest.fn().mockResolvedValue({ tenantId: 'test' });
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.markDeleted = jest.fn().mockResolvedValue(undefined);
    mockActivities.deleteUser = jest.fn().mockResolvedValue({ success: true });
    mockActivities.disableAdUser = jest.fn().mockResolvedValue(true);

    const result = await offboardingWorkflow({
      userId: 'id-123',
      userEmail: 'user@test.com',
      tenantId: 'test-tenant',
    });

    expect(result).toContain('Offboarding complete');
    expect(mockActivities.getProvisionedTargets).toHaveBeenCalledWith('id-123', 'test-tenant');
    expect(mockActivities.deleteUser).toHaveBeenCalledWith(
      'user@test.com',
      expect.anything(),
      'id-123',
      'test-tenant',
    );
    expect(mockActivities.disableAdUser).toHaveBeenCalledWith(
      'CN=user,OU=Users,DC=corp,DC=local',
      expect.anything(),
      'test-tenant',
    );
    expect(mockActivities.setProvisioningStatus).toHaveBeenCalledWith(
      'id-123',
      'entra-id',
      'DEPROVISIONED',
      undefined,
      'test-tenant',
    );
    expect(mockActivities.setProvisioningStatus).toHaveBeenCalledWith(
      'id-123',
      'ad',
      'DEPROVISIONED',
      undefined,
      'test-tenant',
    );
    expect(mockActivities.markDeleted).toHaveBeenCalledWith('id-123', 'test-tenant');
  });

  // getProvisionedTargets returns the SYNCED entries only (the activity leaves out ERROR and
  // PENDING); the workflow deprovisions exactly those and needs no Entra ID fallback
  it('deprovisions only the targets getProvisionedTargets returns, without the Entra ID fallback', async () => {
    mockActivities.getProvisionedTargets = jest
      .fn()
      .mockResolvedValue([{ targetSystem: 'ad', externalId: 'CN=other,OU=Users,DC=corp' }]);
    mockActivities.getConnectorConfig = jest.fn().mockResolvedValue({ tenantId: 'test' });
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.markDeleted = jest.fn().mockResolvedValue(undefined);
    mockActivities.deleteUser = jest.fn().mockResolvedValue({ success: true });
    mockActivities.disableAdUser = jest.fn().mockResolvedValue(true);

    const result = await offboardingWorkflow({
      userId: 'id-456',
      userEmail: 'other@test.com',
      tenantId: 'test-tenant',
    });

    expect(result).toContain('Offboarding complete');
    expect(mockActivities.getProvisionedTargets).toHaveBeenCalledWith('id-456', 'test-tenant');
    expect(mockActivities.disableAdUser).toHaveBeenCalledWith(
      'CN=other,OU=Users,DC=corp',
      { tenantId: 'test' },
      'test-tenant',
    );
    expect(mockActivities.deleteUser).not.toHaveBeenCalled();
    expect(mockActivities.setProvisioningStatus.mock.calls).toEqual([
      ['id-456', 'ad', 'DEPROVISIONED', undefined, 'test-tenant'],
    ]);
    expect(mockActivities.markDeleted).toHaveBeenCalledWith('id-456', 'test-tenant');
  });

  it('throws when any deprovision fails (avoids permanent orphans)', async () => {
    // Entra deleteUser succeeds but returns success: false (treated as non-success by workflow logic)
    // The workflow pushes { success: false } for entra, and { success: true } for AD
    // Then failCount > 0 triggers the ApplicationFailure
    mockActivities.getProvisionedTargets = jest.fn().mockResolvedValue([
      { targetSystem: 'entra-id', externalId: undefined },
      { targetSystem: 'ad', externalId: 'CN=user,OU=Users,DC=corp,DC=local' },
    ]);
    mockActivities.getConnectorConfig = jest.fn().mockResolvedValue({ tenantId: 'test' });
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.markDeleted = jest.fn().mockResolvedValue(undefined);
    // deleteUser completes but the Entra call itself doesn't throw — the workflow catches
    // entra deleteUser doesn't throw, but the result is used only for logging.
    // Looking at the workflow: for entra, `success = true` is set AFTER `entraProxy.deleteUser()`.
    // If we want entra to fail, we should make deleteUser throw.
    mockActivities.deleteUser = jest.fn().mockRejectedValue(new Error('Rate limited'));
    mockActivities.disableAdUser = jest.fn().mockResolvedValue(true);

    const error = (await offboardingWorkflow({
      userId: 'id-789',
      userEmail: 'fail@test.com',
      tenantId: 'test-tenant',
    }).catch((e: unknown) => e)) as Error;

    expect(error.message).toMatch(/^Offboarding partial failure for identity id-789:/);
    // Failure messages stay in clear in the Temporal history (the payload codec covers payloads)
    expect(error.message).not.toContain('fail@test.com');

    expect(mockActivities.markDeleted).not.toHaveBeenCalled();
    // AD succeeded so it should be marked DEPROVISIONED
    expect(mockActivities.setProvisioningStatus).toHaveBeenCalledWith(
      'id-789',
      'ad',
      'DEPROVISIONED',
      undefined,
      'test-tenant',
    );
    // Entra failed so it should NOT be marked DEPROVISIONED
    expect(mockActivities.setProvisioningStatus).not.toHaveBeenCalledWith(
      'id-789',
      'entra-id',
      'DEPROVISIONED',
      expect.anything(),
      expect.anything(),
    );
  });

  it('uses legacy Entra fallback when getProvisionedTargets returns empty', async () => {
    mockActivities.getProvisionedTargets = jest.fn().mockResolvedValue([]);
    mockActivities.getConnectorConfig = jest.fn().mockResolvedValue({ tenantId: 'test' });
    mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.markDeleted = jest.fn().mockResolvedValue(undefined);
    mockActivities.deleteUser = jest.fn().mockResolvedValue({ success: true });

    const result = await offboardingWorkflow({
      userId: 'legacy-id',
      userEmail: 'legacy@test.com',
      tenantId: 'test-tenant',
    });

    expect(result).toContain('Offboarding complete');
    expect(mockActivities.getProvisionedTargets).toHaveBeenCalledWith('legacy-id', 'test-tenant');
    expect(mockActivities.deleteUser).toHaveBeenCalledWith(
      'legacy@test.com',
      expect.anything(),
      'legacy-id',
      'test-tenant',
    );
    expect(mockActivities.markDeleted).toHaveBeenCalledWith('legacy-id', 'test-tenant');
  });

  it('throws InvalidInput when userId is missing', async () => {
    await expect(
      offboardingWorkflow({ userId: '', userEmail: 'test@test.com', tenantId: 'test-tenant' }),
    ).rejects.toThrow(/requires userId and userEmail/);
  });

  it('throws InvalidInput when userEmail is missing', async () => {
    await expect(
      offboardingWorkflow({ userId: 'id-1', userEmail: '', tenantId: 'test-tenant' }),
    ).rejects.toThrow(/requires userId and userEmail/);
  });
});
