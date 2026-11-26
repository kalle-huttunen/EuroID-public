/**
 * recordCreatedAccount (HX-E3): a bulk CREATE records the Entra ID object id it made for the
 * identity, so access requests, offboarding and the mover find the account by it. Before, bulk
 * provisioning recorded none, and access requests for those people ended REJECTED. The identity
 * is the one the operation's Hub write saved, else the one with the operation's source key,
 * else its email (markRemovedAccounts' matching); nothing is created, and a failure never fails
 * the operation (the account exists in Entra ID either way).
 */
import {
  recordCreatedAccount,
  recordEntraSynced,
  recordProvisionedEntraAccount,
  type CreatedAccountDeps,
  type EntraSyncedDeps,
} from './bulk-provisioning-created-account';

describe('recordCreatedAccount', () => {
  const findIdentityBySourceKey = jest.fn();
  const findIdentityByEmail = jest.fn();
  const recordTargetAccountId = jest.fn();
  const warn = jest.fn();
  const deps = (identityId?: string) =>
    ({
      identity: { findIdentityBySourceKey, findIdentityByEmail, recordTargetAccountId },
      tenantId: 'tenant-a',
      logger: { warn },
      ...(identityId ? { identityId } : {}),
    }) as unknown as CreatedAccountDeps;
  const user = { email: 'ada@x.test', sourceSystem: 'CSV HR', sourceUserId: 'E-1' };

  beforeEach(() => {
    jest.resetAllMocks();
    recordTargetAccountId.mockResolvedValue('recorded');
  });

  it('records the object id for the identity the Hub write saved', async () => {
    expect(await recordCreatedAccount(user, 'obj-1', deps('id-1'))).toBe('recorded');

    expect(recordTargetAccountId).toHaveBeenCalledWith('id-1', 'entra-id', 'obj-1');
    expect(findIdentityBySourceKey).not.toHaveBeenCalled();
    expect(findIdentityByEmail).not.toHaveBeenCalled();
  });

  it('finds the identity by its source key when the run passed no identity id', async () => {
    findIdentityBySourceKey.mockResolvedValue({ _id: 'id-2' });

    expect(await recordCreatedAccount(user, 'obj-1', deps())).toBe('recorded');

    expect(findIdentityBySourceKey).toHaveBeenCalledWith('csv-hr', 'E-1', 'tenant-a');
    expect(findIdentityByEmail).not.toHaveBeenCalled();
    expect(recordTargetAccountId).toHaveBeenCalledWith('id-2', 'entra-id', 'obj-1');
  });

  it('else by its email', async () => {
    findIdentityBySourceKey.mockResolvedValue(null);
    findIdentityByEmail.mockResolvedValue({ _id: 'id-3' });

    expect(await recordCreatedAccount(user, 'obj-1', deps())).toBe('recorded');

    expect(findIdentityByEmail).toHaveBeenCalledWith('ada@x.test', { tenantId: 'tenant-a' });
    expect(recordTargetAccountId).toHaveBeenCalledWith('id-3', 'entra-id', 'obj-1');
  });

  it('records nothing, and says so, for an identity it does not find', async () => {
    findIdentityBySourceKey.mockResolvedValue(null);
    findIdentityByEmail.mockResolvedValue(null);

    expect(await recordCreatedAccount(user, 'obj-1', deps())).toBe('identity-not-found');
    expect(recordTargetAccountId).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('logs an id it could not record (another one recorded, another identity has it)', async () => {
    recordTargetAccountId.mockResolvedValue('other-recorded');

    expect(await recordCreatedAccount(user, 'obj-1', deps('id-1'))).toBe('other-recorded');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('other-recorded'));
  });

  it('never throws: a failed write is logged', async () => {
    recordTargetAccountId.mockRejectedValue(new Error('mongo down'));

    expect(await recordCreatedAccount(user, 'obj-1', deps('id-1'))).toBe('failed');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mongo down'));
  });
});

// HX-E4: a bulk CREATE or UPDATE wrote no Entra ID provisioning entry, so provisionedSystems
// never listed Entra ID for those people: the mover never changed their Entra ID access, and
// offboarding reached them only through its no-provisioning-state fallback.
describe('recordEntraSynced', () => {
  const findIdentityBySourceKey = jest.fn();
  const findIdentityByEmail = jest.fn();
  const findIdentityById = jest.fn();
  const updateProvisioningState = jest.fn();
  const warn = jest.fn();
  const deps = (identityId?: string) =>
    ({
      identity: {
        findIdentityBySourceKey,
        findIdentityByEmail,
        findIdentityById,
        updateProvisioningState,
      },
      tenantId: 'tenant-a',
      logger: { warn },
      ...(identityId ? { identityId } : {}),
    }) as unknown as EntraSyncedDeps;
  const user = { email: 'ada@x.test', sourceSystem: 'CSV HR', sourceUserId: 'E-1' };

  beforeEach(() => jest.resetAllMocks());

  it("marks the saved identity's Entra ID entry SYNCED, creating it as entra-id when none", async () => {
    findIdentityById.mockResolvedValue({ _id: 'id-1', provisioning: [] });

    expect(await recordEntraSynced(user, deps('id-1'))).toBe('synced');

    expect(findIdentityById).toHaveBeenCalledWith('id-1');
    expect(updateProvisioningState).toHaveBeenCalledWith('id-1', 'entra-id', 'SYNCED');
  });

  it('marks the existing entry under the name onboarding gave it (entra)', async () => {
    findIdentityById.mockResolvedValue({
      _id: 'id-1',
      provisioning: [
        { targetSystem: 'ad', status: 'SYNCED' },
        { targetSystem: 'entra', status: 'DEPROVISIONED' },
      ],
    });

    await recordEntraSynced(user, deps('id-1'));

    expect(updateProvisioningState).toHaveBeenCalledTimes(1);
    expect(updateProvisioningState).toHaveBeenCalledWith('id-1', 'entra', 'SYNCED');
  });

  it('finds the identity by source key, else email, without a saved identity id', async () => {
    findIdentityBySourceKey.mockResolvedValue(null);
    findIdentityByEmail.mockResolvedValue({ _id: 'id-3', provisioning: [] });

    expect(await recordEntraSynced(user, deps())).toBe('synced');

    expect(findIdentityBySourceKey).toHaveBeenCalledWith('csv-hr', 'E-1', 'tenant-a');
    expect(updateProvisioningState).toHaveBeenCalledWith('id-3', 'entra-id', 'SYNCED');
  });

  it('creates no identity and writes nothing for an operation whose identity it does not find', async () => {
    findIdentityBySourceKey.mockResolvedValue(null);
    findIdentityByEmail.mockResolvedValue(null);

    expect(await recordEntraSynced(user, deps())).toBe('identity-not-found');
    expect(updateProvisioningState).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('never throws: a failed write is logged', async () => {
    findIdentityById.mockResolvedValue({ _id: 'id-1', provisioning: [] });
    updateProvisioningState.mockRejectedValue(new Error('mongo down'));

    expect(await recordEntraSynced(user, deps('id-1'))).toBe('failed');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mongo down'));
  });
});

// Final review ID2: the entry was marked SYNCED whatever recording the account id answered, so
// an identity whose new account id another live identity holds (`taken`), or whose account a
// deprovision removed (`removed`), looked as if it owned an Entra ID account.
describe('recordProvisionedEntraAccount', () => {
  const findIdentityBySourceKey = jest.fn();
  const findIdentityByEmail = jest.fn();
  const findIdentityById = jest.fn();
  const recordTargetAccountId = jest.fn();
  const updateProvisioningState = jest.fn();
  const warn = jest.fn();
  const deps = {
    identity: {
      findIdentityBySourceKey,
      findIdentityByEmail,
      findIdentityById,
      recordTargetAccountId,
      updateProvisioningState,
    },
    tenantId: 'tenant-a',
    logger: { warn },
    identityId: 'id-1',
  } as unknown as CreatedAccountDeps & EntraSyncedDeps;
  const user = { email: 'ada@x.test', sourceSystem: 'CSV HR', sourceUserId: 'E-1' };

  beforeEach(() => {
    jest.resetAllMocks();
    findIdentityById.mockResolvedValue({ _id: 'id-1', provisioning: [] });
  });

  it.each(['recorded', 'already'])(
    'marks the entry SYNCED when the account id was %s',
    async (outcome) => {
      recordTargetAccountId.mockResolvedValue(outcome);

      await recordProvisionedEntraAccount(user, 'obj-1', deps);

      expect(updateProvisioningState).toHaveBeenCalledWith('id-1', 'entra-id', 'SYNCED');
    },
  );

  it('marks the entry SYNCED for an operation that returned no object id', async () => {
    await recordProvisionedEntraAccount(user, undefined, deps);

    expect(recordTargetAccountId).not.toHaveBeenCalled();
    expect(updateProvisioningState).toHaveBeenCalledWith('id-1', 'entra-id', 'SYNCED');
  });

  it.each(['taken', 'removed', 'other-recorded', 'identity-not-found', 'failed'])(
    'marks nothing, and logs it, when recording the account id answered %s',
    async (outcome) => {
      if (outcome === 'failed') recordTargetAccountId.mockRejectedValue(new Error('mongo down'));
      else if (outcome === 'identity-not-found') {
        findIdentityBySourceKey.mockResolvedValue(null);
        findIdentityByEmail.mockResolvedValue(null);
      } else recordTargetAccountId.mockResolvedValue(outcome);
      const noSavedId =
        outcome === 'identity-not-found' ? { ...deps, identityId: undefined } : deps;

      await recordProvisionedEntraAccount(user, 'obj-1', noSavedId);

      expect(updateProvisioningState).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not marked SYNCED'));
    },
  );
});
