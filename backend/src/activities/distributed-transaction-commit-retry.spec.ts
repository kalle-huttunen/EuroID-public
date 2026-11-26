/**
 * The commit of a distributed transaction when Temporal retries it (a timeout, a worker that
 * died). The retried attempt got the original PREPARED states, so a system that had already
 * committed ran again (HX-F report follow-up, the second hazard of r2-03 N7). Each system's
 * outcome is now heartbeated as it happens and a retry keeps it instead of running the system
 * again; a CREATE whose outcome did not reach Temporal looks the account up first, so a second
 * attempt never makes a second account.
 */
import { MockActivityEnvironment } from '@temporalio/testing';
import { DistributedTransactionActivities } from './distributed-transaction.activities';
import { createMockUser } from '@testing/mock-factories';
import { TEST_TENANT_ID } from '@testing/test-helpers';
import {
  SystemTransactionStatus,
  type SystemTransactions,
} from '@shared/dtos/distributed-transaction.dto';
import { MemoryOwnedLockStore } from '@infrastructure/cache/owned-lock.store';

type Ctor = ConstructorParameters<typeof DistributedTransactionActivities>;

describe('DistributedTransactionActivities.commitTransaction retried', () => {
  const user = createMockUser();
  const request = (operation: 'CREATE' | 'UPDATE' | 'DELETE') => ({
    transactionId: 'tx-retry',
    user,
    targetSystems: ['entra-id'],
    operation,
    initiatedBy: 'ops@corp.example',
  });
  const prepared = (): SystemTransactions => ({
    'entra-id': {
      system: 'entra-id',
      status: SystemTransactionStatus.PREPARED,
      lockId: 'lock-1',
      previousState: { snapshotRef: 'snap-1' },
      preparedAt: new Date('2026-11-26T08:00:00.000Z'),
    },
  });
  const entraActivities = {
    provisionUserToEntra: jest.fn(),
    disableEntraUser: jest.fn(),
    validateUpn: jest.fn(),
  };
  const entraService = {
    findAccountByUpn: jest.fn(),
    findAccountIdByIdentifiers: jest.fn(),
    updateUser: jest.fn(),
  };
  const snapshots = {
    save: jest.fn(),
    // What prepare stored: an UPDATE's account and attributes, a CREATE's resolved UPN
    load: jest.fn(async () => ({
      id: 'obj-9',
      attributes: { jobTitle: 'Analyst' },
      accountUpn: 'john.doe2@corp.test',
    })),
  };
  const activities = new DistributedTransactionActivities(
    entraActivities as unknown as Ctor[0],
    {} as Ctor[1],
    entraService as unknown as Ctor[2],
    { emit: jest.fn() } as unknown as Ctor[3],
    { capture: jest.fn() } as unknown as Ctor[4],
    new MemoryOwnedLockStore(),
    { updateTransactionPhase: jest.fn() } as unknown as Ctor[6],
    snapshots as unknown as Ctor[7],
  );
  const commit = (env: MockActivityEnvironment, operation: 'CREATE' | 'UPDATE' | 'DELETE') =>
    env.run(() =>
      activities.commitTransaction(request(operation), prepared(), TEST_TENANT_ID),
    ) as Promise<SystemTransactions>;

  beforeEach(() => {
    jest.clearAllMocks();
    entraActivities.provisionUserToEntra.mockResolvedValue({ success: true, objectId: 'obj-new' });
    entraService.findAccountByUpn.mockResolvedValue(null);
    entraService.findAccountIdByIdentifiers.mockResolvedValue(null);
  });

  it("heartbeats each system's outcome as soon as it is known", async () => {
    const env = new MockActivityEnvironment();
    const beats: unknown[] = [];
    env.on('heartbeat', (details: unknown) => beats.push(details));

    await commit(env, 'CREATE');

    expect(beats).toEqual([
      {
        outcomes: {
          'entra-id': expect.objectContaining({
            status: SystemTransactionStatus.COMMITTED,
            createdAccountId: 'obj-new',
          }),
        },
      },
    ]);
    // A first attempt makes the account without looking for one
    expect(entraService.findAccountByUpn).not.toHaveBeenCalled();
  });

  it('keeps a committed system of the earlier attempt and does not run it again', async () => {
    const committedAt = '2026-11-26T08:00:00.000Z';
    const env = new MockActivityEnvironment({
      attempt: 2,
      heartbeatDetails: {
        outcomes: {
          'entra-id': {
            system: 'entra-id',
            status: SystemTransactionStatus.COMMITTED,
            createdAccountId: 'obj-1',
            committedAt,
          },
        },
      },
    });

    const result = await commit(env, 'CREATE');

    expect(entraActivities.provisionUserToEntra).not.toHaveBeenCalled();
    expect(result['entra-id']).toEqual(
      expect.objectContaining({
        status: SystemTransactionStatus.COMMITTED,
        createdAccountId: 'obj-1',
        lockId: 'lock-1',
      }),
    );
  });

  it('keeps a failed system of the earlier attempt too: the rollback decides, not a rerun', async () => {
    const env = new MockActivityEnvironment({
      attempt: 2,
      heartbeatDetails: {
        outcomes: {
          'entra-id': {
            system: 'entra-id',
            status: SystemTransactionStatus.FAILED,
            error: 'Graph refused the group',
            createdAccountId: 'obj-2',
          },
        },
      },
    });

    const result = await commit(env, 'CREATE');

    expect(entraActivities.provisionUserToEntra).not.toHaveBeenCalled();
    expect(result['entra-id']).toEqual(
      expect.objectContaining({
        status: SystemTransactionStatus.FAILED,
        createdAccountId: 'obj-2',
      }),
    );
  });

  // HX-F2 follow-up: the retry looked the account up by the user's UPN or email, so an account
  // whose UPN the UPN pattern generated was not found and the retry made a second one. It now
  // looks it up by the UPN prepare resolved (the one the commit created it under), and takes it
  // only when Entra ID created it after the prepare.
  it('takes the account an earlier attempt made, found by the UPN prepare resolved', async () => {
    entraService.findAccountByUpn.mockResolvedValue({
      id: 'obj-made-before',
      createdDateTime: '2026-11-26T08:00:03Z',
    });
    const env = new MockActivityEnvironment({ attempt: 2 });

    const result = await commit(env, 'CREATE');

    expect(entraService.findAccountByUpn).toHaveBeenCalledWith('john.doe2@corp.test');
    expect(entraService.findAccountIdByIdentifiers).not.toHaveBeenCalled();
    expect(entraActivities.provisionUserToEntra).not.toHaveBeenCalled();
    expect(result['entra-id']).toEqual(
      expect.objectContaining({
        status: SystemTransactionStatus.COMMITTED,
        createdAccountId: 'obj-made-before',
      }),
    );
  });

  // Final review RC5 / CP2: Graph gives createdDateTime in whole seconds and its clock is not the
  // worker's, so an account made by the first attempt within the second of the prepare (or a
  // moment "before" it by Entra ID's clock) looked older, and the retry left it behind unrecorded
  it.each([
    ['in the second of the prepare (Graph drops the milliseconds)', '2026-11-26T08:00:00Z'],
    ['seconds before the prepare by Entra ID clock', '2026-11-26T07:59:57Z'],
  ])('takes the account an earlier attempt made %s', async (_when, createdDateTime) => {
    entraService.findAccountByUpn.mockResolvedValue({ id: 'obj-skewed', createdDateTime });
    const env = new MockActivityEnvironment({ attempt: 2 });

    const result = await commit(env, 'CREATE');

    expect(entraActivities.provisionUserToEntra).not.toHaveBeenCalled();
    expect(result['entra-id']).toEqual(
      expect.objectContaining({
        status: SystemTransactionStatus.COMMITTED,
        createdAccountId: 'obj-skewed',
      }),
    );
  });

  it.each([
    ['before the prepare', '2026-11-26T07:59:00Z'],
    ['at a time Entra ID does not say', undefined],
  ])(
    'fails, taking nothing for a rollback to delete, when the account was created %s',
    async (_when, createdDateTime) => {
      entraService.findAccountByUpn.mockResolvedValue({ id: 'obj-older', createdDateTime });
      const env = new MockActivityEnvironment({ attempt: 2 });

      const result = await commit(env, 'CREATE');

      expect(entraActivities.provisionUserToEntra).not.toHaveBeenCalled();
      expect(result['entra-id']?.status).toBe(SystemTransactionStatus.FAILED);
      expect(result['entra-id']?.createdAccountId).toBeUndefined();
      expect(result['entra-id']?.error).toContain('never takes over an existing account');
    },
  );

  it('makes the account on a retry when no earlier attempt made one', async () => {
    const env = new MockActivityEnvironment({ attempt: 2 });

    const result = await commit(env, 'CREATE');

    expect(entraService.findAccountByUpn).toHaveBeenCalledWith('john.doe2@corp.test');
    expect(entraActivities.provisionUserToEntra).toHaveBeenCalledTimes(1);
    expect(result['entra-id']?.createdAccountId).toBe('obj-new');
  });

  it('writes an UPDATE again on a retry whose outcome was lost (the same values)', async () => {
    const env = new MockActivityEnvironment({ attempt: 2 });

    const result = await commit(env, 'UPDATE');

    expect(entraService.updateUser).toHaveBeenCalledWith('obj-9', user);
    expect(result['entra-id']?.status).toBe(SystemTransactionStatus.COMMITTED);
  });
});
