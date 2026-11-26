/**
 * markRemovedAccounts: the provisioning entries of the accounts a bulk DISABLE or DELETE removed
 * become DEPROVISIONED, the identity looked up by source key, else email; nothing is created.
 */
import { markRemovedAccounts, type RemovalDeps } from './bulk-provisioning-removals';

const identity = (id: string, provisioning: Array<{ targetSystem: string; status: string }>) => ({
  _id: id,
  provisioning,
});

describe('markRemovedAccounts', () => {
  const findIdentityBySourceKey = jest.fn();
  const findIdentityByEmail = jest.fn();
  const updateProvisioningState = jest.fn();
  const deps = {
    identity: { findIdentityBySourceKey, findIdentityByEmail, updateProvisioningState },
    tenantId: 'tenant-a',
  } as unknown as RemovalDeps;

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('marks only the entries of the removed systems not yet DEPROVISIONED', async () => {
    findIdentityBySourceKey.mockResolvedValue(
      identity('id-1', [
        { targetSystem: 'entra', status: 'SYNCED' },
        { targetSystem: 'entra-tenant-2', status: 'DEPROVISIONED' },
        { targetSystem: 'github', status: 'SYNCED' },
      ]),
    );

    const outcome = await markRemovedAccounts(
      [
        {
          operationId: 'op-1',
          email: 'ada@x.test',
          sourceSystem: 'csv-hr',
          sourceUserId: 'E-1',
          systems: ['entra-id'],
        },
      ],
      deps,
    );

    expect(updateProvisioningState.mock.calls).toEqual([['id-1', 'entra', 'DEPROVISIONED']]);
    expect(findIdentityByEmail).not.toHaveBeenCalled();
    expect(outcome).toEqual({ marked: ['op-1'], notFound: [] });
  });

  it('falls back to the email when the source key finds no identity', async () => {
    findIdentityBySourceKey.mockResolvedValue(null);
    findIdentityByEmail.mockResolvedValue(
      identity('id-2', [{ targetSystem: 'entra-id', status: 'ERROR' }]),
    );

    await markRemovedAccounts(
      [
        {
          operationId: 'op-2',
          email: 'bob@x.test',
          sourceSystem: 'csv-hr',
          sourceUserId: 'E-2',
          systems: ['entra-id'],
        },
      ],
      deps,
    );

    expect(findIdentityByEmail).toHaveBeenCalledWith('bob@x.test', { tenantId: 'tenant-a' });
    expect(updateProvisioningState).toHaveBeenCalledWith('id-2', 'entra-id', 'DEPROVISIONED');
  });

  it('reports an operation whose identity is not found and writes nothing', async () => {
    findIdentityByEmail.mockResolvedValue(null);

    const outcome = await markRemovedAccounts(
      [{ operationId: 'op-3', email: 'nobody@x.test', systems: ['entra-id'] }],
      deps,
    );

    expect(outcome).toEqual({ marked: [], notFound: ['op-3'] });
    expect(updateProvisioningState).not.toHaveBeenCalled();
  });
});
