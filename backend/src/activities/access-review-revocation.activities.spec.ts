/**
 * Access review revocation activities: which revoked entitlements are removed (revoked items
 * always, expired ones only with autoRevokeOnExpiry, nothing for a cancelled campaign), what is
 * recorded without a connector call (manual action), how results are stored, and how a failed
 * removal reaches Temporal. Every revoked entitlement taken up becomes an access review exclusion
 * (ReviewExclusionRecorder) before any result is written. Models and the target service are
 * mocked; the tenant context is the real one, and every mock records the tenant it ran in.
 */
import { HttpStatus } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import type { Model } from 'mongoose';
import {
  AccessReviewRevocationActivities,
  accessReviewRevocationQueueActivities,
} from './access-review-revocation.activities';
import { DEPROVISION_REJECTED } from './deprovision-failure';
import { CampaignStatus } from '../modules/access-review/schemas/review-campaign.schema';
import type { ReviewItemDocument } from '../modules/access-review/schemas/review-item.schema';
import type { ReviewCampaignDocument } from '../modules/access-review/schemas/review-campaign.schema';
import type { ReviewTargetAccessService } from '../modules/access-review/review-target-access.service';
import type { ReviewAccountRevocation } from './access-review-account-revocation';
import type { ReviewExclusionRecorder } from '../modules/policy/review-exclusion-recorder.service';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { entraManifest } from '../modules/connectors/entra-connector/connector.manifest';
import { adManifest } from '../modules/connectors/ad-connector/connector.manifest';
import { oktaManifest } from '../modules/connectors/okta-connector/connector.manifest';
import { scimManifest } from '../modules/connectors/scim-connector/connector.manifest';

const TENANT = 'tenant-a';
const WF = 'wf-1';

interface FakeQuery {
  sort: jest.Mock<FakeQuery, unknown[]>;
  limit: jest.Mock<FakeQuery, unknown[]>;
  lean: jest.Mock<FakeQuery, unknown[]>;
  exec: jest.Mock;
}

const query = (value: unknown): FakeQuery => {
  const q: FakeQuery = {
    sort: jest.fn(() => q),
    limit: jest.fn(() => q),
    lean: jest.fn(() => q),
    exec: jest.fn().mockResolvedValue(value),
  };
  return q;
};

function setup(opts: { campaign?: object | null; items?: object[]; batchSize?: number } = {}) {
  const campaign =
    opts.campaign === undefined
      ? {
          campaignId: 'c1',
          name: 'Q4 review',
          status: CampaignStatus.ACTIVE,
          autoRevokeOnExpiry: false,
        }
      : opts.campaign;
  /** The tenant each model, connector and event call ran in (null: outside any context). */
  const tenants: Array<string | null> = [];
  const inTenant =
    <R>(fn: () => R) =>
    (): R => {
      tenants.push(contextTenant());
      return fn();
    };
  const recording = <R>(fn: () => R) => jest.fn().mockImplementation(inTenant(fn));
  const campaignModel = { findOne: recording(() => query(campaign)) };
  const itemQuery = query(opts.items ?? []);
  const reviewItemModel = {
    find: recording(() => itemQuery),
    findOne: recording(() => query(opts.items?.[0] ?? null)),
    bulkWrite: recording(async () => ({})),
    updateOne: recording(() => query({ modifiedCount: 1 })),
  };
  const removed = async () => ({ outcome: 'removed' });
  const targetAccess = { revoke: recording(removed) };
  const accountRevocation = { revoke: recording(removed), announce: recording(() => undefined) };
  const eventEmitter = { emit: recording(() => undefined) };
  const exclusions = { record: recording(async () => undefined) };
  const activities = new AccessReviewRevocationActivities(
    reviewItemModel as unknown as Model<ReviewItemDocument>,
    campaignModel as unknown as Model<ReviewCampaignDocument>,
    targetAccess as unknown as ReviewTargetAccessService,
    {
      defaultReviewer: 'r@x',
      revocationBatchSize: opts.batchSize ?? 50,
      activationClaimMs: 3_600_000,
    },
    accountRevocation as unknown as ReviewAccountRevocation,
    eventEmitter as unknown as DomainEventEmitterService,
    exclusions as unknown as ReviewExclusionRecorder,
  );
  return {
    activities,
    campaignModel,
    reviewItemModel,
    itemQuery,
    targetAccess,
    accountRevocation,
    eventEmitter,
    exclusions,
    tenants,
  };
}

