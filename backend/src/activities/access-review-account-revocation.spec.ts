/**
 * Removing an account item an access review revoked: through the per-target deprovision
 * offboarding and entitlement expiry use (EntitlementExpiryDeprovision, mocked here), with the
 * review outcomes (removed, already gone, manual action needed, failed as a throw), and the
 * provisioning entry closed the way expiry closes it.
 */
import { ApplicationFailure } from '@temporalio/common';
import { ReviewAccountRevocation } from './access-review-account-revocation';
import { DEPROVISION_REJECTED } from './deprovision-failure';
import type { IdentityService } from '../modules/identity/identity.service';
import type { IdentityProvisioningService } from '../modules/identity/identity-provisioning.service';
import type { EntitlementExpiryDeprovision } from './entitlement-expiry-deprovision';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { getEventSchema } from '@infrastructure/events/event-payload-schemas';

const TENANT = 'tenant-a';

function setup(identity: object | null) {
  const identityService = { findIdentityById: jest.fn().mockResolvedValue(identity) };
  const provisioningService = {
    accountIdFor: jest.fn(
      (doc: { sources?: Array<{ sourceName: string; externalId: string }> }, system: string) =>
        doc.sources?.find((s) => s.sourceName === system)?.externalId,
    ),
    updateProvisioningState: jest.fn().mockResolvedValue(null),
  };
  const deprovisioner = { deprovision: jest.fn() };
  const eventEmitter = { emit: jest.fn() };
  const revocation = new ReviewAccountRevocation(
    identityService as unknown as IdentityService,
    provisioningService as unknown as IdentityProvisioningService,
    deprovisioner as unknown as EntitlementExpiryDeprovision,
    eventEmitter as unknown as DomainEventEmitterService,
  );
  return { revocation, identityService, provisioningService, deprovisioner, eventEmitter };
}

const identity = (provisioning: object[], sources: object[] = []) => ({
  _id: { toString: () => 'id-1' },
  profile: { email: 'alan@acme.test' },
  provisioning,
  sources,
});

