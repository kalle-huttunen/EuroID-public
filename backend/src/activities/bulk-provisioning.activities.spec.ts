import type { ActivityExecuteInput } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { BulkProvisioningActivities } from './bulk-provisioning.activities';
import {
  RATE_LIMITED_FAILURE_TYPE,
  RateLimitedException,
} from '@shared/errors/rate-limited.exception';
import { RateLimitActivityInterceptor } from '@infrastructure/temporal/rate-limit-activity.interceptor';
import { BulkOperationType, OperationPriority } from '@shared/dtos/bulk-operation.dto';
import type { BulkOperationInput } from '@shared/dtos/bulk-operation.dto';
import { createMockUser } from '@testing';
import { validateActivityContext } from '@shared/utils/activity-context';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';

type Ctor = ConstructorParameters<typeof BulkProvisioningActivities>;

describe('BulkProvisioningActivities.executeOperation rate-limit hits', () => {
  let rateLimiter: { checkAndWait: jest.Mock; recordApiCalls: jest.Mock };
  let fileOutbound: { create: jest.Mock };
  let github: { create: jest.Mock };
  let entra: { provisionUserToEntra: jest.Mock };
  let activities: BulkProvisioningActivities;

  const operation = (targetSystems: string[]): BulkOperationInput =>
    ({
      id: 'op-1',
      type: BulkOperationType.CREATE,
      user: createMockUser({ email: 'ada@example.com' }),
      targetSystems,
      priority: OperationPriority.NORMAL,
    }) as unknown as BulkOperationInput;

  beforeEach(() => {
    rateLimiter = {
      checkAndWait: jest.fn().mockResolvedValue(0),
      recordApiCalls: jest.fn().mockResolvedValue(undefined),
    };
    fileOutbound = { create: jest.fn().mockResolvedValue({ targetUserId: 'f-1' }) };
    github = { create: jest.fn().mockResolvedValue({ targetUserId: 'g-1' }) };
    entra = { provisionUserToEntra: jest.fn().mockResolvedValue({ success: true }) };
    activities = new BulkProvisioningActivities(
      entra as unknown as Ctor[0],
      { saveToHub: jest.fn().mockResolvedValue(undefined) } as unknown as Ctor[1],
      rateLimiter as unknown as Ctor[2],
      {} as Ctor[3],
      fileOutbound as unknown as Ctor[4],
      {} as Ctor[5],
      github as unknown as Ctor[6],
      {} as Ctor[7],
      { captureUserState: jest.fn().mockResolvedValue({ existed: false }) } as unknown as Ctor[8],
      { save: jest.fn(), load: jest.fn() } as unknown as Ctor[9],
      {} as Ctor[10],
    );
  });

  it('reports zero hits when the limiter never throttles and no target answers 429', async () => {
    const result = await activities.executeOperation(
      operation(['file-outbound', 'github']),
      'tenant-a',
      'corr-1',
    );

    expect(result.success).toBe(true);
    expect(result.rateLimitHits).toBe(0);
  });

  it('counts rate limiter throttles per target system', async () => {
    rateLimiter.checkAndWait.mockImplementation(async (system: string) =>
      system === 'file-outbound' ? 1500 : 0,
    );

    const result = await activities.executeOperation(
      operation(['file-outbound', 'github']),
      'tenant-a',
      'corr-1',
    );

    expect(result.success).toBe(true);
    expect(result.rateLimitHits).toBe(1);
  });

  it.each([
    ['github', () => github.create],
    ['entra-id', () => entra.provisionUserToEntra],
  ])(
    'lets a 429 from %s fail the activity as a retryable failure with the retry-after delay',
    async (system, target) => {
      target().mockRejectedValue(new RateLimitedException(2000, system));
      const interceptor = new RateLimitActivityInterceptor();

      const execution = interceptor.execute({} as ActivityExecuteInput, () =>
        activities.executeOperation(operation(['file-outbound', system]), 'tenant-a', 'corr-1'),
      );

      await expect(execution).rejects.toBeInstanceOf(ApplicationFailure);
      await expect(execution).rejects.toMatchObject({
        type: RATE_LIMITED_FAILURE_TYPE,
        nonRetryable: false,
        nextRetryDelay: 2000,
      });
    },
  );

  it('executeSystemOperation calls only its own system, so a 429 retry repeats only that system', async () => {
    github.create.mockRejectedValue(new RateLimitedException(2000, 'github'));
    const interceptor = new RateLimitActivityInterceptor();

    const fileOutcome = await activities.executeSystemOperation(
      operation(['file-outbound', 'github']),
      'file-outbound',
      'tenant-a',
      'corr-1',
    );
    const githubAttempt = interceptor.execute({} as ActivityExecuteInput, () =>
      activities.executeSystemOperation(
        operation(['file-outbound', 'github']),
        'github',
        'tenant-a',
        'corr-1',
      ),
    );

    expect(fileOutcome).toEqual({
      result: expect.objectContaining({ system: 'file-outbound', success: true, objectId: 'f-1' }),
      rateLimitHits: 0,
    });
    await expect(githubAttempt).rejects.toMatchObject({
      type: RATE_LIMITED_FAILURE_TYPE,
      nextRetryDelay: 2000,
    });
    expect(fileOutbound.create).toHaveBeenCalledTimes(1);
    expect(github.create).toHaveBeenCalledTimes(1);
  });

  it('does not count ordinary target failures as rate-limit hits', async () => {
    github.create.mockRejectedValue(new Error('validation failed'));

    const result = await activities.executeOperation(operation(['github']), 'tenant-a', 'corr-1');

    expect(result.success).toBe(false);
    expect(result.rateLimitHits).toBe(0);
  });
});