function contextTenant(): string | null {
  try {
    return getCurrentTenantId();
  } catch {
    return null;
  }
}

const item = (itemId: string, entitlements: object[]) => ({
  itemId,
  identityId: 'id-1',
  identityEmail: 'ada@acme.test',
  decision: 'revoked',
  decidedBy: 'reviewer@acme.test',
  entitlements,
});

const account = (system: string) => ({ system, type: 'account', name: 'Account' });

describe('AccessReviewRevocationActivities.listRevocationTasks', () => {
  it('returns connector tasks and records manual action for what no connector can remove', async () => {
    const { activities, reviewItemModel } = setup({
      items: [
        item('i1', [
          { system: 'ad', type: 'group', nativeId: 'CN=G,DC=x', accountId: 'CN=U,DC=x' },
        ]),
        item('i2', [{ system: 'euroid-admin', type: 'group', name: 'super-admin' }]),
        item('i3', [
          { system: 'okta', type: 'group', nativeId: '00g1', revocation: { outcome: 'removed' } },
          { system: 'scim', type: 'group', nativeId: 'grp-1' },
        ]),
      ],
    });

    const batch = await activities.listRevocationTasks('c1', TENANT, WF);

    expect(batch).toEqual({
      tasks: [
        { itemId: 'i1', entitlementIndex: 0, connector: 'ad' },
        { itemId: 'i3', entitlementIndex: 1, connector: 'scim' },
      ],
      more: false,
    });
    const writes = reviewItemModel.bulkWrite.mock.calls[0][0];
    expect(writes).toHaveLength(1);
    expect(writes[0].updateOne.filter).toEqual({
      itemId: 'i2',
      campaignId: 'c1',
      tenantId: TENANT,
      'entitlements.0.revocation': { $exists: false },
    });
    expect(writes[0].updateOne.update.$set['entitlements.0.revocation']).toEqual({
      outcome: 'manual-action-needed',
      reason: expect.stringContaining('admin role'),
      at: expect.any(Date),
    });
  });

  it('takes revoked items only, in this tenant, with an entitlement still without a result', async () => {
    const { activities, reviewItemModel, campaignModel } = setup();
    await activities.listRevocationTasks('c1', TENANT, WF);
    expect(campaignModel.findOne).toHaveBeenCalledWith({ campaignId: 'c1', tenantId: TENANT });
    expect(reviewItemModel.find).toHaveBeenCalledWith({
      campaignId: 'c1',
      tenantId: TENANT,
      decision: { $in: ['revoked'] },
      entitlements: { $elemMatch: { revocation: { $exists: false } } },
    });
  });

  it('also takes expired items when the campaign auto-revokes on expiry', async () => {
    const { activities, reviewItemModel } = setup({
      campaign: { campaignId: 'c1', status: CampaignStatus.ACTIVE, autoRevokeOnExpiry: true },
    });
    await activities.listRevocationTasks('c1', TENANT, WF);
    expect(reviewItemModel.find.mock.calls[0][0].decision).toEqual({ $in: ['revoked', 'expired'] });
  });

  it('revokes nothing for a cancelled campaign', async () => {
    const { activities, reviewItemModel } = setup({
      campaign: { campaignId: 'c1', status: CampaignStatus.CANCELLED, autoRevokeOnExpiry: true },
    });
    await expect(activities.listRevocationTasks('c1', TENANT, WF)).resolves.toEqual({
      tasks: [],
      more: false,
    });
    expect(reviewItemModel.find).not.toHaveBeenCalled();
  });

  it('says more may wait when the batch is full', async () => {
    const { activities, itemQuery } = setup({
      batchSize: 1,
      items: [item('i1', [{ system: 'okta', type: 'group', nativeId: '00g1' }])],
    });
    await expect(activities.listRevocationTasks('c1', TENANT, WF)).resolves.toMatchObject({
      more: true,
    });
    expect(itemQuery.limit).toHaveBeenCalledWith(1);
  });

  it('refuses to run without a tenant', async () => {
    const { activities } = setup();
    await expect(activities.listRevocationTasks('c1', '', WF)).rejects.toThrow('[SECURITY]');
  });

  it('returns account items as account tasks in runs that revoke accounts', async () => {
    const { activities, reviewItemModel } = setup({
      items: [item('i1', [account('github')]), item('i2', [account('file-outbound')])],
    });
    await expect(activities.listRevocationTasks('c1', TENANT, WF, true)).resolves.toEqual({
      tasks: [
        { itemId: 'i1', entitlementIndex: 0, connector: 'account' },
        { itemId: 'i2', entitlementIndex: 0, connector: 'account' },
      ],
      more: false,
    });
    expect(reviewItemModel.bulkWrite).not.toHaveBeenCalled();
  });

  it('records account items as manual action in runs from before account revocation', async () => {
    const { activities, reviewItemModel } = setup({ items: [item('i1', [account('github')])] });
    await expect(activities.listRevocationTasks('c1', TENANT, WF)).resolves.toEqual({
      tasks: [],
      more: false,
    });
    const [write] = reviewItemModel.bulkWrite.mock.calls[0][0];
    expect(write.updateOne.update.$set['entitlements.0.revocation'].outcome).toBe(
      'manual-action-needed',
    );
  });

  // FOLLOWUPS 2026-11-23 (mover.handler.ts:42): a review revoke did not stick. Each revoked
  // entitlement the close takes up is kept as an access review exclusion, whatever its route.
  it('records an exclusion for each revoked entitlement it takes up', async () => {
    const decided = new Date('2026-11-20T10:00:00.000Z');
    const { activities, exclusions } = setup({
      items: [
        {
          ...item('i1', [
            { system: 'entra-id', type: 'group', name: 'SG-Sales', nativeId: 'grp-1' },
            { system: 'okta', type: 'group', name: 'Done', revocation: { outcome: 'removed' } },
          ]),
          decidedAt: decided,
          justification: 'Left sales',
        },
        item('i2', [account('github')]),
        item('i3', [{ system: 'euroid-admin', type: 'group', name: 'super-admin' }]),
      ],
    });

    await activities.listRevocationTasks('c1', TENANT, WF, true);

    expect(exclusions.record).toHaveBeenCalledTimes(1);
    const [decisions, tenantId] = exclusions.record.mock.calls[0];
    expect(tenantId).toBe(TENANT);
    expect(decisions).toEqual([
      {
        campaignId: 'c1',
        campaignName: 'Q4 review',
        itemId: 'i1',
        identityId: 'id-1',
        decision: 'revoked',
        decidedBy: 'reviewer@acme.test',
        decidedAt: decided,
        justification: 'Left sales',
        entitlement: { system: 'entra-id', type: 'group', name: 'SG-Sales', nativeId: 'grp-1' },
      },
      expect.objectContaining({
        itemId: 'i2',
        entitlement: { system: 'github', type: 'account', name: 'Account' },
      }),
      expect.objectContaining({
        itemId: 'i3',
        entitlement: { system: 'euroid-admin', type: 'group', name: 'super-admin' },
      }),
    ]);
  });

  it('records an expired item the campaign auto-revokes without its reviewer', async () => {
    const { activities, exclusions } = setup({
      campaign: {
        campaignId: 'c1',
        name: 'Q4',
        status: CampaignStatus.ACTIVE,
        autoRevokeOnExpiry: true,
      },
      items: [
        {
          ...item('i1', [{ system: 'okta', type: 'group', name: 'G', nativeId: '00g1' }]),
          decision: 'expired',
        },
      ],
    });

    await activities.listRevocationTasks('c1', TENANT, WF);

    const [[recorded]] = exclusions.record.mock.calls[0];
    expect(recorded.decision).toBe('expired');
    expect(recorded).not.toHaveProperty('decidedBy');
  });

  it('writes no manual result when exclusions fail to record (the retry redoes it)', async () => {
    const { activities, exclusions, reviewItemModel } = setup({
      items: [item('i1', [{ system: 'euroid-admin', type: 'group', name: 'super-admin' }])],
    });
    exclusions.record.mockRejectedValue(new Error('MongoDB unavailable'));

    await expect(activities.listRevocationTasks('c1', TENANT, WF)).rejects.toThrow(
      'MongoDB unavailable',
    );
    expect(reviewItemModel.bulkWrite).not.toHaveBeenCalled();
  });

  it('records nothing for a cancelled campaign', async () => {
    const { activities, exclusions } = setup({
      campaign: { campaignId: 'c1', status: CampaignStatus.CANCELLED, autoRevokeOnExpiry: true },
      items: [item('i1', [account('github')])],
    });
    await activities.listRevocationTasks('c1', TENANT, WF, true);
    expect(exclusions.record).not.toHaveBeenCalled();
  });
});

