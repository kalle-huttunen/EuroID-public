/**
 * offboardingWorkflow after the patch offboarding:per-system-results: every target is attempted
 * and reported (deprovisioned / already-gone / not-applicable / failed with reason), the Golden
 * Record is always updated (deleted, or suspended when a target failed), and the result goes to
 * recordOffboardingOutcome. Pure Jest mocks; the Temporal e2e is
 * test/workflows/offboarding-per-system.workflow.e2e-spec.ts.
 */
const mockActivities: Record<string, jest.Mock> = {};
const stableRefs: Record<string, (...args: unknown[]) => unknown> = {};

class MockActivityFailure extends Error {
  constructor(public readonly cause: Error) {
    super('Activity task failed');
  }
}

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
  patched: jest.fn(() => true),
  workflowInfo: () => ({ workflowId: 't-tenant-a-offboard-id-1' }),
  ActivityFailure: MockActivityFailure,
  ApplicationFailure: {
    nonRetryable: (msg: string, type?: string) => Object.assign(new Error(msg), { type }),
    create: (opts: { message: string; type: string; details: unknown[] }) =>
      Object.assign(new Error(opts.message), { type: opts.type, details: opts.details }),
  },
}));

import { offboardingWorkflow } from './offboarding.workflow';

const TENANT = 'tenant-a';
const WF = 't-tenant-a-offboard-id-1';
const input = { userId: 'id-1', userEmail: 'ada@example.com', tenantId: TENANT };

/**
 * `targets`: what offboarding finds to remove (getOffboardingTargets). `noProvisioningState`
 * defaults to there being none; the pre-patch getProvisionedTargets returns the SYNCED ones.
 */
function reset(
  targets: Array<{ targetSystem: string; externalId?: string; status?: string }>,
  noProvisioningState = targets.length === 0,
) {
  Object.keys(mockActivities).forEach((key) => delete mockActivities[key]);
  // No linked admin accounts (the cascade: offboarding-linked-admins.workflow.e2e-spec.ts)
  mockActivities.getLinkedAdminIdentities = jest.fn().mockResolvedValue([]);
  mockActivities.getOffboardingTargets = jest
    .fn()
    .mockResolvedValue({ noProvisioningState, targets });
  mockActivities.getProvisionedTargets = jest
    .fn()
    .mockResolvedValue(targets.filter((t) => (t.status ?? 'SYNCED') === 'SYNCED'));
  mockActivities.getConnectorConfig = jest
    .fn()
    .mockImplementation(async (id: string) => ({ configFor: id }));
  mockActivities.setProvisioningStatus = jest.fn().mockResolvedValue(undefined);
  mockActivities.markDeleted = jest.fn().mockResolvedValue(undefined);
  mockActivities.suspendIdentity = jest.fn().mockResolvedValue(undefined);
  mockActivities.recordOffboardingOutcome = jest.fn().mockResolvedValue(undefined);
  mockActivities.deleteUser = jest
    .fn()
    .mockResolvedValue({ success: true, outcome: 'deprovisioned' });
  mockActivities.disableAdUser = jest.fn().mockResolvedValue(true);
  mockActivities.deprovisionAdUser = jest
    .fn()
    .mockResolvedValue({ outcome: 'deprovisioned', detail: 'disabled' });
  mockActivities.deprovisionScimUser = jest
    .fn()
    .mockResolvedValue({ success: true, outcome: 'deprovisioned', detail: 'deactivated' });
  mockActivities.deprovisionOktaUser = jest
    .fn()
    .mockResolvedValue({ outcome: 'deprovisioned', detail: 'deactivated' });
  mockActivities.deprovisionGitHubUser = jest
    .fn()
    .mockResolvedValue({ outcome: 'deprovisioned', detail: 'pending invitation cancelled' });
  mockActivities.deprovisionServiceNowUser = jest
    .fn()
    .mockResolvedValue({ outcome: 'deprovisioned', detail: 'deactivated and locked' });
}

const deprovisioned = () =>
  mockActivities.setProvisioningStatus.mock.calls
    .filter(([, , status]) => status === 'DEPROVISIONED')
    .map(([, system]) => system);

