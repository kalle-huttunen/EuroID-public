import { Test } from '@nestjs/testing';
import { HttpStatus, Logger } from '@nestjs/common';
import { ConnectorException, ProvisioningException } from '@shared/exceptions/domain-exceptions';
import { DistributedTransactionActivities, lockKeyOf } from './distributed-transaction.activities';
import { EntraActivities } from './entra.activities';
import { IdentityActivities } from './identity.activities';
import { EntraService } from '../modules/connectors/entra-connector/entra.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DeadLetterService } from '../modules/dead-letter/dead-letter.service';
import { createMockUser } from '@testing/mock-factories';
import { DomainEventType } from '@infrastructure/events/event-types';
import { createMockEventEmitter } from '@testing/test-helpers';
import { TEST_TENANT_ID } from '@testing/test-helpers';
import {
  SystemTransactionStatus,
  type SystemTransactions,
} from '@shared/dtos/distributed-transaction.dto';
import { validateActivityContext } from '@shared/utils/activity-context';
import { MemoryOwnedLockStore, OWNED_LOCK_STORE } from '@infrastructure/cache/owned-lock.store';
import { DevToolsService } from '../modules/dev-tools/dev-tools.service';
import { RollbackSnapshotService } from '../modules/bulk-provisioning/rollback-snapshot.service';
import { ApplicationFailure } from '@temporalio/common';
import { ENTRA_CHANGES_FAILED } from '@shared/types/entra-provisioning';

/**
 * A transaction as prepare left it before it refused systems the commit cannot change: such a
 * system PREPARED next to Entra ID. One in flight at the deploy still fails that system at
 * commit, after Entra ID committed, and the rollback restores Entra ID.
 */
const preparedBeforeSystemCheck = (
  prepared: SystemTransactions,
  system: string,
): SystemTransactions => ({
  ...prepared,
  [system]: { system, status: SystemTransactionStatus.PREPARED },
});

// Like the real Entra activities: without a tenantId they throw "[SECURITY] tenantId is required".
const requireTenantAt = (index: number, value: unknown) =>
  jest.fn(async (...args: unknown[]) => {
    validateActivityContext({ tenantId: (args[index] as string | undefined) ?? '' });
    return value;
  });

/** The UPN prepare resolves for a CREATE (EntraService.resolveAvailableUpn, pattern included). */
const RESOLVED_UPN = 'john.doe2@corp.test';

