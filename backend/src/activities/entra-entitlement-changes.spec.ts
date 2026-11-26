/**
 * Entitlement-only changes on the recorded Entra ID account (HX-E2), or on the one account found
 * read-only by the person's identifiers when none is recorded (HX-E3). EntraService is a strict
 * stand-in with only the account lookups and changeEntitlements: a call to provision(),
 * updateUser or anything else that writes attributes or creates an account fails the test.
 */
import { ApplicationFailure } from '@temporalio/common';
import { HttpStatus } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { EntraService } from '../modules/connectors/entra-connector/entra.service';
import { AmbiguousAccountException } from '../modules/connectors/entra-connector/entra-discovery.service';
import type { IdentityService } from '../modules/identity/identity.service';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { EntraEntitlementChanges } from './entra-entitlement-changes';

const IDENTITY = '64b000000000000000000001';
const OBJECT_ID = 'obj-1';
const add = [{ type: 'group' as const, action: 'add' as const, targetId: 'grp-1' }];

const identityWith = (provisioning: Array<Record<string, unknown>> = []) => ({
  _id: IDENTITY,
  sources: [{ sourceName: 'entra-id', sourceRole: 'target', externalId: OBJECT_ID }],
  provisioning,
});

describe('EntraEntitlementChanges', () => {
  let entra: {
    checkUserExists: jest.Mock;
    changeEntitlements: jest.Mock;
    findAccountIdByIdentifiers: jest.Mock;
  };
  let findIdentityById: jest.Mock;
  let recordTargetAccountId: jest.Mock;
  let emit: jest.Mock;
  let changes: EntraEntitlementChanges;

  beforeEach(() => {
    entra = {
      checkUserExists: jest.fn().mockResolvedValue(OBJECT_ID),
      changeEntitlements: jest.fn().mockResolvedValue([{ ...add[0], outcome: 'applied' as const }]),
      findAccountIdByIdentifiers: jest.fn().mockResolvedValue(null),
    };
    findIdentityById = jest.fn().mockResolvedValue(identityWith());
    recordTargetAccountId = jest.fn().mockResolvedValue('recorded');
    emit = jest.fn();
    changes = new EntraEntitlementChanges(
      entra as unknown as EntraService,
      { findIdentityById, recordTargetAccountId } as unknown as IdentityService,
      { emit } as unknown as DomainEventEmitterService,
    );
  });

  it('changes the entitlement on the recorded account and reports it done', async () => {
    const outcome = await changes.change(IDENTITY, add);

    expect(outcome).toEqual({
      status: 'changed',
      operations: [{ ...add[0], outcome: 'applied' }],
    });
    expect(entra.checkUserExists).toHaveBeenCalledWith(OBJECT_ID);
    expect(entra.changeEntitlements).toHaveBeenCalledWith(OBJECT_ID, { operations: add });
    expect(emit).toHaveBeenCalledWith(
      DomainEventType.PROVISIONING_COMPLETED,
      IDENTITY,
      expect.objectContaining({ identityId: IDENTITY, connector: 'entra-id' }),
    );
  });

  // HX-E3 changed this case on purpose: an identity with no recorded account (bulk provisioning
  // wrote none back) is now looked up read-only (the cases below). What stays without any Graph
  // call: a deprovisioned account, a missing identity, an id that is none.
  it('asks nothing of Entra ID when the account was deprovisioned, or there is no identity', async () => {
    findIdentityById.mockResolvedValueOnce(
      identityWith([{ targetSystem: 'entra-id', status: 'DEPROVISIONED' }]),
    );
    expect(await changes.change(IDENTITY, add)).toEqual({ status: 'no-account', recorded: false });

    findIdentityById.mockResolvedValueOnce(null);
    expect(await changes.change(IDENTITY, add)).toEqual({ status: 'no-account', recorded: false });

    expect(await changes.change('not-an-id', add)).toEqual({
      status: 'no-account',
      recorded: false,
    });
    expect(entra.checkUserExists).not.toHaveBeenCalled();
    expect(entra.findAccountIdByIdentifiers).not.toHaveBeenCalled();
  });

  describe('an identity with no recorded account (HX-E3: bulk provisioning recorded none)', () => {
    const PROFILE = {
      email: 'ada@corp.test',
      userPrincipalName: 'ada@corp.test',
      employeeId: 'E1',
    };
    // Final review CP1: the lookup runs only for an identity whose Entra ID entry says an account
    // was provisioned (bulk creates write it now, migration 20261126000007 backfills it), so the
    // default here has one
    const unrecorded = (
      provisioning: Array<Record<string, unknown>> = [
        { targetSystem: 'entra-id', status: 'SYNCED' },
      ],
    ) => ({
      _id: IDENTITY,
      profile: PROFILE,
      sources: [],
      provisioning,
    });

    beforeEach(() => {
      findIdentityById.mockResolvedValue(unrecorded());
      entra.findAccountIdByIdentifiers.mockResolvedValue('obj-9');
    });

    it('looks the account up read-only, records it and changes the entitlement on it', async () => {
      const outcome = await changes.change(IDENTITY, add);

      expect(outcome).toMatchObject({ status: 'changed' });
      expect(entra.findAccountIdByIdentifiers).toHaveBeenCalledWith({
        userPrincipalName: 'ada@corp.test',
        email: 'ada@corp.test',
        employeeId: 'E1',
      });
      expect(recordTargetAccountId).toHaveBeenCalledWith(IDENTITY, 'entra-id', 'obj-9');
      expect(entra.changeEntitlements).toHaveBeenCalledWith('obj-9', { operations: add });
      expect(emit).toHaveBeenCalledWith(
        DomainEventType.PROVISIONING_COMPLETED,
        IDENTITY,
        expect.objectContaining({ targetUserId: 'obj-9' }),
      );
    });

    it('also with the entry under the name onboarding gives it (entra)', async () => {
      findIdentityById.mockResolvedValue(unrecorded([{ targetSystem: 'entra', status: 'SYNCED' }]));

      expect(await changes.change(IDENTITY, add)).toMatchObject({ status: 'changed' });
      expect(entra.changeEntitlements).toHaveBeenCalledWith('obj-9', { operations: add });
    });

    // Final review CP1: an identity that never had an Entra ID account (SCIM-created, say) was
    // matched by its email to a foreign account (a guest, a shared mailbox), which was then
    // changed and recorded as the person's
    it.each([
      ['no Entra ID entry', []],
      ['an entry that never synced', [{ targetSystem: 'entra-id', status: 'PENDING' }]],
      ['only another system', [{ targetSystem: 'scim', status: 'SYNCED' }]],
    ])('looks nothing up, and says no account, with %s', async (_label, provisioning) => {
      findIdentityById.mockResolvedValue(unrecorded(provisioning));

      expect(await changes.change(IDENTITY, add)).toEqual({
        status: 'no-account',
        recorded: false,
      });
      expect(entra.findAccountIdByIdentifiers).not.toHaveBeenCalled();
      expect(recordTargetAccountId).not.toHaveBeenCalled();
      expect(entra.changeEntitlements).not.toHaveBeenCalled();
    });

    it('keeps the refusal when no account has the identifiers', async () => {
      entra.findAccountIdByIdentifiers.mockResolvedValue(null);

      expect(await changes.change(IDENTITY, add)).toEqual({
        status: 'no-account',
        recorded: false,
      });
      expect(recordTargetAccountId).not.toHaveBeenCalled();
      expect(entra.changeEntitlements).not.toHaveBeenCalled();
    });

    it('keeps the refusal when more than one account has them, choosing neither', async () => {
      entra.findAccountIdByIdentifiers.mockRejectedValue(new AmbiguousAccountException('email'));

      expect(await changes.change(IDENTITY, add)).toEqual({
        status: 'no-account',
        recorded: false,
      });
      expect(recordTargetAccountId).not.toHaveBeenCalled();
      expect(entra.changeEntitlements).not.toHaveBeenCalled();
    });

    it.each(['taken', 'other-recorded', 'removed', 'not-found'])(
      'changes nothing when the account cannot be recorded for the person (%s)',
      async (recordOutcome) => {
        recordTargetAccountId.mockResolvedValue(recordOutcome);

        expect(await changes.change(IDENTITY, add)).toEqual({
          status: 'no-account',
          recorded: false,
        });
        expect(entra.changeEntitlements).not.toHaveBeenCalled();
      },
    );

    it('has nothing to look up by without identifiers', async () => {
      findIdentityById.mockResolvedValue({ ...unrecorded(), profile: {} });

      expect(await changes.change(IDENTITY, add)).toEqual({
        status: 'no-account',
        recorded: false,
      });
      expect(entra.findAccountIdByIdentifiers).not.toHaveBeenCalled();
    });

    it('throws a lookup failure retrying can fix, and returns a refusal it cannot', async () => {
      entra.findAccountIdByIdentifiers.mockRejectedValueOnce(new Error('socket hang up'));
      await expect(changes.change(IDENTITY, add)).rejects.toThrow('socket hang up');

      entra.findAccountIdByIdentifiers.mockRejectedValueOnce(
        new ConnectorException('Insufficient privileges', HttpStatus.FORBIDDEN),
      );
      expect(await changes.change(IDENTITY, add)).toEqual({
        status: 'refused',
        reason: expect.stringContaining('Insufficient privileges'),
      });
      expect(recordTargetAccountId).not.toHaveBeenCalled();
    });
  });

  it('says no account when Entra ID no longer has the recorded one', async () => {
    entra.checkUserExists.mockResolvedValue(null);

    expect(await changes.change(IDENTITY, add)).toEqual({ status: 'no-account', recorded: true });
    expect(entra.changeEntitlements).not.toHaveBeenCalled();
  });

  it('returns a refusal retrying cannot fix, with the reason, instead of throwing', async () => {
    entra.changeEntitlements.mockResolvedValue([
      { ...add[0], outcome: 'failed', reason: 'Insufficient privileges', status: 400 },
    ]);

    const outcome = await changes.change(IDENTITY, add);

    expect(outcome).toEqual({
      status: 'refused',
      reason: expect.stringContaining('Insufficient privileges'),
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('returns refused credentials or a missing config as a refusal', async () => {
    entra.checkUserExists.mockRejectedValue(
      new ConnectorException('credentials refused', HttpStatus.UNAUTHORIZED),
    );

    expect(await changes.change(IDENTITY, add)).toEqual({
      status: 'refused',
      reason: expect.stringContaining('credentials refused'),
    });
  });

  it('throws what retrying can fix: a 5xx or no answer, and a 429', async () => {
    entra.changeEntitlements.mockResolvedValueOnce([
      { ...add[0], outcome: 'failed', reason: 'Service unavailable', status: 502 },
    ]);
    const unavailable = await changes.change(IDENTITY, add).catch((e: unknown) => e);
    expect(unavailable).toBeInstanceOf(Error);
    expect(unavailable).not.toBeInstanceOf(ApplicationFailure);

    entra.changeEntitlements.mockResolvedValueOnce([
      { ...add[0], outcome: 'failed', reason: 'Too many requests', status: 429 },
    ]);
    await expect(changes.change(IDENTITY, add)).rejects.toBeInstanceOf(RateLimitedException);

    entra.checkUserExists.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(changes.change(IDENTITY, add)).rejects.toThrow('socket hang up');
  });

  it('reports a refusal as provisioning.failed, not retryable', () => {
    changes.reportRefused(IDENTITY, 'entra-id: refused');

    expect(emit).toHaveBeenCalledWith(DomainEventType.PROVISIONING_FAILED, IDENTITY, {
      identityId: IDENTITY,
      connector: 'entra-id',
      error: 'entra-id: refused',
      retryable: false,
    });
  });

  // HX-E4: provisioning.failed from access request fulfilment and revoke carried no request id,
  // so nothing led from the alert to the request a policy-admin closes by hand
  it('names the access request whose change was refused', () => {
    changes.reportRefused(IDENTITY, 'entra-id: refused', 'req-9');

    expect(emit).toHaveBeenCalledWith(
      DomainEventType.PROVISIONING_FAILED,
      IDENTITY,
      expect.objectContaining({ accessRequestId: 'req-9', connector: 'entra-id' }),
    );
  });
});