describe('offboardingWorkflow (per-system results)', () => {
  it('removes the account in every target with its stored id and reports each system', async () => {
    reset([
      { targetSystem: 'entra', externalId: 'entra-obj-1' },
      { targetSystem: 'ad', externalId: 'CN=Ada,OU=Users,DC=corp,DC=example' },
      { targetSystem: 'scim', externalId: 'scim-1' },
      { targetSystem: 'okta', externalId: 'okta-1' },
      { targetSystem: 'github', externalId: 'github-user-583231' },
      { targetSystem: 'servicenow', externalId: 'snow-abc' },
      { targetSystem: 'discord-webhook' },
      { targetSystem: 'google-sheets' },
      { targetSystem: 'file-outbound' },
    ]);

    const result = await offboardingWorkflow(input);

    expect(mockActivities.deleteUser).toHaveBeenCalledWith(
      'entra-obj-1',
      { configFor: 'entra-id' },
      'id-1',
      TENANT,
      WF,
      false,
    );
    // The identity id last: the activity's provisioning.deprovisioned goes under it
    expect(mockActivities.deprovisionAdUser).toHaveBeenCalledWith(
      'CN=Ada,OU=Users,DC=corp,DC=example',
      { configFor: 'ad' },
      TENANT,
      WF,
      'id-1',
    );
    expect(mockActivities.disableAdUser).not.toHaveBeenCalled();
    expect(mockActivities.deprovisionScimUser).toHaveBeenCalledWith(
      { configFor: 'scim' },
      'scim-1',
      TENANT,
      WF,
      'ada@example.com',
      'id-1',
    );
    expect(mockActivities.deprovisionOktaUser).toHaveBeenCalledWith(
      'okta-1',
      'ada@example.com',
      TENANT,
      WF,
      'id-1',
    );
    // The account id and the identity id; the activity reads the GitHub login (not history)
    expect(mockActivities.deprovisionGitHubUser).toHaveBeenCalledWith(
      'ada@example.com',
      TENANT,
      WF,
      'github-user-583231',
      'id-1',
    );
    expect(mockActivities.deprovisionServiceNowUser).toHaveBeenCalledWith(
      'snow-abc',
      'ada@example.com',
      TENANT,
      WF,
      'id-1',
    );
    expect(result).toEqual({
      identityId: 'id-1',
      workflowId: WF,
      status: 'completed',
      hubStatus: 'deleted',
      systems: [
        { system: 'entra', outcome: 'deprovisioned', detail: 'deleted' },
        { system: 'ad', outcome: 'deprovisioned', detail: 'disabled' },
        { system: 'scim', outcome: 'deprovisioned', detail: 'deactivated' },
        { system: 'okta', outcome: 'deprovisioned', detail: 'deactivated' },
        { system: 'github', outcome: 'deprovisioned', detail: 'pending invitation cancelled' },
        { system: 'servicenow', outcome: 'deprovisioned', detail: 'deactivated and locked' },
        { system: 'discord-webhook', outcome: 'not-applicable', reason: expect.any(String) },
        { system: 'google-sheets', outcome: 'not-applicable', reason: expect.any(String) },
        { system: 'file-outbound', outcome: 'not-applicable', reason: expect.any(String) },
      ],
    });
    expect(deprovisioned()).toEqual(['entra', 'ad', 'scim', 'okta', 'github', 'servicenow']);
    expect(mockActivities.markDeleted).toHaveBeenCalledWith('id-1', TENANT);
    expect(mockActivities.suspendIdentity).not.toHaveBeenCalled();
    expect(mockActivities.recordOffboardingOutcome).toHaveBeenCalledWith(result, TENANT);
  });

  it('reports an account the target no longer has as already gone and still deletes the Hub', async () => {
    reset([{ targetSystem: 'entra-id' }, { targetSystem: 'okta' }]);
    mockActivities.deleteUser.mockResolvedValue({ success: true, outcome: 'already-gone' });
    mockActivities.deprovisionOktaUser.mockResolvedValue({
      outcome: 'already-gone',
      detail: 'no such user',
    });

    const result = await offboardingWorkflow(input);

    // No account record: Entra by email (UPN, then mail), Okta looked up by login
    expect(mockActivities.deleteUser.mock.calls[0][0]).toBe('ada@example.com');
    expect(mockActivities.deleteUser.mock.calls[0][5]).toBe(true);
    expect(mockActivities.deprovisionOktaUser.mock.calls[0][0]).toBeUndefined();
    expect(result).toMatchObject({
      status: 'completed',
      systems: [
        { system: 'entra-id', outcome: 'already-gone', detail: 'no such user' },
        { system: 'okta', outcome: 'already-gone', detail: 'no such user' },
      ],
    });
    expect(deprovisioned()).toEqual(['entra-id', 'okta']);
    expect(mockActivities.markDeleted).toHaveBeenCalled();
  });

  it('attempts every target when one fails, suspends the Golden Record and fails with the result', async () => {
    reset([{ targetSystem: 'github' }, { targetSystem: 'okta', externalId: 'okta-1' }]);
    mockActivities.deprovisionGitHubUser.mockRejectedValue(
      new MockActivityFailure(new Error('github: No pending or failed GitHub invitation')),
    );

    const error = (await offboardingWorkflow(input).catch((e: unknown) => e)) as Error & {
      type: string;
      details: unknown[];
    };

    expect(error.type).toBe('OffboardingPartialFailure');
    expect(error.message).toContain('github: No pending or failed GitHub invitation');
    // No account id recorded: still the identity id, so the activity can read the GitHub login
    expect(mockActivities.deprovisionGitHubUser).toHaveBeenCalledWith(
      'ada@example.com',
      TENANT,
      WF,
      undefined,
      'id-1',
    );
    expect(mockActivities.deprovisionOktaUser).toHaveBeenCalledTimes(1);
    const recorded = mockActivities.recordOffboardingOutcome.mock.calls[0][0];
    expect(recorded).toEqual({
      identityId: 'id-1',
      workflowId: WF,
      status: 'partial-failure',
      hubStatus: 'suspended',
      systems: [
        {
          system: 'github',
          outcome: 'failed',
          reason: 'github: No pending or failed GitHub invitation',
        },
        { system: 'okta', outcome: 'deprovisioned', detail: 'deactivated' },
      ],
    });
    expect(error.details).toEqual([recorded]);
    expect(deprovisioned()).toEqual(['okta']);
    expect(mockActivities.suspendIdentity).toHaveBeenCalledWith('id-1', TENANT);
    expect(mockActivities.markDeleted).not.toHaveBeenCalled();
  });

  it('marks a never-provisioned identity deleted without calling Entra when no Entra connector exists', async () => {
    reset([]);
    mockActivities.getConnectorConfig.mockResolvedValue(null);

    const result = await offboardingWorkflow(input);

    expect(mockActivities.getConnectorConfig).toHaveBeenCalledWith('entra-id', TENANT, WF);
    expect(mockActivities.deleteUser).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'completed', hubStatus: 'deleted', systems: [] });
    expect(mockActivities.markDeleted).toHaveBeenCalledWith('id-1', TENANT);
    expect(mockActivities.recordOffboardingOutcome).toHaveBeenCalledWith(result, TENANT);
  });

  it('tries Entra ID for a never-provisioned identity when an Entra connector is configured', async () => {
    reset([]);

    const result = await offboardingWorkflow(input);

    expect(mockActivities.getConnectorConfig).toHaveBeenCalledTimes(1);
    // No object id: the activity must look the user up by mail before reporting it gone
    expect(mockActivities.deleteUser).toHaveBeenCalledWith(
      'ada@example.com',
      { configFor: 'entra-id' },
      'id-1',
      TENANT,
      WF,
      true,
    );
    expect(result).toMatchObject({ systems: [{ system: 'entra-id', outcome: 'deprovisioned' }] });
  });

  it('fails a target it cannot reach or does not know, with the reason', async () => {
    reset([
      { targetSystem: 'ad' },
      { targetSystem: 'scim', externalId: 'scim-1' },
      { targetSystem: 'salesforce' },
    ]);
    mockActivities.getConnectorConfig.mockImplementation(async (id: string) =>
      id === 'scim' ? null : { configFor: id },
    );

    const error = (await offboardingWorkflow(input).catch((e: unknown) => e)) as {
      details: Array<{ systems: unknown[] }>;
    };

    expect(error.details[0].systems).toEqual([
      {
        system: 'ad',
        outcome: 'failed',
        reason: 'no AD distinguished name recorded for the account',
      },
      {
        system: 'scim',
        outcome: 'failed',
        reason: 'SCIM connector config not found on the canvas',
      },
      {
        system: 'salesforce',
        outcome: 'failed',
        reason: 'offboarding has no deprovision for this target',
      },
    ]);
    expect(mockActivities.disableAdUser).not.toHaveBeenCalled();
    expect(mockActivities.deprovisionAdUser).not.toHaveBeenCalled();
    expect(mockActivities.deprovisionScimUser).not.toHaveBeenCalled();
    expect(mockActivities.suspendIdentity).toHaveBeenCalled();
  });

  describe('targets not SYNCED and the Entra fallback (offboarding:unsynced-targets)', () => {
    const patched = jest.requireMock('@temporalio/workflow').patched as jest.Mock;
    afterEach(() => patched.mockImplementation(() => true));

    it('deprovisions SYNCING and ERROR entries the connector can find, without the Entra fallback', async () => {
      reset([
        { targetSystem: 'okta', status: 'ERROR' },
        { targetSystem: 'scim', externalId: 'scim-1', status: 'SYNCING' },
      ]);

      const result = await offboardingWorkflow(input);

      expect(mockActivities.getOffboardingTargets).toHaveBeenCalledWith('id-1', TENANT);
      expect(mockActivities.getProvisionedTargets).not.toHaveBeenCalled();
      expect(mockActivities.deprovisionOktaUser).toHaveBeenCalledTimes(1);
      expect(mockActivities.deprovisionScimUser).toHaveBeenCalledTimes(1);
      expect(mockActivities.deleteUser).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status: 'completed',
        systems: [
          { system: 'okta', outcome: 'deprovisioned' },
          { system: 'scim', outcome: 'deprovisioned' },
        ],
      });
      expect(deprovisioned()).toEqual(['okta', 'scim']);
    });

    it('reports an unfinished entry it cannot clear as failed, saying provisioning never completed', async () => {
      reset([{ targetSystem: 'okta', status: 'ERROR' }]);
      mockActivities.deprovisionOktaUser.mockRejectedValue(
        new MockActivityFailure(new Error('okta: No Okta user has the login')),
      );

      const error = (await offboardingWorkflow(input).catch((e: unknown) => e)) as {
        details: Array<{ systems: unknown[] }>;
      };

      expect(error.details[0].systems).toEqual([
        {
          system: 'okta',
          outcome: 'failed',
          reason:
            'provisioning to this target never completed (ERROR): okta: No Okta user has the login',
        },
      ]);
      expect(mockActivities.suspendIdentity).toHaveBeenCalled();
    });

    it("reports an admin identity's DEPROVISIONED entry it cannot clear without the unfinished-provisioning note", async () => {
      // An admin identity's entry a PAM deactivation marked DEPROVISIONED (getOffboardingTargets)
      reset([{ targetSystem: 'okta', status: 'DEPROVISIONED' }]);
      mockActivities.deprovisionOktaUser.mockRejectedValue(
        new MockActivityFailure(new Error('okta: No Okta user has the login')),
      );

      const error = (await offboardingWorkflow(input).catch((e: unknown) => e)) as {
        details: Array<{ systems: unknown[] }>;
      };

      expect(error.details[0].systems).toEqual([
        { system: 'okta', outcome: 'failed', reason: 'okta: No Okta user has the login' },
      ]);
    });

    it('removes nothing more on a rerun once every target is DEPROVISIONED (no Entra fallback)', async () => {
      reset([], false);

      const result = await offboardingWorkflow(input);

      expect(mockActivities.getConnectorConfig).not.toHaveBeenCalled();
      expect(mockActivities.deleteUser).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'completed', hubStatus: 'deleted', systems: [] });
      expect(mockActivities.markDeleted).toHaveBeenCalledWith('id-1', TENANT);
    });

    it('keeps the pre-patch discovery for histories recorded before the patch', async () => {
      patched.mockImplementation((id: string) => id !== 'offboarding:unsynced-targets');
      reset([{ targetSystem: 'okta', status: 'ERROR' }]);

      const result = await offboardingWorkflow(input);

      expect(mockActivities.getOffboardingTargets).not.toHaveBeenCalled();
      expect(mockActivities.getProvisionedTargets).toHaveBeenCalledWith('id-1', TENANT);
      expect(mockActivities.deprovisionOktaUser).not.toHaveBeenCalled();
      expect(mockActivities.deleteUser).toHaveBeenCalledTimes(1); // the old Entra fallback
      expect(result).toMatchObject({ systems: [{ system: 'entra-id' }] });
    });
  });

  describe('linked admin accounts (offboarding:linked-admin-cascade)', () => {
    const patched = jest.requireMock('@temporalio/workflow').patched as jest.Mock;
    afterEach(() => patched.mockImplementation(() => true));

    it("looks up the person's linked admin identities before the person's own targets", async () => {
      reset([{ targetSystem: 'okta', externalId: 'okta-1' }]);
      const order: string[] = [];
      mockActivities.getLinkedAdminIdentities.mockImplementation(async () => {
        order.push('linked-admins');
        return [];
      });
      mockActivities.getOffboardingTargets.mockImplementation(async () => {
        order.push('targets');
        return { noProvisioningState: false, targets: [{ targetSystem: 'okta' }] };
      });

      mockActivities.markDeleted.mockImplementation(async () => {
        order.push('mark-deleted');
      });

      const result = await offboardingWorkflow(input);

      expect(mockActivities.getLinkedAdminIdentities).toHaveBeenCalledWith('id-1', TENANT, WF);
      // Looked up again right before the person is deleted: none may be live by then
      expect(order).toEqual(['linked-admins', 'targets', 'linked-admins', 'mark-deleted']);
      // None found: the result has no linkedAdmins, as before the cascade
      expect(result).not.toHaveProperty('linkedAdmins');
    });

    it('keeps the person suspended when a linked admin identity is live right before the delete', async () => {
      reset([{ targetSystem: 'okta', externalId: 'okta-1' }]);
      // None when the run started; one linked while it ran
      mockActivities.getLinkedAdminIdentities
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ identityId: 'adm-9', email: 'adm-ada@example.com' }]);

      const error = await offboardingWorkflow(input).catch((e: unknown) => e);

      expect(error).toMatchObject({ type: 'OffboardingPartialFailure' });
      expect((error as Error).message).toContain('1 linked admin account(s) failed');
      expect((error as Error).message).toContain('linked admin identity adm-9: still live');
      expect(mockActivities.markDeleted).not.toHaveBeenCalled();
      expect(mockActivities.suspendIdentity).toHaveBeenCalledWith('id-1', TENANT);
      const result = {
        identityId: 'id-1',
        workflowId: WF,
        status: 'partial-failure',
        hubStatus: 'suspended',
        systems: [{ system: 'okta', outcome: 'deprovisioned', detail: 'deactivated' }],
        linkedAdmins: [
          {
            identityId: 'adm-9',
            workflowId: 't-tenant-a-offboard-adm-9',
            outcome: 'failed',
            reason: expect.stringContaining("rerun the person's offboarding"),
          },
        ],
      };
      expect((error as { details: unknown[] }).details[0]).toEqual(result);
      expect(mockActivities.recordOffboardingOutcome).toHaveBeenCalledWith(result, TENANT);
    });

    it('leaves linked admin accounts alone for histories recorded before the patch', async () => {
      patched.mockImplementation((id: string) => id !== 'offboarding:linked-admin-cascade');
      reset([{ targetSystem: 'okta', externalId: 'okta-1' }]);

      await offboardingWorkflow(input);

      expect(mockActivities.getLinkedAdminIdentities).not.toHaveBeenCalled();
      expect(mockActivities.markDeleted).toHaveBeenCalledWith('id-1', TENANT);
    });
  });

  describe('AD outcome (offboarding:ad-deprovision-outcome)', () => {
    const patched = jest.requireMock('@temporalio/workflow').patched as jest.Mock;
    afterEach(() => patched.mockImplementation(() => true));
    const dn = 'CN=Ada,OU=Users,DC=corp,DC=example';

    it('reports a DN AD no longer has as already gone and still deletes the Hub', async () => {
      reset([{ targetSystem: 'ad', externalId: dn }]);
      mockActivities.deprovisionAdUser.mockResolvedValue({
        outcome: 'already-gone',
        detail: 'no such object',
      });

      const result = await offboardingWorkflow(input);

      expect(result).toMatchObject({
        status: 'completed',
        systems: [{ system: 'ad', outcome: 'already-gone', detail: 'no such object' }],
      });
      expect(deprovisioned()).toEqual(['ad']);
      expect(mockActivities.markDeleted).toHaveBeenCalled();
    });

    it('keeps disableAdUser for histories recorded before the patch', async () => {
      patched.mockImplementation((id: string) => id !== 'offboarding:ad-deprovision-outcome');
      reset([{ targetSystem: 'ad', externalId: dn }]);

      const result = await offboardingWorkflow(input);

      expect(mockActivities.deprovisionAdUser).not.toHaveBeenCalled();
      expect(mockActivities.disableAdUser).toHaveBeenCalledWith(
        dn,
        { configFor: 'ad' },
        TENANT,
        WF,
      );
      expect(result).toMatchObject({
        systems: [{ system: 'ad', outcome: 'deprovisioned', detail: 'disabled' }],
      });
    });
  });
});