describe('ReviewAccountRevocation.revoke', () => {
  const github = { targetSystem: 'github', status: 'SYNCED' };

  it.each([
    [
      { deprovisioned: true, outcome: 'deprovisioned', detail: 'removed from organization' },
      { outcome: 'removed', detail: 'removed from organization' },
    ],
    [
      { deprovisioned: true, outcome: 'already-gone', detail: 'not a member' },
      { outcome: 'already-gone', detail: 'not a member' },
    ],
  ])(
    'deprovisions the account through the expiry helper and closes the entry (%o)',
    async (helperResult, expected) => {
      const doc = identity([github], [{ sourceName: 'github', externalId: 'github-user-7' }]);
      const { revocation, identityService, provisioningService, deprovisioner } = setup(doc);
      deprovisioner.deprovision.mockResolvedValue(helperResult);

      await expect(revocation.revoke('id-1', 'github', TENANT)).resolves.toEqual(expected);

      expect(identityService.findIdentityById).toHaveBeenCalledWith('id-1');
      expect(deprovisioner.deprovision).toHaveBeenCalledWith(doc, github, TENANT);
      expect(provisioningService.updateProvisioningState).toHaveBeenCalledWith(
        'id-1',
        'github',
        'DEPROVISIONED',
      );
    },
  );

  it('a target that keeps no account is already gone, and its entry is closed as expiry does', async () => {
    const entry = { targetSystem: 'file-outbound', status: 'SYNCED', writebackComplete: true };
    const { revocation, provisioningService, deprovisioner } = setup(identity([entry]));
    deprovisioner.deprovision.mockResolvedValue({
      deprovisioned: true,
      outcome: 'not-applicable',
      detail: 'keeps no account',
    });

    await expect(revocation.revoke('id-1', 'file-outbound', TENANT)).resolves.toEqual({
      outcome: 'already-gone',
      detail: 'keeps no account (notification or log target)',
    });
    expect(provisioningService.updateProvisioningState).toHaveBeenCalledWith(
      'id-1',
      'file-outbound',
      'DEPROVISIONED',
    );
  });

  it('a target without a deprovision needs manual action, and nothing is called or changed', async () => {
    const { revocation, identityService, provisioningService, deprovisioner } = setup(
      identity([{ targetSystem: 'custom-crm', status: 'SYNCED' }]),
    );
    await expect(revocation.revoke('id-1', 'custom-crm', TENANT)).resolves.toEqual({
      outcome: 'manual-action-needed',
      reason: expect.stringContaining('custom-crm'),
    });
    expect(identityService.findIdentityById).not.toHaveBeenCalled();
    expect(deprovisioner.deprovision).not.toHaveBeenCalled();
    expect(provisioningService.updateProvisioningState).not.toHaveBeenCalled();
  });

  it.each([
    ['the identity is deleted (offboarded)', null],
    [
      'the entry is deprovisioned since the review',
      identity([{ targetSystem: 'github', status: 'DEPROVISIONED' }]),
    ],
    ['no entry for the target any more', identity([])],
  ])('already gone without a target call when %s', async (_case, doc) => {
    const { revocation, provisioningService, deprovisioner } = setup(doc);
    await expect(revocation.revoke('id-1', 'github', TENANT)).resolves.toEqual({
      outcome: 'already-gone',
      detail: expect.any(String),
    });
    expect(deprovisioner.deprovision).not.toHaveBeenCalled();
    expect(provisioningService.updateProvisioningState).not.toHaveBeenCalled();
  });

  it('a failure retrying cannot fix fails at once, with the masked reason, entry left open', async () => {
    const { revocation, provisioningService, deprovisioner } = setup(identity([github]));
    deprovisioner.deprovision.mockResolvedValue({
      deprovisioned: false,
      reason: 'github: Request failed with status code 403 (HTTP 403)',
      retryable: false,
    });
    const err = (await revocation
      .revoke('id-1', 'github', TENANT)
      .catch((e: unknown) => e)) as ApplicationFailure;
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe(DEPROVISION_REJECTED);
    expect(err.message).toBe('github: Request failed with status code 403 (HTTP 403)');
    expect(provisioningService.updateProvisioningState).not.toHaveBeenCalled();
  });

  it('a failure retrying can fix is thrown for Temporal to retry', async () => {
    const { revocation, deprovisioner } = setup(identity([github]));
    deprovisioner.deprovision.mockResolvedValue({
      deprovisioned: false,
      reason: 'github: socket hang up',
      retryable: true,
    });
    const err = await revocation.revoke('id-1', 'github', TENANT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as ApplicationFailure).nonRetryable).toBeFalsy();
    expect((err as Error).message).toBe('github: socket hang up');
  });
});

describe('ReviewAccountRevocation.announce', () => {
  const item = {
    itemId: 'i1',
    identityId: 'id-1',
    decision: 'revoked' as const,
    decidedBy: 'reviewer@acme.test',
    entitlements: [{ system: 'github', type: 'account', name: 'Account', policyManaged: true }],
  };

  it('puts the outcome on the identity timeline, by the reviewer, with ids only', () => {
    const { revocation, eventEmitter } = setup(null);
    revocation.announce('c1', item, 0, { outcome: 'removed', detail: 'removed from organization' });

    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    const [type, aggregateId, payload, options] = eventEmitter.emit.mock.calls[0];
    expect(type).toBe(DomainEventType.ACCESS_REVIEW_ACCOUNT_REVOKED);
    expect(aggregateId).toBe('id-1');
    expect(payload).toEqual({
      identityId: 'id-1',
      campaignId: 'c1',
      itemId: 'i1',
      targetSystem: 'github',
      outcome: 'removed',
      detail: 'removed from organization',
    });
    // The emitter validates against the schema; nothing personal is in it
    expect(getEventSchema(type).parse(payload)).toEqual(payload);
    expect(options).toEqual({ actor: 'reviewer@acme.test' });
  });

  it('an expired item the campaign auto-revokes is announced as the system', () => {
    const { revocation, eventEmitter } = setup(null);
    revocation.announce('c1', { ...item, decision: 'expired', decidedBy: undefined }, 0, {
      outcome: 'failed',
      reason: 'github: forbidden (HTTP 403)',
    });
    expect(eventEmitter.emit.mock.calls[0][3]).toBeUndefined();
  });
});