describe('AccessReviewRevocationActivities.recordRevocationResults', () => {
  it('stores each outcome on its entitlement once, with emails masked', async () => {
    const { activities, reviewItemModel } = setup();
    await activities.recordRevocationResults(
      'c1',
      [
        { itemId: 'i1', entitlementIndex: 0, outcome: 'removed', detail: 'removed from group' },
        {
          itemId: 'i2',
          entitlementIndex: 2,
          outcome: 'failed',
          reason: 'okta: no user ada@acme.test',
        },
        { itemId: 'i3', entitlementIndex: -1, outcome: 'removed' },
      ],
      TENANT,
      WF,
    );
    const writes = reviewItemModel.updateOne.mock.calls as unknown as Array<
      [Record<string, unknown>, { $set: Record<string, { outcome: string; reason?: string }> }]
    >;
    expect(writes).toHaveLength(2); // the invalid index is dropped
    expect(writes[1][0]).toEqual({
      itemId: 'i2',
      campaignId: 'c1',
      tenantId: TENANT,
      'entitlements.2.revocation': { $exists: false },
    });
    const stored = writes[1][1].$set['entitlements.2.revocation'];
    expect(stored.outcome).toBe('failed');
    expect(stored.reason).not.toContain('ada@acme.test');
    expect(stored.reason).toContain('@acme.test');
  });

  it("stores an account item's outcome once and puts it on the identity timeline", async () => {
    const { activities, reviewItemModel, accountRevocation } = setup({
      items: [
        item('i1', [account('github')]),
        item('i2', [{ system: 'okta', type: 'group', nativeId: '00g1' }]),
      ],
    });
    await activities.recordRevocationResults(
      'c1',
      [
        {
          itemId: 'i1',
          entitlementIndex: 0,
          outcome: 'failed',
          reason: 'github: no member ada@acme.test',
        },
        { itemId: 'i2', entitlementIndex: 0, outcome: 'removed', detail: 'removed from group' },
      ],
      TENANT,
      WF,
    );

    expect(reviewItemModel.find).toHaveBeenCalledWith({
      itemId: { $in: ['i1', 'i2'] },
      campaignId: 'c1',
      tenantId: TENANT,
    });
    // Each result on its own (once: only an absent result)
    const writtenItems = (
      reviewItemModel.updateOne.mock.calls as unknown as Array<[{ itemId: string }]>
    ).map(([filter]) => filter.itemId);
    expect(writtenItems).toEqual(['i1', 'i2']);
    expect(reviewItemModel.updateOne).toHaveBeenCalledWith(
      {
        itemId: 'i1',
        campaignId: 'c1',
        tenantId: TENANT,
        'entitlements.0.revocation': { $exists: false },
      },
      {
        $set: {
          'entitlements.0.revocation': {
            outcome: 'failed',
            reason: expect.not.stringContaining('ada@acme.test'),
            at: expect.any(Date),
          },
        },
      },
    );
    // The timeline gets what was stored (masked), once
    expect(accountRevocation.announce).toHaveBeenCalledTimes(1);
    expect(accountRevocation.announce).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ itemId: 'i1', identityId: 'id-1' }),
      0,
      { outcome: 'failed', reason: expect.stringContaining('github: no member') },
    );
    expect(accountRevocation.announce.mock.calls[0][3].reason).not.toContain('ada@acme.test');
  });

  it('an account outcome already stored (a retried record) is not put on the timeline again', async () => {
    const { activities, reviewItemModel, accountRevocation } = setup({
      items: [{ ...item('i1', [account('github')]), decision: 'expired', decidedBy: undefined }],
    });
    reviewItemModel.updateOne.mockReturnValueOnce(query({ modifiedCount: 0 }));
    await activities.recordRevocationResults(
      'c1',
      [{ itemId: 'i1', entitlementIndex: 0, outcome: 'removed', detail: 'deactivated' }],
      TENANT,
      WF,
    );
    expect(accountRevocation.announce).not.toHaveBeenCalled();
  });

  it("puts a group membership's stored outcome on the identity timeline, ids only", async () => {
    const { activities, accountRevocation, eventEmitter } = setup({
      items: [
        item('i1', [
          { system: 'entra-id', type: 'group', name: 'Finance-Admins', nativeId: 'g-1' },
          { system: 'okta', type: 'group', name: 'Sales', nativeId: '00g2' },
        ]),
      ],
    });
    await activities.recordRevocationResults(
      'c1',
      [
        { itemId: 'i1', entitlementIndex: 0, outcome: 'removed', detail: 'removed from group' },
        {
          itemId: 'i1',
          entitlementIndex: 1,
          outcome: 'failed',
          reason: 'okta: no user ada@acme.test',
        },
      ],
      TENANT,
      WF,
    );

    expect(accountRevocation.announce).not.toHaveBeenCalled();
    expect(eventEmitter.emit.mock.calls).toEqual([
      [
        DomainEventType.ACCESS_REVIEW_MEMBERSHIP_REVOKED,
        'id-1',
        {
          identityId: 'id-1',
          campaignId: 'c1',
          itemId: 'i1',
          targetSystem: 'entra-id',
          groupId: 'g-1',
          outcome: 'removed',
          detail: 'removed from group',
        },
        { actor: 'reviewer@acme.test' },
      ],
      [
        DomainEventType.ACCESS_REVIEW_MEMBERSHIP_REVOKED,
        'id-1',
        expect.objectContaining({ groupId: '00g2', outcome: 'failed' }),
        { actor: 'reviewer@acme.test' },
      ],
    ]);
    // No group name, no address
    const payloads = JSON.stringify(eventEmitter.emit.mock.calls);
    expect(payloads).not.toContain('Finance-Admins');
    expect(payloads).not.toContain('ada@acme.test');
  });

  it('a membership outcome already stored, or of an auto-revoked item, is announced right', async () => {
    const { activities, reviewItemModel, eventEmitter } = setup({
      items: [
        {
          ...item('i1', [{ system: 'ad', type: 'group', nativeId: 'CN=Sales,DC=corp' }]),
          decision: 'expired',
          decidedBy: undefined,
        },
      ],
    });
    reviewItemModel.updateOne.mockReturnValueOnce(query({ modifiedCount: 0 }));
    const results = [{ itemId: 'i1', entitlementIndex: 0, outcome: 'removed' as const }];

    // A retried record: already stored, nothing new on the timeline
    await activities.recordRevocationResults('c1', results, TENANT, WF);
    expect(eventEmitter.emit).not.toHaveBeenCalled();

    // Stored now: the system's (no actor) for an expired item the campaign revokes
    await activities.recordRevocationResults('c1', results, TENANT, WF);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      DomainEventType.ACCESS_REVIEW_MEMBERSHIP_REVOKED,
      'id-1',
      expect.objectContaining({ targetSystem: 'ad', groupId: 'CN=Sales,DC=corp' }),
      undefined,
    );
  });
});