describe('DistributedTransactionActivities', () => {
  let activities: DistributedTransactionActivities;
  let entraActivities: {
    provisionUserToEntra: jest.Mock;
    disableEntraUser: jest.Mock;
    validateUpn: jest.Mock;
  };
  let entraService: jest.Mocked<Partial<EntraService>>;
  let deadLetterService: { capture: jest.Mock };
  let eventEmitter: ReturnType<typeof createMockEventEmitter>;
  let locks: MemoryOwnedLockStore;
  let transactionLog: { updateTransactionPhase: jest.Mock };
  /** Stored snapshots by ref, as RollbackSnapshotService keeps them (tenant, kind, state). */
  let stored: Map<string, { tenantId: string; kind: string; state: unknown }>;
  let snapshots: { save: jest.Mock; load: jest.Mock };

  beforeEach(async () => {
    entraActivities = {
      // A create answers the account's object id (createAccount)
      provisionUserToEntra: requireTenantAt(3, { success: true, objectId: 'obj-created' }),
      disableEntraUser: requireTenantAt(1, true),
      validateUpn: requireTenantAt(1, true),
    };

    entraService = {
      resolveAvailableUpn: jest
        .fn()
        .mockResolvedValue({ chosenUpn: RESOLVED_UPN, candidatesChecked: [RESOLVED_UPN] }),
      existingAccountFor: jest.fn().mockResolvedValue(null),
      getUserByEmail: jest.fn().mockResolvedValue(null),
      deleteUser: jest.fn().mockResolvedValue(true),
      patchUser: jest.fn().mockResolvedValue(undefined),
      captureUserState: jest.fn().mockResolvedValue({ existed: false }),
      updateUser: jest.fn().mockResolvedValue(undefined),
      restoreUserState: jest.fn().mockResolvedValue(undefined),
    };

    deadLetterService = { capture: jest.fn().mockResolvedValue(undefined) };
    eventEmitter = createMockEventEmitter();

    locks = new MemoryOwnedLockStore();
    jest.spyOn(locks, 'release');
    transactionLog = { updateTransactionPhase: jest.fn().mockResolvedValue(undefined) };
    stored = new Map();
    snapshots = {
      save: jest.fn(async (tenantId: string, kind: string, state: unknown) => {
        const ref = `snap-${stored.size + 1}`;
        stored.set(ref, { tenantId, kind, state: JSON.parse(JSON.stringify(state)) });
        return ref;
      }),
      load: jest.fn(async (tenantId: string, kind: string, ref: string) => {
        const snapshot = stored.get(ref);
        return snapshot?.tenantId === tenantId && snapshot.kind === kind ? snapshot.state : null;
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        DistributedTransactionActivities,
        { provide: EntraActivities, useValue: entraActivities },
        {
          provide: IdentityActivities,
          useValue: { saveToHub: jest.fn(), getUserByEmail: jest.fn() },
        },
        { provide: EntraService, useValue: entraService },
        { provide: DomainEventEmitterService, useValue: eventEmitter },
        { provide: DeadLetterService, useValue: deadLetterService },
        { provide: OWNED_LOCK_STORE, useValue: locks },
        { provide: DevToolsService, useValue: transactionLog },
        { provide: RollbackSnapshotService, useValue: snapshots },
      ],
    }).compile();

    activities = module.get(DistributedTransactionActivities);
  });

  describe('prepareTransaction', () => {
    it('should return PREPARED when all systems prepare successfully', async () => {
      const user = createMockUser();
      const request = {
        transactionId: 'tx-1',
        user,
        targetSystems: ['entra-id'],
        operation: 'CREATE' as const,
        initiatedBy: 'test@example.com',
      };

      const result = await activities.prepareTransaction(request, TEST_TENANT_ID, 'corr-1');

      expect(Object.keys(result)).toEqual(['entra-id']);
      const tx = result['entra-id'];
      expect(tx?.status).toBe(SystemTransactionStatus.PREPARED);
      // The UPN the commit will give the account, resolved here and kept with the transaction,
      // encrypted in the snapshot store (personal data): the per-system state has the reference
      expect(entraService.resolveAvailableUpn).toHaveBeenCalledWith(user);
      expect(entraService.existingAccountFor).toHaveBeenCalledWith(user, RESOLVED_UPN);
      const ref = tx?.previousState?.snapshotRef as string;
      expect(stored.get(ref)).toEqual({
        tenantId: TEST_TENANT_ID,
        kind: 'entra-account',
        state: { accountUpn: RESOLVED_UPN },
      });
      expect(JSON.stringify(result)).not.toContain(RESOLVED_UPN);
    });

    it('should throw and rollback locks when prepare fails on one system', async () => {
      const user = createMockUser();
      (entraService.existingAccountFor as jest.Mock).mockResolvedValue('obj-existing');
      const request = {
        transactionId: 'tx-2',
        user,
        targetSystems: ['entra-id'],
        operation: 'CREATE' as const,
        initiatedBy: 'test@example.com',
      };

      await expect(activities.prepareTransaction(request, TEST_TENANT_ID)).rejects.toThrow(
        ProvisioningException,
      );

      expect(locks.release).toHaveBeenCalledWith(
        `disttx:lock:${lockKeyOf(TEST_TENANT_ID, 'entra-id', user.email)}`,
        `${TEST_TENANT_ID}:tx-2`,
      );
      await expect(
        locks.acquire(
          `disttx:lock:${lockKeyOf(TEST_TENANT_ID, 'entra-id', user.email)}`,
          'other',
          1000,
        ),
      ).resolves.toBe('other');
    });

    it('refuses a system the commit cannot change, before any lock or read, for good', async () => {
      const acquire = jest.spyOn(locks, 'acquire');
      const request = {
        transactionId: 'tx-unsupported',
        user: createMockUser(),
        targetSystems: ['entra-id', 'file-outbound'],
        operation: 'DELETE' as const,
        initiatedBy: 'test@example.com',
      };

      await expect(activities.prepareTransaction(request, TEST_TENANT_ID)).rejects.toMatchObject({
        message: 'Distributed transactions can change entra-id only; not supported: file-outbound',
        type: 'UnsupportedSystem',
        nonRetryable: true,
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(entraService.getUserByEmail).not.toHaveBeenCalled();
      expect(transactionLog.updateTransactionPhase).toHaveBeenCalledWith(
        'tx-unsupported',
        'FAILED',
        [
          expect.objectContaining({
            systemName: 'file-outbound',
            status: 'FAILED',
            error: expect.stringContaining('not supported: file-outbound'),
          }),
        ],
      );
    });

    it('keys the lock by tenant and a hash of the email, never the email itself', async () => {
      const user = createMockUser({ email: 'Ada.Lovelace@Example.com' });
      const acquire = jest.spyOn(locks, 'acquire');
      const request = {
        transactionId: 'tx-key',
        user,
        targetSystems: ['entra-id'],
        operation: 'CREATE' as const,
        initiatedBy: 'test@example.com',
      };

      const prepared = await activities.prepareTransaction(request, TEST_TENANT_ID);

      const key = acquire.mock.calls[0][0];
      expect(key).toMatch(new RegExp(`^disttx:lock:${TEST_TENANT_ID}:entra-id:[0-9a-f]{64}$`));
      expect(key.toLowerCase()).not.toContain('ada.lovelace');
      expect(prepared['entra-id']?.lockId?.toLowerCase()).not.toContain('ada.lovelace');
    });

    it('locks the same account however its email is cased', () => {
      expect(lockKeyOf('tenant-a', 'entra-id', ' Ada@Example.com')).toBe(
        lockKeyOf('tenant-a', 'entra-id', 'ada@example.com'),
      );
    });

    it('does not block a transaction of another tenant for the same email', async () => {
      const user = createMockUser();
      const request = (transactionId: string) => ({
        transactionId,
        user,
        targetSystems: ['entra-id'],
        operation: 'CREATE' as const,
        initiatedBy: 'test@example.com',
      });
      await activities.prepareTransaction(request('tx-tenant-a'), TEST_TENANT_ID);

      const other = await activities.prepareTransaction(request('tx-tenant-b'), 'tenant-other');

      expect(other['entra-id']?.status).toBe(SystemTransactionStatus.PREPARED);
    });

    it('cannot prepare a user whose lock another transaction holds', async () => {
      const user = createMockUser();
      const request = (transactionId: string) => ({
        transactionId,
        user,
        targetSystems: ['entra-id'],
        operation: 'CREATE' as const,
        initiatedBy: 'test@example.com',
      });
      await activities.prepareTransaction(request('tx-holder'), TEST_TENANT_ID);

      await expect(
        activities.prepareTransaction(request('tx-blocked'), TEST_TENANT_ID),
      ).rejects.toThrow(ProvisioningException);
    });
  });

  describe('commitTransaction', () => {
    it('should commit and mark systems as COMMITTED', async () => {
      const user = createMockUser();
      const request = {
        transactionId: 'tx-3',
        user,
        targetSystems: ['entra-id'],
        operation: 'CREATE' as const,
        initiatedBy: 'test@example.com',
      };
      const prepared = await activities.prepareTransaction(request, TEST_TENANT_ID);

      const result = await activities.commitTransaction(
        request,
        prepared,
        TEST_TENANT_ID,
        'corr-1',
      );

      const tx = result['entra-id'];
      expect(tx?.status).toBe(SystemTransactionStatus.COMMITTED);
      // Create only, under the UPN prepare resolved: no account is looked up and updated
      expect(entraActivities.provisionUserToEntra).toHaveBeenCalledWith(
        user,
        undefined,
        undefined,
        TEST_TENANT_ID,
        'corr-1',
        undefined,
        undefined,
        RESOLVED_UPN,
      );
    });

    it('disables the Entra user under the transaction tenant for DELETE', async () => {
      const user = createMockUser();
      (entraService.getUserByEmail as jest.Mock).mockResolvedValue({
        id: 'entra-obj-del',
        userPrincipalName: user.email,
        accountEnabled: true,
      });
      const request = {
        transactionId: 'tx-3b',
        user,
        targetSystems: ['entra-id'],
        operation: 'DELETE' as const,
        initiatedBy: 'test@example.com',
      };
      const prepared = await activities.prepareTransaction(request, TEST_TENANT_ID);

      const result = await activities.commitTransaction(
        request,
        prepared,
        TEST_TENANT_ID,
        'corr-1',
      );

      expect(result['entra-id']?.status).toBe(SystemTransactionStatus.COMMITTED);
      expect(entraActivities.disableEntraUser).toHaveBeenCalledWith(
        user.email,
        TEST_TENANT_ID,
        'corr-1',
      );
    });
  });

  describe('a system that fails to commit', () => {
    const request = (transactionId: string, user = createMockUser()) => ({
      transactionId,
      user,
      targetSystems: ['entra-id'],
      operation: 'CREATE' as const,
      initiatedBy: 'test@example.com',
    });

    it('releases its lock at once, so the next transaction for the user can prepare', async () => {
      entraActivities.provisionUserToEntra.mockRejectedValueOnce(new Error('Graph 500'));
      const first = request('tx-commit-fail');
      const prepared = await activities.prepareTransaction(first, TEST_TENANT_ID);

      const result = await activities.commitTransaction(first, prepared, TEST_TENANT_ID);

      expect(result['entra-id']).toMatchObject({
        status: SystemTransactionStatus.FAILED,
        error: 'Graph 500',
      });
      const next = await activities.prepareTransaction(
        request('tx-after-fail', first.user),
        TEST_TENANT_ID,
      );
      expect(next['entra-id']?.status).toBe(SystemTransactionStatus.PREPARED);
    });

    it('releases its lock under the transaction owner token', async () => {
      entraActivities.provisionUserToEntra.mockRejectedValueOnce(new Error('Graph 500'));
      const tx = request('tx-commit-fail-owner');
      const prepared = await activities.prepareTransaction(tx, TEST_TENANT_ID);
      (locks.release as jest.Mock).mockClear();

      await activities.commitTransaction(tx, prepared, TEST_TENANT_ID);

      expect(locks.release).toHaveBeenCalledWith(
        `disttx:lock:${lockKeyOf(TEST_TENANT_ID, 'entra-id', tx.user.email)}`,
        `${TEST_TENANT_ID}:tx-commit-fail-owner`,
      );
    });

    it('keeps the FAILED result when the lock release itself fails', async () => {
      entraActivities.provisionUserToEntra.mockRejectedValueOnce(new Error('Graph 500'));
      const tx = request('tx-commit-fail-release-fail');
      const prepared = await activities.prepareTransaction(tx, TEST_TENANT_ID);
      (locks.release as jest.Mock).mockRejectedValueOnce(new Error('Redis down'));

      const result = await activities.commitTransaction(tx, prepared, TEST_TENANT_ID);

      expect(result['entra-id']?.status).toBe(SystemTransactionStatus.FAILED);
    });
  });

  describe('lock release by owner', () => {
    const request = (transactionId: string, user = createMockUser()) => ({
      transactionId,
      user,
      targetSystems: ['entra-id'],
      operation: 'CREATE' as const,
      initiatedBy: 'test@example.com',
    });

    it('keeps a committed system COMMITTED when releasing its lock fails', async () => {
      const tx = request('tx-commit-release-fail');
      const prepared = await activities.prepareTransaction(tx, TEST_TENANT_ID);
      (locks.release as jest.Mock).mockRejectedValueOnce(new Error('Redis down'));

      const result = await activities.commitTransaction(tx, prepared, TEST_TENANT_ID);

      // The account exists in Entra: reporting FAILED would make the rollback skip it.
      expect(result['entra-id']?.status).toBe(SystemTransactionStatus.COMMITTED);
    });

    it('a rollback after the commit leaves the lock another transaction took since', async () => {
      const first = request('tx-first');
      const committed = await activities.commitTransaction(
        first,
        await activities.prepareTransaction(first, TEST_TENANT_ID),
        TEST_TENANT_ID,
      );
      // The commit released the lock: the next transaction for the user takes it.
      const second = request('tx-second', first.user);
      await activities.prepareTransaction(second, TEST_TENANT_ID);

      // The first transaction's rollback releases its lock a second time.
      const rolledBack = await activities.rollbackTransaction(first, committed, TEST_TENANT_ID);

      expect(rolledBack['entra-id']?.status).toBe(SystemTransactionStatus.ROLLED_BACK);
      // The second transaction still holds the user: a third one cannot prepare.
      await expect(
        activities.prepareTransaction(request('tx-third', first.user), TEST_TENANT_ID),
      ).rejects.toThrow(ProvisioningException);
    });

    it('a transaction of another tenant with the same id cannot release the lock', async () => {
      const tx = request('tx-same-id');
      const prepared = await activities.prepareTransaction(tx, TEST_TENANT_ID);

      await activities.rollbackTransaction(tx, prepared, 'tenant-other');

      await expect(
        activities.prepareTransaction(request('tx-next', tx.user), TEST_TENANT_ID),
      ).rejects.toThrow(ProvisioningException);
    });
  });

  describe('rollbackTransaction', () => {
    it('should rollback and restore previous state', async () => {
      const user = createMockUser();
      const request = {
        transactionId: 'tx-4',
        user,
        targetSystems: ['entra-id'],
        operation: 'CREATE' as const,
        initiatedBy: 'test@example.com',
      };
      entraActivities.provisionUserToEntra.mockResolvedValue({ success: true, objectId: 'obj-4' });
      const prepared = await activities.prepareTransaction(request, TEST_TENANT_ID);
      const committed = await activities.commitTransaction(request, prepared, TEST_TENANT_ID);

      const result = await activities.rollbackTransaction(request, committed, TEST_TENANT_ID);

      const tx = result['entra-id'];
      expect(tx?.status).toBe(SystemTransactionStatus.ROLLED_BACK);
      expect(entraService.deleteUser).toHaveBeenCalledWith('obj-4');
    });

    // Hunt 2026-11-25 (01 F5): the commit creates the account under the UPN resolveAvailableUpn
    // picks, which is not the email when the email is outside the default domain or its UPN is
    // taken. The rollback deleted by the email, got a 404, and reported ROLLED_BACK while the
    // account stayed. The commit now keeps the created account's object id and the rollback
    // deletes by it.
    const createRequest = (transactionId: string) => ({
      transactionId,
      user: createMockUser({ email: 'a@other.fi' }),
      targetSystems: ['entra-id'],
      operation: 'CREATE' as const,
      initiatedBy: 'test@example.com',
    });

    it('deletes the account the commit created by its object id', async () => {
      entraActivities.provisionUserToEntra.mockResolvedValue({
        success: true,
        objectId: 'obj-created-1',
        upnResolution: { chosenUpn: 'a.b@corp.fi', candidatesChecked: [] },
      });
      const request = createRequest('tx-4c');
      const prepared = await activities.prepareTransaction(request, TEST_TENANT_ID);
      const committed = await activities.commitTransaction(request, prepared, TEST_TENANT_ID);
      // As Temporal hands it to the rollback activity
      const crossed = JSON.parse(JSON.stringify(committed)) as typeof committed;

      const result = await activities.rollbackTransaction(request, crossed, TEST_TENANT_ID);

      expect(result['entra-id']?.status).toBe(SystemTransactionStatus.ROLLED_BACK);
      expect(entraService.deleteUser).toHaveBeenCalledWith('obj-created-1');
      expect(entraService.deleteUser).not.toHaveBeenCalledWith('a@other.fi');
    });

    // HX-B report: a CREATE whose provision throws after the account was made (a group, role or
    // license change refused: EntraChangesFailed carries the created account) was FAILED, and
    // the rollback skips FAILED systems, so the account stayed as an orphan.
    it('deletes the account a failed CREATE made, by the id its failure carries', async () => {
      entraActivities.provisionUserToEntra.mockRejectedValue(
        ApplicationFailure.nonRetryable(
          'Entra ID did not make 1 of 1 changes. The account was created',
          ENTRA_CHANGES_FAILED,
          { objectId: 'obj-half-made', generatedAttributes: { userPrincipalName: 'a.b@corp.fi' } },
        ),
      );
      const request = createRequest('tx-4e');
      const prepared = await activities.prepareTransaction(request, TEST_TENANT_ID);
      const committed = await activities.commitTransaction(request, prepared, TEST_TENANT_ID);

      expect(committed['entra-id']).toMatchObject({
        status: SystemTransactionStatus.FAILED,
        createdAccountId: 'obj-half-made',
      });
      const crossed = JSON.parse(JSON.stringify(committed)) as typeof committed;

      const result = await activities.rollbackTransaction(request, crossed, TEST_TENANT_ID);

      expect(entraService.deleteUser).toHaveBeenCalledWith('obj-half-made');
      expect(result['entra-id']?.status).toBe(SystemTransactionStatus.ROLLED_BACK);
    });

    it('rolls back nothing for a CREATE that failed before any account was made', async () => {
      entraActivities.provisionUserToEntra.mockRejectedValue(new Error('Graph 400'));
      const request = createRequest('tx-4f');
      const prepared = await activities.prepareTransaction(request, TEST_TENANT_ID);
      const committed = await activities.commitTransaction(request, prepared, TEST_TENANT_ID);

      const result = await activities.rollbackTransaction(request, committed, TEST_TENANT_ID);

      expect(entraService.deleteUser).not.toHaveBeenCalled();
      expect(result['entra-id']?.status).toBe(SystemTransactionStatus.FAILED);
    });

    // HX-F2 follow-up: a CREATE committed without the id of the account it created was rolled
    // back by the email, which could name an account that existed before the transaction. The
    // rollback deletes only an account the commit created, by its id.
    it('deletes nothing, and reports ROLLBACK_FAILED, for a CREATE committed without the id of its account', async () => {
      entraActivities.provisionUserToEntra.mockResolvedValue({ success: true });
      const request = createRequest('tx-4d');
      const prepared = await activities.prepareTransaction(request, TEST_TENANT_ID);
      const committed = await activities.commitTransaction(request, prepared, TEST_TENANT_ID);

      const result = await activities.rollbackTransaction(request, committed, TEST_TENANT_ID);

      expect(entraService.deleteUser).not.toHaveBeenCalled();
      expect(result['entra-id']?.status).toBe(SystemTransactionStatus.ROLLBACK_FAILED);
    });

    // HX-F2 follow-up: prepare checked only that the email was free as a UPN, and the commit's
    // provision() took over an account with the user's UPN or email, updated it and reported its
    // id as created; the rollback then deleted that pre-existing account.
    describe('a CREATE never takes over an existing account', () => {
      it('is refused at prepare when an account has the resolved UPN, the email or the employee id', async () => {
        (entraService.existingAccountFor as jest.Mock).mockResolvedValue('obj-existing');
        const request = createRequest('tx-4g');

        await expect(activities.prepareTransaction(request, TEST_TENANT_ID)).rejects.toThrow(
          ProvisioningException,
        );

        expect(entraActivities.provisionUserToEntra).not.toHaveBeenCalled();
        expect(transactionLog.updateTransactionPhase).toHaveBeenCalledWith('tx-4g', 'FAILED', [
          expect.objectContaining({
            status: 'FAILED',
            error: expect.stringContaining('a CREATE never takes over an existing account'),
          }),
        ]);
      });

      it('is refused at prepare when the UPN cannot be resolved', async () => {
        (entraService.resolveAvailableUpn as jest.Mock).mockRejectedValue(
          new Error('All 10 UPN candidates are taken. Manual assignment required.'),
        );

        await expect(
          activities.prepareTransaction(createRequest('tx-4h'), TEST_TENANT_ID),
        ).rejects.toThrow(ProvisioningException);
        expect(entraService.existingAccountFor).not.toHaveBeenCalled();
      });

      it('fails the commit, and the rollback deletes nothing, when an account got in the way since', async () => {
        entraActivities.provisionUserToEntra.mockRejectedValue(
          new ConnectorException('An Entra ID account already has the UPN', HttpStatus.CONFLICT),
        );
        const request = createRequest('tx-4i');
        const prepared = await activities.prepareTransaction(request, TEST_TENANT_ID);
        const committed = await activities.commitTransaction(request, prepared, TEST_TENANT_ID);

        expect(committed['entra-id']?.status).toBe(SystemTransactionStatus.FAILED);
        expect(committed['entra-id']?.createdAccountId).toBeUndefined();
        const result = await activities.rollbackTransaction(request, committed, TEST_TENANT_ID);

        expect(entraService.deleteUser).not.toHaveBeenCalled();
        expect(result['entra-id']?.status).toBe(SystemTransactionStatus.FAILED);
      });

      it('deletes the account it created on rollback even after the snapshot expired', async () => {
        const request = createRequest('tx-4k');
        const prepared = await activities.prepareTransaction(request, TEST_TENANT_ID);
        const committed = await activities.commitTransaction(request, prepared, TEST_TENANT_ID);
        stored.clear();

        const result = await activities.rollbackTransaction(request, committed, TEST_TENANT_ID);

        expect(entraService.deleteUser).toHaveBeenCalledWith('obj-created');
        expect(result['entra-id']?.status).toBe(SystemTransactionStatus.ROLLED_BACK);
      });

      it('does not commit a CREATE prepared without the UPN of its account (before this release)', async () => {
        const request = createRequest('tx-4j');
        const prepared = await activities.prepareTransaction(request, TEST_TENANT_ID);
        delete prepared['entra-id']!.previousState;

        const committed = await activities.commitTransaction(request, prepared, TEST_TENANT_ID);

        expect(entraActivities.provisionUserToEntra).not.toHaveBeenCalled();
        expect(committed['entra-id']).toMatchObject({
          status: SystemTransactionStatus.FAILED,
          error: expect.stringContaining('prepared without the UPN of its account'),
        });
      });
    });

    it('captures a failed restore in the dead-letter queue under the transaction tenant', async () => {
      const user = createMockUser();
      (entraService.deleteUser as jest.Mock).mockRejectedValue(new Error('Graph 503'));
      const request = {
        transactionId: 'tx-4b',
        user,
        targetSystems: ['entra-id'],
        operation: 'CREATE' as const,
        initiatedBy: 'test@example.com',
      };
      const prepared = await activities.prepareTransaction(request, TEST_TENANT_ID);
      const committed = await activities.commitTransaction(request, prepared, TEST_TENANT_ID);

      const result = await activities.rollbackTransaction(request, committed, TEST_TENANT_ID);

      // The account the commit created is still there: never ROLLED_BACK.
      expect(result['entra-id']).toMatchObject({
        status: SystemTransactionStatus.ROLLBACK_FAILED,
        error: 'Graph 503',
      });
      expect(result['entra-id']?.rolledBackAt).toBeUndefined();
      expect(deadLetterService.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'distributed-transaction',
          tenantId: TEST_TENANT_ID,
          originalPayload: expect.objectContaining({ transactionId: 'tx-4b', system: 'entra-id' }),
        }),
      );
    });

    it('masks the email in the dead-letter entry and the ROLLBACK_FAILED event', async () => {
      const user = createMockUser({ email: 'ada.night@corp.example' });
      // Graph quotes the address it was given in its error message.
      (entraService.deleteUser as jest.Mock).mockRejectedValue(
        new Error("Resource 'ada.night@corp.example' does not exist"),
      );
      const request = {
        transactionId: 'tx-4c',
        user,
        targetSystems: ['entra-id'],
        operation: 'CREATE' as const,
        initiatedBy: 'test@example.com',
      };
      const prepared = await activities.prepareTransaction(request, TEST_TENANT_ID);
      const committed = await activities.commitTransaction(request, prepared, TEST_TENANT_ID);

      const result = await activities.rollbackTransaction(request, committed, TEST_TENANT_ID);

      const masked = 'a•••@corp.example';
      expect(deadLetterService.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          originalPayload: {
            transactionId: 'tx-4c',
            system: 'entra-id',
            email: masked,
            operation: 'CREATE',
          },
          error: { message: `Resource '${masked}' does not exist` },
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(DomainEventType.ROLLBACK_FAILED, 'tx-4c', {
        transactionId: 'tx-4c',
        system: 'entra-id',
        email: masked,
        error: `Resource '${masked}' does not exist`,
      });
      expect(result['entra-id']?.error).toBe(`Resource '${masked}' does not exist`);
      const written = JSON.stringify([
        deadLetterService.capture.mock.calls,
        eventEmitter.emit.mock.calls,
        result,
      ]);
      expect(written).not.toContain('ada.night@corp.example');
    });
  });

  it('keeps every system through a JSON round trip, as Temporal payloads do', async () => {
    const request = {
      transactionId: 'tx-json',
      user: createMockUser(),
      targetSystems: ['entra-id'],
      operation: 'CREATE' as const,
      initiatedBy: 'test@example.com',
    };
    const prepared = JSON.parse(
      JSON.stringify(await activities.prepareTransaction(request, TEST_TENANT_ID)),
    );

    const committed = await activities.commitTransaction(request, prepared, TEST_TENANT_ID);

    expect(committed['entra-id']?.status).toBe(SystemTransactionStatus.COMMITTED);
  });

  describe('the account state captured before the commit (personal data)', () => {
    const account = {
      id: 'entra-obj-1',
      userPrincipalName: 'ada.night@corp.example',
      mail: 'ada.night@corp.example',
      displayName: 'Ada Night Porter',
      accountEnabled: true,
    };
    const deleteRequest = (transactionId: string) => ({
      transactionId,
      user: createMockUser(),
      targetSystems: ['entra-id'],
      operation: 'DELETE' as const,
      initiatedBy: 'test@example.com',
    });

    beforeEach(() => {
      (entraService.getUserByEmail as jest.Mock).mockResolvedValue(account);
    });

    it('is stored encrypted under the tenant; the per-system state carries only the reference', async () => {
      const prepared = await activities.prepareTransaction(
        deleteRequest('tx-snap'),
        TEST_TENANT_ID,
      );

      expect(prepared['entra-id']?.previousState).toEqual({ snapshotRef: 'snap-1' });
      expect(stored.get('snap-1')).toEqual({
        tenantId: TEST_TENANT_ID,
        kind: 'entra-account',
        state: account,
      });
      expect(JSON.stringify(prepared)).not.toContain('Night Porter');
      expect(JSON.stringify(prepared)).not.toContain('ada.night@corp.example');
    });

    it('is read back by reference to re-enable the account on rollback', async () => {
      const tx = deleteRequest('tx-snap-restore');
      const prepared = await activities.prepareTransaction(tx, TEST_TENANT_ID);
      const committed = await activities.commitTransaction(tx, prepared, TEST_TENANT_ID);

      const result = await activities.rollbackTransaction(tx, committed, TEST_TENANT_ID);

      expect(result['entra-id']?.status).toBe(SystemTransactionStatus.ROLLED_BACK);
      expect(snapshots.load).toHaveBeenCalledWith(TEST_TENANT_ID, 'entra-account', 'snap-1');
      expect(entraService.patchUser).toHaveBeenCalledWith('entra-obj-1', { accountEnabled: true });
    });

    it('reports an expired snapshot as ROLLBACK_FAILED and leaves the account as it is', async () => {
      const tx = deleteRequest('tx-snap-expired');
      const prepared = await activities.prepareTransaction(tx, TEST_TENANT_ID);
      const committed = await activities.commitTransaction(tx, prepared, TEST_TENANT_ID);
      stored.clear();

      const result = await activities.rollbackTransaction(tx, committed, TEST_TENANT_ID);

      expect(result['entra-id']).toMatchObject({
        status: SystemTransactionStatus.ROLLBACK_FAILED,
        error: 'The snapshot taken before the commit has expired',
      });
      expect(entraService.patchUser).not.toHaveBeenCalled();
      expect(deadLetterService.capture).toHaveBeenCalled();
    });

    it('fails the prepare, before any commit, when the snapshot cannot be stored', async () => {
      snapshots.save.mockRejectedValue(new Error('Mongo down'));

      await expect(
        activities.prepareTransaction(deleteRequest('tx-snap-down'), TEST_TENANT_ID),
      ).rejects.toThrow(ProvisioningException);
      expect(entraActivities.disableEntraUser).not.toHaveBeenCalled();
    });

    it('still restores from the values of transactions prepared before the snapshot store', async () => {
      const tx = deleteRequest('tx-snap-inline');
      const committed = {
        'entra-id': {
          system: 'entra-id',
          status: SystemTransactionStatus.COMMITTED,
          previousState: { ...account },
        },
      };

      const result = await activities.rollbackTransaction(tx, committed, TEST_TENANT_ID);

      expect(result['entra-id']?.status).toBe(SystemTransactionStatus.ROLLED_BACK);
      expect(entraService.patchUser).toHaveBeenCalledWith('entra-obj-1', { accountEnabled: true });
    });

    it('leaves an account that was disabled before the transaction disabled on rollback', async () => {
      (entraService.getUserByEmail as jest.Mock).mockResolvedValue({
        ...account,
        accountEnabled: false,
      });
      const tx = deleteRequest('tx-snap-was-disabled');
      const prepared = await activities.prepareTransaction(tx, TEST_TENANT_ID);
      const committed = await activities.commitTransaction(tx, prepared, TEST_TENANT_ID);

      const result = await activities.rollbackTransaction(tx, committed, TEST_TENANT_ID);

      expect(result['entra-id']?.status).toBe(SystemTransactionStatus.ROLLED_BACK);
      expect(entraService.patchUser).toHaveBeenCalledWith('entra-obj-1', { accountEnabled: false });
      expect(entraService.patchUser).not.toHaveBeenCalledWith('entra-obj-1', {
        accountEnabled: true,
      });
    });

    it('reports a snapshot without accountEnabled as ROLLBACK_FAILED and re-enables nothing', async () => {
      const tx = deleteRequest('tx-snap-no-enabled');
      const { accountEnabled: _unknown, ...withoutEnabled } = account;
      const committed = {
        'entra-id': {
          system: 'entra-id',
          status: SystemTransactionStatus.COMMITTED,
          previousState: withoutEnabled,
        },
      };

      const result = await activities.rollbackTransaction(tx, committed, TEST_TENANT_ID);

      expect(result['entra-id']).toMatchObject({
        status: SystemTransactionStatus.ROLLBACK_FAILED,
        error: 'The snapshot has no accountEnabled value: not restored',
      });
      expect(entraService.patchUser).not.toHaveBeenCalled();
      expect(deadLetterService.capture).toHaveBeenCalled();
    });
  });

  describe('a DELETE never disables an account it could not snapshot first', () => {
    const deleteRequest = (transactionId: string) => ({
      transactionId,
      user: createMockUser(),
      targetSystems: ['entra-id'],
      operation: 'DELETE' as const,
      initiatedBy: 'test@example.com',
    });
    const account = {
      id: 'entra-obj-2',
      userPrincipalName: 'u@corp.example',
      accountEnabled: true,
    };

    it('fails the prepare when the account cannot be read, and disables nothing', async () => {
      (entraService.getUserByEmail as jest.Mock).mockRejectedValue(new Error('Graph 503'));
      const tx = deleteRequest('tx-snap-read-fails');

      await expect(activities.prepareTransaction(tx, TEST_TENANT_ID)).rejects.toThrow(
        ProvisioningException,
      );

      expect(snapshots.save).not.toHaveBeenCalled();
      expect(entraActivities.disableEntraUser).not.toHaveBeenCalled();
      expect(transactionLog.updateTransactionPhase).toHaveBeenCalledWith(
        'tx-snap-read-fails',
        'FAILED',
        [expect.objectContaining({ systemName: 'entra-id', status: 'FAILED', error: 'Graph 503' })],
      );
      // The lock was released: the next transaction for the user prepares.
      (entraService.getUserByEmail as jest.Mock).mockResolvedValue(account);
      const next = { ...deleteRequest('tx-after-read-fails'), user: tx.user };
      await expect(activities.prepareTransaction(next, TEST_TENANT_ID)).resolves.toBeDefined();
    });

    it('fails the prepare when there is no account to disable', async () => {
      await expect(
        activities.prepareTransaction(deleteRequest('tx-no-account'), TEST_TENANT_ID),
      ).rejects.toThrow(ProvisioningException);
      expect(transactionLog.updateTransactionPhase).toHaveBeenCalledWith(
        'tx-no-account',
        'FAILED',
        [
          expect.objectContaining({
            error: 'No Entra ID account for this user: nothing to disable',
          }),
        ],
      );
    });

    it('does not commit a DELETE prepared without a snapshot', async () => {
      const prepared = {
        'entra-id': { system: 'entra-id', status: SystemTransactionStatus.PREPARED },
      };

      const result = await activities.commitTransaction(
        deleteRequest('tx-commit-no-snapshot'),
        prepared,
        TEST_TENANT_ID,
      );

      expect(result['entra-id']).toMatchObject({
        status: SystemTransactionStatus.FAILED,
        error: 'No snapshot of the Entra ID account was taken before the commit: not disabling it',
      });
      expect(entraActivities.disableEntraUser).not.toHaveBeenCalled();
    });

    it('reports a DELETE whose account was gone at commit as FAILED, not COMMITTED', async () => {
      (entraService.getUserByEmail as jest.Mock).mockResolvedValue(account);
      entraActivities.disableEntraUser.mockResolvedValue(false);
      const tx = deleteRequest('tx-gone-at-commit');
      const prepared = await activities.prepareTransaction(tx, TEST_TENANT_ID);

      const result = await activities.commitTransaction(tx, prepared, TEST_TENANT_ID);

      expect(result['entra-id']).toMatchObject({
        status: SystemTransactionStatus.FAILED,
        error: 'The Entra ID account to disable was not found',
      });
    });

    it('reports a committed DELETE without a snapshot as ROLLBACK_FAILED, never ROLLED_BACK', async () => {
      // Committed by code that went ahead without a snapshot: nothing says which account to re-enable.
      const committed = {
        'entra-id': { system: 'entra-id', status: SystemTransactionStatus.COMMITTED },
      };

      const result = await activities.rollbackTransaction(
        deleteRequest('tx-rollback-no-snapshot'),
        committed,
        TEST_TENANT_ID,
      );

      expect(result['entra-id']).toMatchObject({
        status: SystemTransactionStatus.ROLLBACK_FAILED,
        error: 'No snapshot of the account was taken before the commit: not re-enabled',
      });
      expect(entraService.patchUser).not.toHaveBeenCalled();
      expect(deadLetterService.capture).toHaveBeenCalled();
    });
  });

  describe('an UPDATE', () => {
    const before = { jobTitle: 'Night Porter', department: null, givenName: 'Ada' };
    const updateRequest = (transactionId: string) => ({
      transactionId,
      user: createMockUser({ jobTitle: 'Day Porter', departmentName: 'Front Desk' }),
      targetSystems: ['entra-id'],
      operation: 'UPDATE' as const,
      initiatedBy: 'test@example.com',
    });

    beforeEach(() => {
      (entraService.captureUserState as jest.Mock).mockResolvedValue({
        existed: true,
        objectId: 'entra-obj-upd',
        attributes: before,
      });
    });

    it('captures the attributes it will write, stored encrypted, before the commit', async () => {
      const tx = updateRequest('tx-upd-prepare');

      const prepared = await activities.prepareTransaction(tx, TEST_TENANT_ID);

      expect(entraService.captureUserState).toHaveBeenCalledWith(tx.user);
      expect(prepared['entra-id']?.previousState).toEqual({ snapshotRef: 'snap-1' });
      expect(stored.get('snap-1')).toEqual({
        tenantId: TEST_TENANT_ID,
        kind: 'entra-account',
        state: { id: 'entra-obj-upd', attributes: before },
      });
    });

    it('writes the update to the captured Entra account and reports COMMITTED', async () => {
      const tx = updateRequest('tx-upd-commit');
      const prepared = await activities.prepareTransaction(tx, TEST_TENANT_ID);

      const result = await activities.commitTransaction(tx, prepared, TEST_TENANT_ID);

      expect(entraService.updateUser).toHaveBeenCalledWith('entra-obj-upd', tx.user);
      expect(result['entra-id']?.status).toBe(SystemTransactionStatus.COMMITTED);
    });

    it('reports FAILED when Entra rejects the update', async () => {
      (entraService.updateUser as jest.Mock).mockRejectedValue(new Error('Graph 400'));
      const tx = updateRequest('tx-upd-rejected');
      const prepared = await activities.prepareTransaction(tx, TEST_TENANT_ID);

      const result = await activities.commitTransaction(tx, prepared, TEST_TENANT_ID);

      expect(result['entra-id']).toMatchObject({
        status: SystemTransactionStatus.FAILED,
        error: 'Graph 400',
      });
    });

    it('writes the captured values back on rollback', async () => {
      const tx = updateRequest('tx-upd-rollback');
      const prepared = await activities.prepareTransaction(tx, TEST_TENANT_ID);
      const committed = await activities.commitTransaction(tx, prepared, TEST_TENANT_ID);

      const result = await activities.rollbackTransaction(tx, committed, TEST_TENANT_ID);

      expect(entraService.restoreUserState).toHaveBeenCalledWith('entra-obj-upd', before);
      expect(result['entra-id']?.status).toBe(SystemTransactionStatus.ROLLED_BACK);
      expect(entraService.patchUser).not.toHaveBeenCalled();
    });

    it('fails the prepare when the user has no Entra account to update', async () => {
      (entraService.captureUserState as jest.Mock).mockResolvedValue({ existed: false });

      await expect(
        activities.prepareTransaction(updateRequest('tx-upd-no-account'), TEST_TENANT_ID),
      ).rejects.toThrow(ProvisioningException);
      expect(entraService.updateUser).not.toHaveBeenCalled();
    });

    it('neither commits nor claims to restore one prepared without the attributes', async () => {
      // Prepared before UPDATE was implemented: the snapshot has no attribute values.
      const legacy = { id: 'entra-obj-upd', accountEnabled: true };
      const tx = updateRequest('tx-upd-legacy');
      const prepared = {
        'entra-id': {
          system: 'entra-id',
          status: SystemTransactionStatus.PREPARED,
          previousState: legacy,
        },
      };
      const committed = {
        'entra-id': {
          system: 'entra-id',
          status: SystemTransactionStatus.COMMITTED,
          previousState: legacy,
        },
      };

      const commit = await activities.commitTransaction(tx, prepared, TEST_TENANT_ID);
      const rollback = await activities.rollbackTransaction(tx, committed, TEST_TENANT_ID);

      expect(commit['entra-id']?.status).toBe(SystemTransactionStatus.FAILED);
      expect(entraService.updateUser).not.toHaveBeenCalled();
      expect(rollback['entra-id']?.status).toBe(SystemTransactionStatus.ROLLBACK_FAILED);
      expect(entraService.restoreUserState).not.toHaveBeenCalled();
    });
  });

  describe('transaction log', () => {
    const request = (transactionId: string, targetSystems = ['entra-id']) => ({
      transactionId,
      user: createMockUser(),
      targetSystems,
      operation: 'CREATE' as const,
      initiatedBy: 'test@example.com',
    });
    const phases = () => transactionLog.updateTransactionPhase.mock.calls.map((c) => c[1]);

    it('records PREPARED, COMMITTING and COMMITTED with each system', async () => {
      const tx = request('tx-log-commit');
      const prepared = await activities.prepareTransaction(tx, TEST_TENANT_ID);
      await activities.commitTransaction(tx, prepared, TEST_TENANT_ID);

      expect(phases()).toEqual(['PREPARED', 'COMMITTING', 'COMMITTED']);
      expect(transactionLog.updateTransactionPhase).toHaveBeenLastCalledWith(
        'tx-log-commit',
        'COMMITTED',
        [
          expect.objectContaining({
            systemName: 'entra-id',
            status: 'COMMITTED',
            committedAt: expect.any(String),
          }),
        ],
      );
    });

    it('records FAILED when a prepare fails', async () => {
      (entraService.existingAccountFor as jest.Mock).mockResolvedValue('obj-existing');
      await expect(
        activities.prepareTransaction(request('tx-log-prepare'), TEST_TENANT_ID),
      ).rejects.toThrow(ProvisioningException);

      expect(transactionLog.updateTransactionPhase).toHaveBeenCalledWith(
        'tx-log-prepare',
        'FAILED',
        [expect.objectContaining({ systemName: 'entra-id', status: 'FAILED' })],
      );
    });

    it('records FAILED after a failed commit, then ROLLING_BACK and ROLLBACK_FAILED', async () => {
      (entraService.deleteUser as jest.Mock).mockRejectedValue(new Error('Graph 503'));
      const tx = request('tx-log-rollback', ['entra-id', 'file-outbound']);
      const prepared = await activities.prepareTransaction(
        { ...tx, targetSystems: ['entra-id'] },
        TEST_TENANT_ID,
      );
      const committed = await activities.commitTransaction(
        tx,
        preparedBeforeSystemCheck(prepared, 'file-outbound'),
        TEST_TENANT_ID,
      );
      await activities.rollbackTransaction(tx, committed, TEST_TENANT_ID);

      expect(phases()).toEqual([
        'PREPARED',
        'COMMITTING',
        'FAILED',
        'ROLLING_BACK',
        'ROLLBACK_FAILED',
      ]);
      expect(transactionLog.updateTransactionPhase).toHaveBeenLastCalledWith(
        'tx-log-rollback',
        'ROLLBACK_FAILED',
        expect.arrayContaining([
          expect.objectContaining({
            systemName: 'entra-id',
            status: 'ROLLBACK_FAILED',
            error: 'Graph 503',
          }),
          expect.objectContaining({ systemName: 'file-outbound', status: 'FAILED' }),
        ]),
      );
    });

    it('records ROLLED_BACK when every committed system was restored', async () => {
      const tx = request('tx-log-restored');
      const prepared = await activities.prepareTransaction(tx, TEST_TENANT_ID);
      const committed = await activities.commitTransaction(tx, prepared, TEST_TENANT_ID);
      await activities.rollbackTransaction(tx, committed, TEST_TENANT_ID);

      expect(phases().slice(-2)).toEqual(['ROLLING_BACK', 'ROLLED_BACK']);
    });

    it('keeps the participants of a failed prepare when the rollback has no systems', async () => {
      await activities.rollbackTransaction(request('tx-log-empty'), {}, TEST_TENANT_ID);

      expect(transactionLog.updateTransactionPhase).toHaveBeenLastCalledWith(
        'tx-log-empty',
        'ROLLED_BACK',
        undefined,
      );
    });

    it('never fails a commit because the log write failed', async () => {
      transactionLog.updateTransactionPhase.mockRejectedValue(new Error('Mongo down'));
      const tx = request('tx-log-down');
      const prepared = await activities.prepareTransaction(tx, TEST_TENANT_ID);

      const committed = await activities.commitTransaction(tx, prepared, TEST_TENANT_ID);

      expect(committed['entra-id']?.status).toBe(SystemTransactionStatus.COMMITTED);
    });
  });

  describe('logs', () => {
    it("never carry the user's email, on any path", async () => {
      const logged: string[] = [];
      const spies = (['log', 'debug', 'warn', 'error'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
          logged.push(args.map(String).join(' '));
        }),
      );
      const user = createMockUser({ email: 'ada.night@corp.example' });
      const tx = (transactionId: string, operation: 'CREATE' | 'UPDATE' | 'DELETE') => ({
        transactionId,
        user,
        targetSystems: ['entra-id'],
        operation,
        initiatedBy: 'test@example.com',
      });
      const roundTrip = async (request: ReturnType<typeof tx>) => {
        const prepared = await activities.prepareTransaction(request, TEST_TENANT_ID);
        const committed = await activities.commitTransaction(request, prepared, TEST_TENANT_ID);
        await activities.rollbackTransaction(request, committed, TEST_TENANT_ID);
      };
      try {
        await roundTrip(tx('tx-log-create', 'CREATE'));
        (entraService.getUserByEmail as jest.Mock).mockResolvedValue({
          id: 'entra-obj-log',
          userPrincipalName: user.email,
          mail: user.email,
          accountEnabled: true,
        });
        await roundTrip(tx('tx-log-delete', 'DELETE'));
        (entraService.captureUserState as jest.Mock).mockResolvedValue({
          existed: true,
          objectId: 'entra-obj-log',
          attributes: { jobTitle: 'Night Porter' },
        });
        await roundTrip(tx('tx-log-update', 'UPDATE'));
        (entraService.patchUser as jest.Mock).mockRejectedValue(new Error('Graph 503'));
        await roundTrip(tx('tx-log-restore-fails', 'DELETE'));
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }

      expect(logged.some((line) => line.includes('Restore failed for tx-log-restore-fails'))).toBe(
        true,
      );
      expect(logged.filter((line) => line.includes('ada.night'))).toEqual([]);
    });
  });

  describe('tenant context rejection', () => {
    it('should throw when tenantId is empty', async () => {
      const user = createMockUser();
      const request = {
        transactionId: 'tx-5',
        user,
        targetSystems: ['entra-id'],
        operation: 'CREATE' as const,
        initiatedBy: 'test@example.com',
      };

      await expect(activities.prepareTransaction(request, '')).rejects.toThrow('[SECURITY]');
    });
  });
});
