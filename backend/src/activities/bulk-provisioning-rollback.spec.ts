/**
 * compensateOperation per connector type: a rollback either undoes a system's change or says
 * it did not and why. It must never report a rollback that did not happen.
 */
import { compensateOperation, type RollbackDeps } from './bulk-provisioning-rollback';
import {
  BulkOperationType,
  type OperationResult,
  type SystemOperationResult,
} from '@shared/dtos/bulk-operation.dto';

describe('compensateOperation', () => {
  let deps: RollbackDeps & {
    entraActivities: { disableEntraUser: jest.Mock; enableEntraUser: jest.Mock };
    entraService: { disableUser: jest.Mock; restoreUserState: jest.Mock };
    snapshots: { load: jest.Mock };
    identity: {
      restoreHubState: jest.Mock;
      removeIdentity: jest.Mock;
      restoreConflictFlags: jest.Mock;
    };
  };

  beforeEach(() => {
    deps = {
      entraActivities: {
        disableEntraUser: jest.fn().mockResolvedValue(true),
        enableEntraUser: jest.fn().mockResolvedValue(true),
      },
      entraService: {
        disableUser: jest.fn().mockResolvedValue(true),
        restoreUserState: jest.fn().mockResolvedValue(undefined),
      },
      snapshots: { load: jest.fn().mockResolvedValue(null) },
      identity: {
        restoreHubState: jest.fn().mockResolvedValue(true),
        removeIdentity: jest.fn().mockResolvedValue(true),
        restoreConflictFlags: jest.fn().mockResolvedValue(true),
      },
      tenantId: 'tenant-a',
      correlationId: 'corr-1',
    };
  });

  const operation = (
    type: BulkOperationType,
    systemResults: Array<Partial<SystemOperationResult> & { system: string }>,
  ): OperationResult => ({
    operationId: 'op-1',
    success: systemResults.every((r) => r.success !== false),
    type,
    userId: 'ada',
    email: 'ada@example.com',
    systemResults: systemResults.map((r) => ({
      success: true,
      apiCallsUsed: 1,
      durationMs: 1,
      ...r,
    })),
    startedAt: new Date(0),
    completedAt: new Date(0),
    durationMs: 0,
  });

  const entraCalls = () => [
    ...deps.entraActivities.disableEntraUser.mock.calls,
    ...deps.entraActivities.enableEntraUser.mock.calls,
    ...deps.entraService.disableUser.mock.calls,
    ...deps.entraService.restoreUserState.mock.calls,
  ];

  describe('entra-id', () => {
    it('disables an account the CREATE created, by its object ID', async () => {
      const outcome = await compensateOperation(
        operation(BulkOperationType.CREATE, [
          { system: 'entra-id', objectId: 'obj-1', previousState: { existed: false } },
        ]),
        deps,
      );

      expect(outcome.rolledBack).toBe(true);
      expect(deps.entraService.disableUser).toHaveBeenCalledWith('obj-1');
      expect(deps.entraService.restoreUserState).not.toHaveBeenCalled();
    });

    it.each([BulkOperationType.CREATE, BulkOperationType.UPDATE])(
      'restores the attributes an account had before a %s instead of disabling it',
      async (type) => {
        const attributes = { jobTitle: 'Analyst', department: null };
        const outcome = await compensateOperation(
          operation(type, [
            {
              system: 'entra-id',
              objectId: 'obj-1',
              previousState: { existed: true, objectId: 'obj-1', attributes },
            },
          ]),
          deps,
        );

        expect(outcome).toEqual({
          rolledBack: true,
          reason: 'Batch failed, compensating transaction',
          systems: [
            {
              system: 'entra-id',
              rolledBack: true,
              reason: 'attributes restored from the snapshot taken before the change',
            },
          ],
        });
        expect(deps.entraService.restoreUserState).toHaveBeenCalledWith('obj-1', attributes);
        expect(deps.entraService.disableUser).not.toHaveBeenCalled();
        expect(deps.entraActivities.disableEntraUser).not.toHaveBeenCalled();
      },
    );

    it('restores the values from the encrypted snapshot store, read under the tenant', async () => {
      const attributes = { mobilePhone: '+358 40 765 4321', jobTitle: 'Analyst' };
      deps.snapshots.load.mockResolvedValue(attributes);

      const outcome = await compensateOperation(
        operation(BulkOperationType.UPDATE, [
          {
            system: 'entra-id',
            objectId: 'obj-1',
            previousState: { existed: true, objectId: 'obj-1', snapshotRef: 'snap-1' },
          },
        ]),
        deps,
      );

      expect(outcome.rolledBack).toBe(true);
      expect(deps.snapshots.load).toHaveBeenCalledWith('tenant-a', 'entra-attributes', 'snap-1');
      expect(deps.entraService.restoreUserState).toHaveBeenCalledWith('obj-1', attributes);
    });

    it('restores the values of a keyed whole-state snapshot (entra-state)', async () => {
      const attributes = { mobilePhone: '+358 40 765 4321', jobTitle: 'Analyst' };
      deps.snapshots.load.mockResolvedValue({ existed: true, objectId: 'obj-1', attributes });
      const previousState = {
        existed: true,
        objectId: 'obj-1',
        snapshotRef: 'snap-1',
        snapshotKind: 'entra-state' as const,
      };

      const outcome = await compensateOperation(
        operation(BulkOperationType.UPDATE, [
          { system: 'entra-id', objectId: 'obj-1', previousState },
        ]),
        deps,
      );

      expect(outcome.rolledBack).toBe(true);
      expect(deps.snapshots.load).toHaveBeenCalledWith('tenant-a', 'entra-state', 'snap-1');
      expect(deps.entraService.restoreUserState).toHaveBeenCalledWith('obj-1', attributes);
    });

    it('reports an expired entra-state snapshot as not rolled back', async () => {
      const previousState = {
        existed: true,
        objectId: 'obj-1',
        snapshotRef: 'snap-gone',
        snapshotKind: 'entra-state' as const,
      };

      const outcome = await compensateOperation(
        operation(BulkOperationType.UPDATE, [
          { system: 'entra-id', objectId: 'obj-1', previousState },
        ]),
        deps,
      );

      expect(outcome.rolledBack).toBe(false);
      expect(entraCalls()).toEqual([]);
    });

    it('reports an expired snapshot as not rolled back and leaves the account as it is', async () => {
      const outcome = await compensateOperation(
        operation(BulkOperationType.UPDATE, [
          {
            system: 'entra-id',
            objectId: 'obj-1',
            previousState: { existed: true, objectId: 'obj-1', snapshotRef: 'snap-gone' },
          },
        ]),
        deps,
      );

      expect(outcome).toMatchObject({
        rolledBack: false,
        reason: 'Not rolled back: entra-id: the snapshot taken before the change has expired',
      });
      expect(entraCalls()).toEqual([]);
    });

    it('reports an UPDATE without a snapshot as not rolled back', async () => {
      const outcome = await compensateOperation(
        operation(BulkOperationType.UPDATE, [{ system: 'entra-id', objectId: 'obj-1' }]),
        deps,
      );

      expect(outcome.rolledBack).toBe(false);
      expect(outcome.reason).toBe(
        'Not rolled back: entra-id: no snapshot of the attributes was taken before the UPDATE',
      );
      expect(entraCalls()).toEqual([]);
    });

    it('disables by email a CREATE recorded before snapshots, and says so when not found', async () => {
      const legacy = operation(BulkOperationType.CREATE, [{ system: 'entra-id' }]);
      await expect(compensateOperation(legacy, deps)).resolves.toMatchObject({
        rolledBack: true,
      });
      expect(deps.entraActivities.disableEntraUser).toHaveBeenCalledWith(
        'ada@example.com',
        'tenant-a',
        'corr-1',
      );

      deps.entraActivities.disableEntraUser.mockResolvedValue(false);
      await expect(compensateOperation(legacy, deps)).resolves.toMatchObject({
        rolledBack: false,
        reason: 'Not rolled back: entra-id: account to disable not found',
      });
    });

    it('enables an account the DISABLE disabled', async () => {
      const disabled = operation(BulkOperationType.DISABLE, [{ system: 'entra-id' }]);
      await expect(compensateOperation(disabled, deps)).resolves.toMatchObject({
        rolledBack: true,
      });
      expect(deps.entraActivities.enableEntraUser).toHaveBeenCalledWith(
        'ada@example.com',
        'tenant-a',
        'corr-1',
      );

      deps.entraActivities.enableEntraUser.mockResolvedValue(false);
      await expect(compensateOperation(disabled, deps)).resolves.toMatchObject({
        rolledBack: false,
        reason: 'Not rolled back: entra-id: account to enable not found',
      });
    });

    // Hunt 2026-11-25 02 F9: a CREATE whose license or group step failed after the account was
    // made came back success:false, the rollback skipped it, and the Hub write was undone while
    // the Entra account stayed
    it('undoes a failed CREATE that may have made the account, by email', async () => {
      const outcome = await compensateOperation(
        operation(BulkOperationType.CREATE, [
          {
            system: 'entra-id',
            success: false,
            error: 'group step failed',
            previousState: { existed: false },
          },
        ]),
        deps,
      );

      expect(deps.entraActivities.disableEntraUser).toHaveBeenCalledWith(
        'ada@example.com',
        'tenant-a',
        'corr-1',
      );
      expect(outcome.systems).toEqual([
        { system: 'entra-id', rolledBack: true, reason: 'created account disabled' },
      ]);
    });

    it('has nothing to undo for a failed CREATE that made no account', async () => {
      deps.entraActivities.disableEntraUser.mockResolvedValue(false);

      const outcome = await compensateOperation(
        operation(BulkOperationType.CREATE, [
          { system: 'entra-id', success: false, previousState: { existed: false } },
        ]),
        deps,
      );

      expect(outcome.systems).toEqual([
        { system: 'entra-id', rolledBack: true, reason: 'no account was created' },
      ]);
      expect(outcome.rolledBack).toBe(true);
    });

    it('restores a failed UPDATE from its snapshot', async () => {
      deps.snapshots.load.mockResolvedValue({ existed: true, objectId: 'obj-1', attributes: {} });

      const outcome = await compensateOperation(
        operation(BulkOperationType.UPDATE, [
          {
            system: 'entra-id',
            success: false,
            previousState: {
              existed: true,
              objectId: 'obj-1',
              snapshotRef: 'ref-1',
              snapshotKind: 'entra-state',
            },
          },
        ]),
        deps,
      );

      expect(deps.entraService.restoreUserState).toHaveBeenCalledWith('obj-1', {});
      expect(outcome.rolledBack).toBe(true);
    });

    it('leaves a failed result without a snapshot alone: nothing was changed', async () => {
      const outcome = await compensateOperation(
        operation(BulkOperationType.CREATE, [{ system: 'entra-id', success: false }]),
        deps,
      );

      expect(entraCalls()).toEqual([]);
      expect(outcome.systems).toEqual([]);
    });

    it('reports a DELETE as not reversible and calls Entra no further', async () => {
      const outcome = await compensateOperation(
        operation(BulkOperationType.DELETE, [{ system: 'entra-id' }]),
        deps,
      );

      expect(outcome).toMatchObject({
        rolledBack: false,
        reason: 'Not rolled back: entra-id: a DELETE is not reversible',
      });
      expect(entraCalls()).toEqual([]);
    });

    it('reports a failed restore as not rolled back instead of throwing', async () => {
      deps.entraService.restoreUserState.mockRejectedValue(new Error('Graph 503'));

      const outcome = await compensateOperation(
        operation(BulkOperationType.UPDATE, [
          {
            system: 'entra-id',
            previousState: { existed: true, objectId: 'obj-1', attributes: { city: 'Turku' } },
          },
        ]),
        deps,
      );

      expect(outcome).toMatchObject({
        rolledBack: false,
        reason: 'Not rolled back: entra-id: rollback failed: Graph 503',
      });
    });
  });

  it.each(['file-outbound', 'discord-webhook', 'github', 'google-sheets'])(
    'reports a %s CREATE as not reversible: the connector cannot deprovision',
    async (system) => {
      const outcome = await compensateOperation(
        operation(BulkOperationType.CREATE, [{ system, objectId: 'x-1' }]),
        deps,
      );

      expect(outcome).toEqual({
        rolledBack: false,
        reason: `Not rolled back: ${system}: the ${system} connector cannot deprovision, so a CREATE stays`,
        systems: [
          {
            system,
            rolledBack: false,
            reason: `the ${system} connector cannot deprovision, so a CREATE stays`,
          },
        ],
      });
      expect(entraCalls()).toEqual([]);
    },
  );

  it('undoes what it can in a mixed operation and names what it could not', async () => {
    const outcome = await compensateOperation(
      operation(BulkOperationType.CREATE, [
        { system: 'entra-id', objectId: 'obj-1', previousState: { existed: false } },
        { system: 'github', objectId: 'gh-1' },
        { system: 'file-outbound', success: false, error: 'disk full' },
      ]),
      deps,
    );

    expect(outcome.rolledBack).toBe(false);
    expect(outcome.systems.map((s) => [s.system, s.rolledBack])).toEqual([
      ['entra-id', true],
      ['github', false],
    ]);
    expect(outcome.reason).toBe(
      'Not rolled back: github: the github connector cannot deprovision, so a CREATE stays',
    );
    expect(deps.entraService.disableUser).toHaveBeenCalledWith('obj-1');
  });

  describe('the Golden Record write', () => {
    const hubState = {
      id: 'identity-1',
      profile: { email: 'ada@example.com', jobTitle: 'Analyst' },
      sources: [],
      metadata: { version: 3 },
      deletedAt: null,
      deletedBy: null,
    };
    const withHub = (
      systemResults: Array<Partial<SystemOperationResult> & { system: string }>,
    ): OperationResult => ({
      ...operation(BulkOperationType.UPDATE, systemResults),
      hubWrite: { identityId: 'identity-1', snapshotRef: 'hub-snap-1' },
    });
    const entraUndone = {
      system: 'entra-id',
      objectId: 'obj-1',
      previousState: { existed: false },
    };

    it('is restored from its snapshot after the systems, read under the tenant', async () => {
      deps.snapshots.load.mockResolvedValue({ existed: true, state: hubState });

      const outcome = await compensateOperation(withHub([entraUndone]), deps);

      expect(outcome).toMatchObject({
        rolledBack: true,
        reason: 'Batch failed, compensating transaction',
        hub: {
          rolledBack: true,
          reason: 'Golden Record restored from the snapshot taken before the change',
        },
      });
      expect(deps.snapshots.load).toHaveBeenCalledWith('tenant-a', 'hub-identity', 'hub-snap-1');
      expect(deps.identity.restoreHubState).toHaveBeenCalledWith('identity-1', hubState);
      expect(deps.entraService.disableUser.mock.invocationCallOrder[0]).toBeLessThan(
        deps.identity.restoreHubState.mock.invocationCallOrder[0],
      );
    });

    it('is removed when the operation created the identity', async () => {
      deps.snapshots.load.mockResolvedValue({ existed: false });

      const outcome = await compensateOperation(withHub([]), deps);

      expect(outcome).toMatchObject({
        rolledBack: true,
        hub: { rolledBack: true, reason: 'created Golden Record removed' },
      });
      expect(deps.identity.removeIdentity).toHaveBeenCalledWith('identity-1', 'bulk-rollback');
      expect(deps.identity.restoreHubState).not.toHaveBeenCalled();
    });

    describe('that minted an identity after a low-confidence match flagged another', () => {
      const flagsBefore = { id: 'identity-jane', requiresReview: false };
      /** The Hub snapshot refers to the conflict flags snapshot taken before the flagging. */
      const arrangeSnapshots = (flags: unknown) =>
        deps.snapshots.load.mockImplementation(async (_tenant: string, kind: string) =>
          kind === 'hub-identity' ? { existed: false, conflictRef: 'flags-snap-1' } : flags,
        );

      it('removes the minted identity, then puts back the flags of the one it flagged', async () => {
        arrangeSnapshots(flagsBefore);

        const outcome = await compensateOperation(withHub([]), deps);

        expect(outcome).toMatchObject({
          rolledBack: true,
          hub: {
            rolledBack: true,
            reason:
              'created Golden Record removed and the conflict flags it set on identity identity-jane put back',
          },
        });
        expect(deps.snapshots.load).toHaveBeenCalledWith(
          'tenant-a',
          'hub-conflict-flags',
          'flags-snap-1',
        );
        expect(deps.identity.restoreConflictFlags).toHaveBeenCalledWith(flagsBefore, 'identity-1');
        expect(deps.identity.removeIdentity.mock.invocationCallOrder[0]).toBeLessThan(
          deps.identity.restoreConflictFlags.mock.invocationCallOrder[0],
        );
      });

      it('has nothing more to undo when that conflict was resolved or replaced since', async () => {
        arrangeSnapshots(flagsBefore);
        deps.identity.restoreConflictFlags.mockResolvedValue(false);

        const outcome = await compensateOperation(withHub([]), deps);

        expect(outcome.rolledBack).toBe(true);
        expect(outcome.hub?.reason).toBe(
          'created Golden Record removed; identity identity-jane no longer had the conflict flags it set',
        );
      });

      it.each([
        [
          'an expired flags snapshot',
          () => arrangeSnapshots(null),
          'created Golden Record removed, but the snapshot of the conflict flags it set on another identity has expired',
        ],
        [
          'a failing restore of the flags',
          () => {
            arrangeSnapshots(flagsBefore);
            deps.identity.restoreConflictFlags.mockRejectedValue(new Error('Mongo down'));
          },
          'created Golden Record removed, but putting back the conflict flags failed: Mongo down',
        ],
      ])('reports %s as not rolled back', async (_case, arrange, reason) => {
        arrange();

        const outcome = await compensateOperation(withHub([]), deps);

        expect(outcome).toMatchObject({ rolledBack: false, hub: { rolledBack: false, reason } });
        expect(deps.identity.removeIdentity).toHaveBeenCalledWith('identity-1', 'bulk-rollback');
      });
    });

    it('is kept while a target system still has the change', async () => {
      const outcome = await compensateOperation(
        withHub([{ system: 'github', objectId: 'gh-1' }]),
        deps,
      );

      expect(outcome.rolledBack).toBe(false);
      expect(outcome.hub).toEqual({
        rolledBack: false,
        reason: 'kept, because a target system still has the change',
      });
      expect(outcome.reason).toBe(
        'Not rolled back: github: the github connector cannot deprovision, so a UPDATE stays; ' +
          'hub: kept, because a target system still has the change',
      );
      expect(deps.snapshots.load).not.toHaveBeenCalled();
      expect(deps.identity.restoreHubState).not.toHaveBeenCalled();
      expect(deps.identity.removeIdentity).not.toHaveBeenCalled();
    });

    it.each([
      [
        'an expired snapshot',
        () => deps.snapshots.load.mockResolvedValue(null),
        'the Golden Record snapshot taken before the change has expired',
      ],
      [
        'a snapshot of another identity',
        () =>
          deps.snapshots.load.mockResolvedValue({ existed: true, state: { ...hubState, id: 'x' } }),
        'the snapshot belongs to another Golden Record',
      ],
      [
        'an identity that is gone',
        () => {
          deps.snapshots.load.mockResolvedValue({ existed: true, state: hubState });
          deps.identity.restoreHubState.mockResolvedValue(false);
        },
        'the Golden Record to restore was not found',
      ],
      [
        'a failing restore',
        () => {
          deps.snapshots.load.mockResolvedValue({ existed: true, state: hubState });
          deps.identity.restoreHubState.mockRejectedValue(new Error('Mongo down'));
        },
        'rollback failed: Mongo down',
      ],
    ])('reports %s as not rolled back', async (_case, arrange, reason) => {
      arrange();

      const outcome = await compensateOperation(withHub([]), deps);

      expect(outcome).toMatchObject({
        rolledBack: false,
        reason: `Not rolled back: hub: ${reason}`,
        hub: { rolledBack: false, reason },
      });
    });
  });
});