describe('AccessReviewRevocationActivities.revokeReviewAccount', () => {
  const task = { itemId: 'i1', entitlementIndex: 0, connector: 'account' as const };

  it("removes the stored item's account through the account revocation", async () => {
    const { activities, accountRevocation, reviewItemModel } = setup({
      items: [item('i1', [account('servicenow')])],
    });
    accountRevocation.revoke.mockResolvedValue({ outcome: 'removed', detail: 'deactivated' });
    await expect(activities.revokeReviewAccount(task, TENANT, WF)).resolves.toEqual({
      outcome: 'removed',
      detail: 'deactivated',
    });
    expect(reviewItemModel.findOne).toHaveBeenCalledWith({ itemId: 'i1', tenantId: TENANT });
    expect(accountRevocation.revoke).toHaveBeenCalledWith('id-1', 'servicenow', TENANT);
  });

  it('fails without retry when the item or entitlement is gone', async () => {
    const { activities, accountRevocation } = setup({ items: [] });
    const err = await activities.revokeReviewAccount(task, TENANT, WF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
    expect(accountRevocation.revoke).not.toHaveBeenCalled();
  });

  it('refuses to remove an account for an entitlement that is not an account item', async () => {
    const { activities, accountRevocation } = setup({
      items: [item('i1', [{ system: 'github', type: 'team', name: 'devs' }])],
    });
    const err = await activities.revokeReviewAccount(task, TENANT, WF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
    expect(accountRevocation.revoke).not.toHaveBeenCalled();
  });
});

describe('AccessReviewRevocationActivities.revokeReviewAccess', () => {
  const task = { itemId: 'i1', entitlementIndex: 0, connector: 'okta' as const };
  const ent = { system: 'okta', type: 'group', nativeId: '00g1', accountId: '00u1' };

  it('revokes the entitlement of the stored item for its holder', async () => {
    const { activities, targetAccess, reviewItemModel } = setup({ items: [item('i1', [ent])] });
    targetAccess.revoke.mockResolvedValue({ outcome: 'removed', detail: 'removed from group' });
    await expect(activities.revokeReviewAccess(task, TENANT, WF)).resolves.toEqual({
      outcome: 'removed',
      detail: 'removed from group',
    });
    expect(reviewItemModel.findOne).toHaveBeenCalledWith({ itemId: 'i1', tenantId: TENANT });
    expect(targetAccess.revoke).toHaveBeenCalledWith(
      'okta',
      ent,
      { email: 'ada@acme.test' },
      TENANT,
    );
  });

  it('fails without retry when the item or entitlement is gone', async () => {
    const { activities } = setup({ items: [] });
    const err = await activities.revokeReviewAccess(task, TENANT, WF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
    expect((err as ApplicationFailure).type).toBe(DEPROVISION_REJECTED);
  });

  it('a client error (account not found) fails without retry, email masked', async () => {
    const { activities, targetAccess } = setup({ items: [item('i1', [ent])] });
    targetAccess.revoke.mockRejectedValue(
      new ConnectorException('no Okta user ada@acme.test', HttpStatus.UNPROCESSABLE_ENTITY),
    );
    const err = (await activities
      .revokeReviewAccess(task, TENANT, WF)
      .catch((e: unknown) => e)) as ApplicationFailure;
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(err.nonRetryable).toBe(true);
    expect(err.message).toContain('okta: ');
    expect(err.message).not.toContain('ada@acme.test');
  });

  it('a network error is rethrown for Temporal to retry', async () => {
    const { activities, targetAccess } = setup({ items: [item('i1', [ent])] });
    targetAccess.revoke.mockRejectedValue(new Error('socket hang up'));
    const err = await activities.revokeReviewAccess(task, TENANT, WF).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ApplicationFailure);
    expect((err as Error).message).toBe('okta: socket hang up');
  });
});

/**
 * Each activity runs in the workflow's tenant: the tenant plugin scopes every model call by the
 * context's tenant, and the connector calls and events read it from there too.
 */
describe('the tenant an access review revocation activity runs in', () => {
  const group = { system: 'okta', type: 'group', nativeId: '00g1', accountId: '00u1' };
  const admin = { system: 'euroid-admin', type: 'group', name: 'super-admin' };
  type Activities = ReturnType<typeof setup>['activities'];

  it.each<[string, object[], (a: Activities) => Promise<unknown>, number]>([
    [
      'listRevocationTasks',
      [item('i1', [group]), item('i2', [admin])],
      (a) => a.listRevocationTasks('c1', TENANT, WF),
      4, // campaign, items, exclusions, the manual result
    ],
    [
      'recordRevocationResults',
      [item('i1', [group])],
      (a) =>
        a.recordRevocationResults(
          'c1',
          [{ itemId: 'i1', entitlementIndex: 0, outcome: 'removed' }],
          TENANT,
          WF,
        ),
      3, // items, the result, the timeline event
    ],
    [
      'revokeReviewAccount',
      [item('i1', [account('github')])],
      (a) =>
        a.revokeReviewAccount(
          { itemId: 'i1', entitlementIndex: 0, connector: 'account' },
          TENANT,
          WF,
        ),
      2, // the item, the account removal
    ],
    [
      'revokeReviewAccess',
      [item('i1', [group])],
      (a) =>
        a.revokeReviewAccess({ itemId: 'i1', entitlementIndex: 0, connector: 'okta' }, TENANT, WF),
      2, // the item, the connector removal
    ],
  ])('%s reads, writes, removes and announces in its tenant', async (_name, items, run, calls) => {
    const { activities, tenants } = setup({ items });

    await run(activities);

    expect(tenants.length).toBeGreaterThanOrEqual(calls);
    expect(tenants.filter((tenant) => tenant !== TENANT)).toEqual([]);
  });
});

describe('accessReviewRevocationQueueActivities', () => {
  it("registers revokeReviewAccess on exactly the connector queues the workers poll (each plugin's taskQueue)", () => {
    const { activities } = setup();
    const byQueue = accessReviewRevocationQueueActivities(activities);
    expect(Object.keys(byQueue).sort()).toEqual(
      [entraManifest, adManifest, oktaManifest, scimManifest].map((m) => m.taskQueue).sort(),
    );
    for (const queueActivities of Object.values(byQueue)) {
      expect(Object.keys(queueActivities)).toEqual(['revokeReviewAccess']);
    }
  });
});