describe('BulkProvisioningActivities tenant context for Entra and the Hub', () => {
  // Like the real activities: without a tenantId they throw "[SECURITY] tenantId is required".
  const requireTenantAt = (index: number, value: unknown) =>
    jest.fn(async (...args: unknown[]) => {
      validateActivityContext({ tenantId: (args[index] as string | undefined) ?? '' });
      return value;
    });

  let entra: {
    provisionUserToEntra: jest.Mock;
    disableEntraUser: jest.Mock;
    deleteUser: jest.Mock;
  };
  let identity: { saveToHub: jest.Mock };
  let entraService: {
    captureUserState: jest.Mock;
    disableUser: jest.Mock;
    restoreUserState: jest.Mock;
    checkUserExists: jest.Mock;
    getCredentialState: jest.Mock;
  };
  let snapshots: { save: jest.Mock; load: jest.Mock };
  let identityService: {
    saveOrUpdateReportingCreated: jest.Mock;
    findIdentityBySourceKey: jest.Mock;
    findIdentityByEmail: jest.Mock;
    recordTargetAccountId: jest.Mock;
    findIdentityById: jest.Mock;
    updateProvisioningState: jest.Mock;
  };
  let activities: BulkProvisioningActivities;
  const user = createMockUser({ email: 'ada@example.com' });
  /** Calls made under a tenant context, with that tenant: [method, tenantId]. */
  const tenantCalls: Array<[string, string]> = [];
  const underTenant = (name: string, value: unknown) =>
    jest.fn(async () => {
      tenantCalls.push([name, getCurrentTenantId()]);
      return value;
    });

  const entraOperation = (type: BulkOperationType): BulkOperationInput =>
    ({
      id: 'op-1',
      type,
      user,
      targetSystems: ['entra-id'],
      priority: OperationPriority.NORMAL,
    }) as unknown as BulkOperationInput;

  beforeEach(() => {
    entra = {
      provisionUserToEntra: requireTenantAt(3, { success: true, objectId: 'entra-1' }),
      disableEntraUser: requireTenantAt(1, true),
      deleteUser: requireTenantAt(3, { success: true }),
    };
    identity = { saveToHub: requireTenantAt(1, 'hub-1') };
    tenantCalls.length = 0;
    entraService = {
      captureUserState: underTenant('captureUserState', { existed: false }),
      disableUser: underTenant('disableUser', true),
      restoreUserState: underTenant('restoreUserState', undefined),
      checkUserExists: jest.fn().mockResolvedValue('entra-1'),
      getCredentialState: jest.fn().mockResolvedValue({ accountEnabled: true }),
    };
    snapshots = { save: jest.fn().mockResolvedValue('snap-1'), load: jest.fn() };
    identityService = {
      saveOrUpdateReportingCreated: jest.fn(),
      findIdentityBySourceKey: jest.fn().mockResolvedValue(null),
      findIdentityByEmail: jest.fn().mockResolvedValue(null),
      recordTargetAccountId: jest.fn().mockResolvedValue('recorded'),
      findIdentityById: jest.fn().mockResolvedValue({ _id: 'identity-1', provisioning: [] }),
      updateProvisioningState: jest.fn().mockResolvedValue(null),
    };
    activities = new BulkProvisioningActivities(
      entra as unknown as Ctor[0],
      identity as unknown as Ctor[1],
      {
        checkAndWait: jest.fn().mockResolvedValue(0),
        recordApiCalls: jest.fn().mockResolvedValue(undefined),
      } as unknown as Ctor[2],
      {} as Ctor[3],
      {} as Ctor[4],
      {} as Ctor[5],
      {} as Ctor[6],
      {} as Ctor[7],
      entraService as unknown as Ctor[8],
      snapshots as unknown as Ctor[9],
      identityService as unknown as Ctor[10],
    );
  });

  it.each([BulkOperationType.CREATE, BulkOperationType.UPDATE])(
    'provisions %s to Entra under the operation tenant',
    async (type) => {
      const result = await activities.executeOperation(entraOperation(type), 'tenant-a', 'corr-1');

      expect(result.success).toBe(true);
      expect(result.systemResults).toEqual([
        expect.objectContaining({
          system: 'entra-id',
          success: true,
          objectId: 'entra-1',
          previousState: { existed: false },
        }),
      ]);
      expect(tenantCalls).toEqual([['captureUserState', 'tenant-a']]);
      expect(entraService.captureUserState.mock.invocationCallOrder[0]).toBeLessThan(
        entra.provisionUserToEntra.mock.invocationCallOrder[0],
      );
      expect(identity.saveToHub).toHaveBeenCalledWith(user, 'tenant-a', 'corr-1');
      expect(entra.provisionUserToEntra).toHaveBeenCalledWith(
        user,
        undefined,
        undefined,
        'tenant-a',
        'corr-1',
      );
    },
  );

  // The id of the identity the operation's Golden Record write saved (result.hubWrite): the
  // Entra provisioning events go under it and reach the identity timeline (2.8a), never the email
  it.each([BulkOperationType.CREATE, BulkOperationType.UPDATE])(
    'provisions %s to Entra with the saved identity id on the profile',
    async (type) => {
      snapshots.load.mockResolvedValue({ existed: false });
      const { result } = await activities.executeSystemOperation(
        entraOperation(type),
        'entra-id',
        'tenant-a',
        'corr-1',
        'run-1/op-1/entra-id',
        'identity-1',
      );

      expect(result).toEqual(expect.objectContaining({ success: true, objectId: 'entra-1' }));
      expect(entra.provisionUserToEntra).toHaveBeenCalledWith(
        { ...user, _id: 'identity-1' },
        undefined,
        undefined,
        'tenant-a',
        'corr-1',
      );
      // The operation itself (and so the workflow history) is unchanged
      expect(entraService.captureUserState).toHaveBeenCalledWith(user);
    },
  );

  // HX-E3: bulk provisioning recorded no object id, so access requests for the people it made
  // accounts for ended REJECTED ("No Entra ID account is recorded")
  it('records the object id of the account a CREATE made for the saved identity', async () => {
    snapshots.load.mockResolvedValue({ existed: false });
    identityService.recordTargetAccountId.mockImplementation(async () => {
      tenantCalls.push(['recordTargetAccountId', getCurrentTenantId()]);
      return 'recorded';
    });

    const { result } = await activities.executeSystemOperation(
      entraOperation(BulkOperationType.CREATE),
      'entra-id',
      'tenant-a',
      'corr-1',
      'run-1/op-1/entra-id',
      'identity-1',
    );

    expect(result).toEqual(expect.objectContaining({ success: true, objectId: 'entra-1' }));
    expect(identityService.recordTargetAccountId).toHaveBeenCalledWith(
      'identity-1',
      'entra-id',
      'entra-1',
    );
    expect(tenantCalls).toContainEqual(['recordTargetAccountId', 'tenant-a']);
  });

  // HX-E4: no Entra ID provisioning entry was written, so provisionedSystems never listed
  // Entra ID for the people a bulk run provisioned
  it.each([BulkOperationType.CREATE, BulkOperationType.UPDATE])(
    "marks the saved identity's Entra ID entry SYNCED after a %s, under the operation tenant",
    async (type) => {
      // The keyed pre-change snapshot is read back after it is stored (sealSnapshotOnce)
      snapshots.load.mockResolvedValue({ existed: false });
      identityService.updateProvisioningState.mockImplementation(async () => {
        tenantCalls.push(['updateProvisioningState', getCurrentTenantId()]);
        return null;
      });

      await activities.executeSystemOperation(
        entraOperation(type),
        'entra-id',
        'tenant-a',
        'corr-1',
        'run-1/op-1/entra-id',
        'identity-1',
      );

      expect(identityService.updateProvisioningState).toHaveBeenCalledWith(
        'identity-1',
        'entra-id',
        'SYNCED',
      );
      expect(tenantCalls).toContainEqual(['updateProvisioningState', 'tenant-a']);
    },
  );

  it('writes no Entra ID entry when the provisioning failed', async () => {
    snapshots.load.mockResolvedValue({ existed: false });
    // The activities hold this object: the provisioning now fails
    entra.provisionUserToEntra = jest.fn().mockRejectedValue(new Error('Graph 400'));

    const { result } = await activities.executeSystemOperation(
      entraOperation(BulkOperationType.CREATE),
      'entra-id',
      'tenant-a',
      'corr-1',
      'run-1/op-1/entra-id',
      'identity-1',
    );

    expect(result.success).toBe(false);
    expect(identityService.updateProvisioningState).not.toHaveBeenCalled();
  });

  it('keeps a CREATE done when its object id cannot be recorded', async () => {
    identityService.recordTargetAccountId.mockRejectedValue(new Error('mongo down'));

    const { result } = await activities.executeSystemOperation(
      entraOperation(BulkOperationType.CREATE),
      'entra-id',
      'tenant-a',
      'corr-1',
      undefined,
      'identity-1',
    );

    expect(result).toEqual(expect.objectContaining({ success: true, objectId: 'entra-1' }));
  });

  // An UPDATE provisions the same way (it creates the account when none is found), so it records
  // the account too; a DISABLE or DELETE writes no Hub record and records nothing
  it('records the account of an UPDATE too, and nothing for a DISABLE', async () => {
    await activities.executeSystemOperation(
      entraOperation(BulkOperationType.UPDATE),
      'entra-id',
      'tenant-a',
      'corr-1',
      undefined,
      'identity-1',
    );
    await activities.executeSystemOperation(
      entraOperation(BulkOperationType.DISABLE),
      'entra-id',
      'tenant-a',
      'corr-1',
      undefined,
      'identity-1',
    );

    expect(identityService.recordTargetAccountId.mock.calls).toEqual([
      ['identity-1', 'entra-id', 'entra-1'],
    ]);
  });

  it('disables the Entra user under the operation tenant', async () => {
    const result = await activities.executeOperation(
      entraOperation(BulkOperationType.DISABLE),
      'tenant-a',
      'corr-1',
    );

    expect(result.success).toBe(true);
    expect(entra.disableEntraUser).toHaveBeenCalledWith('ada@example.com', 'tenant-a', 'corr-1');
  });

  // Hunt 2026-11-25 02 F8: the DISABLE took no pre-change state, and the rollback enabled every
  // account, also one disabled before the batch (a leaver, a security hold)
  describe('a DISABLE and the state before it', () => {
    const disable = () =>
      activities.executeSystemOperation(
        entraOperation(BulkOperationType.DISABLE),
        'entra-id',
        'tenant-a',
        'corr-1',
        'run-1/op-1/entra-id',
      );

    it('changes nothing for an account disabled before the batch, so no rollback enables it', async () => {
      snapshots.load.mockResolvedValue({
        existed: true,
        objectId: 'entra-1',
        attributes: { accountEnabled: false },
      });

      const { result } = await disable();

      expect(result).toEqual(
        expect.objectContaining({ system: 'entra-id', success: true, skipped: true }),
      );
      expect(entra.disableEntraUser).not.toHaveBeenCalled();
      const outcome = await activities.compensateOperation(
        {
          operationId: 'op-1',
          success: true,
          type: BulkOperationType.DISABLE,
          userId: 'ada',
          email: 'ada@example.com',
          systemResults: [result],
          startedAt: new Date(0),
          completedAt: new Date(0),
          durationMs: 0,
        },
        'tenant-a',
        'corr-1',
      );
      expect(outcome.systems).toEqual([]);
    });

    it('keeps the state its first attempt read, so a retry after the disable still disables', async () => {
      // The account is disabled now (a first attempt did it), but was enabled before it
      entraService.getCredentialState.mockResolvedValue({ accountEnabled: false });
      snapshots.load.mockResolvedValue({
        existed: true,
        objectId: 'entra-1',
        attributes: { accountEnabled: true },
      });

      const { result } = await disable();

      expect(snapshots.save).toHaveBeenCalledWith(
        'tenant-a',
        'entra-state',
        { existed: true, objectId: 'entra-1', attributes: { accountEnabled: false } },
        'run-1/op-1/entra-id',
      );
      expect(entra.disableEntraUser).toHaveBeenCalledWith('ada@example.com', 'tenant-a', 'corr-1');
      expect(result).toEqual(expect.objectContaining({ success: true }));
      expect(result.skipped).toBeUndefined();
    });
  });

  // Hunt 2026-11-25 02 F9: a provisioning step that failed after the account was made lost the
  // snapshot, so the rollback skipped the account
  it('keeps the snapshot on a CREATE that failed after the change began', async () => {
    snapshots.load.mockResolvedValue({ existed: false });
    entra.provisionUserToEntra.mockRejectedValue(new Error('group step failed'));

    const { result } = await activities.executeSystemOperation(
      entraOperation(BulkOperationType.CREATE),
      'entra-id',
      'tenant-a',
      'corr-1',
      'run-1/op-1/entra-id',
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: 'group step failed',
        previousState: { existed: false },
      }),
    );
  });

  it('rolls back an Entra CREATE by disabling the created account under the operation tenant', async () => {
    const created = await activities.executeOperation(
      entraOperation(BulkOperationType.CREATE),
      'tenant-a',
      'corr-1',
    );

    const outcome = await activities.compensateOperation(created, 'tenant-a', 'corr-1');

    expect(outcome).toEqual({
      rolledBack: true,
      reason: 'Batch failed, compensating transaction',
      systems: [{ system: 'entra-id', rolledBack: true, reason: 'created account disabled' }],
    });
    expect(entraService.disableUser).toHaveBeenCalledWith('entra-1');
    expect(tenantCalls).toContainEqual(['disableUser', 'tenant-a']);
    expect(entra.disableEntraUser).not.toHaveBeenCalled();
  });

  it('keeps rollbackOperation as the boolean form for older workflow histories', async () => {
    const created = await activities.executeOperation(
      entraOperation(BulkOperationType.CREATE),
      'tenant-a',
      'corr-1',
    );
    const deleted = await activities.executeOperation(
      entraOperation(BulkOperationType.DELETE),
      'tenant-a',
      'corr-1',
    );

    await expect(activities.rollbackOperation(created, 'tenant-a', 'corr-1')).resolves.toBe(true);
    await expect(activities.rollbackOperation(deleted, 'tenant-a', 'corr-1')).resolves.toBe(false);
  });

  it('deletes the Entra user under the operation tenant', async () => {
    const result = await activities.executeOperation(
      entraOperation(BulkOperationType.DELETE),
      'tenant-a',
      'corr-1',
    );

    expect(result.success).toBe(true);
    expect(result.systemResults).toEqual([
      expect.objectContaining({ system: 'entra-id', success: true, apiCallsUsed: 1 }),
    ]);
    expect(entra.deleteUser).toHaveBeenCalledWith(
      'ada@example.com',
      undefined,
      undefined,
      'tenant-a',
      'corr-1',
    );
    expect(entra.disableEntraUser).not.toHaveBeenCalled();
  });

  it('records a refused Entra delete as a failed system result', async () => {
    entra.deleteUser.mockRejectedValue(new Error('Insufficient privileges'));

    const result = await activities.executeOperation(
      entraOperation(BulkOperationType.DELETE),
      'tenant-a',
      'corr-1',
    );

    expect(result.success).toBe(false);
    expect(result.systemResults).toEqual([
      expect.objectContaining({
        system: 'entra-id',
        success: false,
        error: 'Insufficient privileges',
      }),
    ]);
  });

  it('reports an Entra DELETE as not rolled back and calls Entra no further', async () => {
    const deleted = await activities.executeOperation(
      entraOperation(BulkOperationType.DELETE),
      'tenant-a',
      'corr-1',
    );
    entra.deleteUser.mockClear();

    const rolledBack = await activities.rollbackOperation(deleted, 'tenant-a', 'corr-1');

    expect(rolledBack).toBe(false);
    expect(entra.deleteUser).not.toHaveBeenCalled();
    expect(entra.disableEntraUser).not.toHaveBeenCalled();
    expect(entra.provisionUserToEntra).not.toHaveBeenCalled();
  });

  describe('the pre-change Entra attributes (personal data)', () => {
    const before = { mobilePhone: '+358 40 765 4321', surname: 'Lovelace' };

    beforeEach(() => {
      entraService.captureUserState.mockResolvedValue({
        existed: true,
        objectId: 'entra-1',
        attributes: before,
      });
    });

    it('are stored encrypted under the operation tenant; the result carries only the reference', async () => {
      const result = await activities.executeOperation(
        entraOperation(BulkOperationType.UPDATE),
        'tenant-a',
        'corr-1',
      );

      expect(snapshots.save).toHaveBeenCalledWith('tenant-a', 'entra-attributes', before);
      expect(result.systemResults[0].previousState).toEqual({
        existed: true,
        objectId: 'entra-1',
        snapshotRef: 'snap-1',
      });
      expect(JSON.stringify(result)).not.toContain('765 4321');
    });

    it('are read back by reference to restore the account on rollback', async () => {
      const updated = await activities.executeOperation(
        entraOperation(BulkOperationType.UPDATE),
        'tenant-a',
        'corr-1',
      );
      snapshots.load.mockResolvedValue(before);

      const outcome = await activities.compensateOperation(updated, 'tenant-a', 'corr-1');

      expect(outcome.rolledBack).toBe(true);
      expect(snapshots.load).toHaveBeenCalledWith('tenant-a', 'entra-attributes', 'snap-1');
      expect(entraService.restoreUserState).toHaveBeenCalledWith('entra-1', before);
      expect(tenantCalls).toContainEqual(['restoreUserState', 'tenant-a']);
    });

    it('fail the system before Entra is changed when they cannot be stored', async () => {
      snapshots.save.mockRejectedValue(new Error('Mongo down'));

      const result = await activities.executeOperation(
        entraOperation(BulkOperationType.UPDATE),
        'tenant-a',
        'corr-1',
      );

      expect(result.systemResults).toEqual([
        expect.objectContaining({ system: 'entra-id', success: false, error: 'Mongo down' }),
      ]);
      expect(entra.provisionUserToEntra).not.toHaveBeenCalled();
    });
  });

  describe('the keyed Entra snapshot (retried system activity)', () => {
    const key = 'run-1/op-1/entra-id';
    const operation = entraOperation(BulkOperationType.UPDATE);

    /** Keyed like RollbackSnapshotService: a second save under a key returns the first ref. */
    beforeEach(() => {
      const saved = new Map<string, { tenantId: string; kind: string; state: unknown }>();
      const byKey = new Map<string, string>();
      snapshots.save.mockImplementation(
        async (tenantId: string, kind: string, state: unknown, k?: string) => {
          const existing = k ? byKey.get(`${tenantId}|${k}`) : undefined;
          if (existing) return existing;
          const ref = `snap-${saved.size + 1}`;
          saved.set(ref, { tenantId, kind, state: JSON.parse(JSON.stringify(state)) });
          if (k) byKey.set(`${tenantId}|${k}`, ref);
          return ref;
        },
      );
      snapshots.load.mockImplementation(async (tenantId: string, kind: string, ref: string) => {
        const snapshot = saved.get(ref);
        return snapshot?.tenantId === tenantId && snapshot.kind === kind ? snapshot.state : null;
      });
    });

    /** First attempt: snapshot, then a 429 after Entra already changed; then the retry. */
    const runWithRetry = async () => {
      entra.provisionUserToEntra.mockRejectedValueOnce(new RateLimitedException(1000, 'entra-id'));
      await expect(
        activities.executeSystemOperation(operation, 'entra-id', 'tenant-a', undefined, key),
      ).rejects.toBeInstanceOf(RateLimitedException);
      return activities.executeSystemOperation(operation, 'entra-id', 'tenant-a', undefined, key);
    };

    it('keeps the values from before the first attempt, not the ones it wrote', async () => {
      const before = { jobTitle: 'Night Porter' };
      entraService.captureUserState
        .mockResolvedValueOnce({ existed: true, objectId: 'entra-1', attributes: before })
        .mockResolvedValueOnce({
          existed: true,
          objectId: 'entra-1',
          attributes: { jobTitle: 'Clerk' },
        });

      const { result } = await runWithRetry();
      const outcome = await activities.compensateOperation(
        {
          operationId: 'op-1',
          type: BulkOperationType.UPDATE,
          email: user.email,
          systemResults: [result],
        } as never,
        'tenant-a',
      );

      expect(result.previousState).toEqual({
        existed: true,
        objectId: 'entra-1',
        snapshotRef: 'snap-1',
        snapshotKind: 'entra-state',
      });
      expect(outcome.rolledBack).toBe(true);
      expect(entraService.restoreUserState).toHaveBeenCalledWith('entra-1', before);
    });

    it('still knows the first attempt created the account, so the rollback disables it', async () => {
      entraService.captureUserState
        .mockResolvedValueOnce({ existed: false })
        .mockResolvedValueOnce({
          existed: true,
          objectId: 'entra-1',
          attributes: { jobTitle: 'Clerk' },
        });

      const { result } = await runWithRetry();
      const outcome = await activities.compensateOperation(
        {
          operationId: 'op-1',
          type: BulkOperationType.CREATE,
          email: user.email,
          systemResults: [result],
        } as never,
        'tenant-a',
      );

      expect(result.previousState).toEqual({ existed: false });
      expect(outcome.rolledBack).toBe(true);
      expect(entraService.disableUser).toHaveBeenCalledWith('entra-1');
      expect(entraService.restoreUserState).not.toHaveBeenCalled();
    });

    it('stores the whole state encrypted under the key and keeps the values out of the result', async () => {
      entraService.captureUserState.mockResolvedValue({
        existed: true,
        objectId: 'entra-1',
        attributes: { mobilePhone: '+358 40 765 4321' },
      });

      const { result } = await activities.executeSystemOperation(
        operation,
        'entra-id',
        'tenant-a',
        undefined,
        key,
      );

      expect(snapshots.save).toHaveBeenCalledWith(
        'tenant-a',
        'entra-state',
        { existed: true, objectId: 'entra-1', attributes: { mobilePhone: '+358 40 765 4321' } },
        key,
      );
      expect(JSON.stringify(result)).not.toContain('765 4321');
    });
  });

  describe('saveToHubWithSnapshot', () => {
    const before = {
      id: 'identity-1',
      profile: { email: 'ada@example.com', mobilePhone: '+358 40 765 4321' },
      sources: [],
      metadata: {},
      deletedAt: null,
      deletedBy: null,
    };

    it('stores what the write overwrites before it, keyed, and returns only the reference', async () => {
      identityService.saveOrUpdateReportingCreated.mockImplementation(
        async (_user: unknown, beforeWrite: (s: unknown) => Promise<void>) => {
          await beforeWrite(before);
          tenantCalls.push(['saveOrUpdateReportingCreated', getCurrentTenantId()]);
          return { _id: 'identity-1' };
        },
      );

      const hubWrite = await activities.saveToHubWithSnapshot(user, 'tenant-a', 'run-1/op-1');

      expect(hubWrite).toEqual({ identityId: 'identity-1', snapshotRef: 'snap-1' });
      expect(snapshots.save).toHaveBeenCalledWith(
        'tenant-a',
        'hub-identity',
        { existed: true, state: before },
        'run-1/op-1',
      );
      expect(tenantCalls).toEqual([['saveOrUpdateReportingCreated', 'tenant-a']]);
      expect(JSON.stringify(hubWrite)).not.toContain('765 4321');
    });

    // Final review ID4: the batch start puts the hash it computed in nationalIdHash and removes
    // any correlationId; the Hub save matches on that hash, and neither field is saved as given
    it('hands the Hub save the national ID hash of its own field, and no correlationId', async () => {
      identityService.saveOrUpdateReportingCreated.mockImplementation(
        async (_user: unknown, beforeWrite: (s: unknown) => Promise<void>) => {
          await beforeWrite(null);
          return { _id: 'identity-4' };
        },
      );

      await activities.saveToHubWithSnapshot(
        { ...user, nationalIdHash: 'hash-1', correlationId: 'client-value' } as never,
        'tenant-a',
        'run-1/op-4',
      );

      const [saved, , , options] = identityService.saveOrUpdateReportingCreated.mock.calls[0];
      expect(options).toEqual({ nationalIdHash: 'hash-1' });
      expect(saved).not.toHaveProperty('correlationId');
      expect(saved).not.toHaveProperty('nationalIdHash');
    });

    it('passes no hash for a user whose batch start found no national ID', async () => {
      identityService.saveOrUpdateReportingCreated.mockImplementation(
        async (_user: unknown, beforeWrite: (s: unknown) => Promise<void>) => {
          await beforeWrite(null);
          return { _id: 'identity-5' };
        },
      );

      await activities.saveToHubWithSnapshot(
        { ...user, nationalIdHash: null } as never,
        'tenant-a',
        'run-1/op-5',
      );

      expect(identityService.saveOrUpdateReportingCreated.mock.calls[0][3]).toBeUndefined();
    });

    // A batch started before the final review fix (no nationalIdHash field): the hash the batch
    // start computed is in correlationId, as that build put it
    it('hands the Hub save the national ID hash in the user correlationId', async () => {
      identityService.saveOrUpdateReportingCreated.mockImplementation(
        async (_user: unknown, beforeWrite: (s: unknown) => Promise<void>) => {
          await beforeWrite(null);
          return { _id: 'identity-4' };
        },
      );

      await activities.saveToHubWithSnapshot(
        { ...user, correlationId: 'hash-1' },
        'tenant-a',
        'run-1/op-4',
      );

      expect(identityService.saveOrUpdateReportingCreated).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: 'hash-1' }),
        expect.any(Function),
        expect.any(Function),
        { nationalIdHash: 'hash-1' },
      );
    });

    it('records that the write creates the identity', async () => {
      identityService.saveOrUpdateReportingCreated.mockImplementation(
        async (_user: unknown, beforeWrite: (s: unknown) => Promise<void>) => {
          await beforeWrite(null);
          return { _id: 'identity-2' };
        },
      );

      await expect(
        activities.saveToHubWithSnapshot(user, 'tenant-a', 'run-1/op-2'),
      ).resolves.toEqual({ identityId: 'identity-2', snapshotRef: 'snap-1' });
      expect(snapshots.save).toHaveBeenCalledWith(
        'tenant-a',
        'hub-identity',
        { existed: false },
        'run-1/op-2',
      );
    });

    it('keeps the flags a low-confidence match sets on another identity, keyed, before it flags', async () => {
      const flagsBefore = { id: 'identity-jane', requiresReview: false };
      snapshots.save.mockImplementation(async (_t: string, kind: string) =>
        kind === 'hub-conflict-flags' ? 'flags-snap-1' : 'hub-snap-1',
      );
      identityService.saveOrUpdateReportingCreated.mockImplementation(
        async (
          _user: unknown,
          beforeWrite: (s: unknown) => Promise<void>,
          beforeConflictFlag: (s: unknown) => Promise<void>,
        ) => {
          await beforeConflictFlag(flagsBefore);
          await beforeWrite(null);
          return { _id: 'identity-3' };
        },
      );

      const hubWrite = await activities.saveToHubWithSnapshot(user, 'tenant-a', 'run-1/op-3');

      expect(hubWrite).toEqual({ identityId: 'identity-3', snapshotRef: 'hub-snap-1' });
      expect(snapshots.save).toHaveBeenNthCalledWith(
        1,
        'tenant-a',
        'hub-conflict-flags',
        flagsBefore,
        'run-1/op-3/conflict',
      );
      expect(snapshots.save).toHaveBeenNthCalledWith(
        2,
        'tenant-a',
        'hub-identity',
        { existed: false, conflictRef: 'flags-snap-1' },
        'run-1/op-3',
      );
    });

    it('does not write the Golden Record when the snapshot cannot be stored', async () => {
      snapshots.save.mockRejectedValue(new Error('Mongo down'));
      const write = jest.fn();
      identityService.saveOrUpdateReportingCreated.mockImplementation(
        async (_user: unknown, beforeWrite: (s: unknown) => Promise<void>) => {
          await beforeWrite(before);
          write();
          return { _id: 'identity-1' };
        },
      );

      await expect(
        activities.saveToHubWithSnapshot(user, 'tenant-a', 'run-1/op-1'),
      ).rejects.toThrow('Mongo down');
      expect(write).not.toHaveBeenCalled();
    });

    it('requires the tenant and the snapshot key', async () => {
      await expect(activities.saveToHubWithSnapshot(user, '', 'k')).rejects.toThrow('[SECURITY]');
      await expect(activities.saveToHubWithSnapshot(user, 'tenant-a')).rejects.toThrow(
        'snapshotKey is required',
      );
    });
  });
});
