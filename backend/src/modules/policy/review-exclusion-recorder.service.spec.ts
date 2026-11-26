/**
 * A campaign close turns each revoked entitlement into an access review exclusion that names the
 * active policies granting it now (the identity's policies evaluated without exclusions): a
 * group as one entitlement, an account item as its whole system, an auto-revoked expired item
 * without a reviewer. Collaborators are mocked; ReviewExclusionService has its own MongoDB spec.
 */
import type { IdentityService } from '../identity/identity.service';
import type { PolicyEngineService, ProvisioningOperation } from './policy-engine.service';
import type { PolicyService } from './policy.service';
import type { ReviewExclusionService } from './review-exclusion.service';
import {
  ReviewExclusionRecorder,
  exclusionOf,
  type ReviewRevocationDecision,
} from './review-exclusion-recorder.service';

const TENANT = 'tenant-a';
const ADA = '64b7f0c2a1b2c3d4e5f60a01';

const POLICIES = [
  { _id: 'pol-sales', name: 'Sales baseline' },
  { _id: 'pol-all', name: 'Everyone' },
  { _id: 'pol-github', name: 'Developers' },
];

const grant = (over: Partial<ProvisioningOperation>): ProvisioningOperation => ({
  type: 'group',
  action: 'add',
  target: 'entra-id',
  targetId: 'SG-Sales',
  sourcePolicy: 'Sales baseline',
  ...over,
});

const decision = (over: Partial<ReviewRevocationDecision> = {}): ReviewRevocationDecision => ({
  campaignId: 'camp-1',
  campaignName: 'Q4 review',
  itemId: 'item-1',
  identityId: ADA,
  decision: 'revoked',
  decidedBy: 'manager@acme.test',
  decidedAt: new Date('2026-11-20T10:00:00.000Z'),
  justification: 'No longer in sales',
  entitlement: { system: 'entra-id', type: 'group', name: 'SG-Sales', nativeId: 'grp-sales-id' },
  ...over,
});

function setup(identity: object | null = { _id: ADA, profile: {} }) {
  const exclusions = { record: jest.fn().mockResolvedValue(true) };
  const engine = {
    evaluateWithPolicies: jest.fn().mockResolvedValue({
      operations: [
        grant({}),
        grant({ targetId: 'SG-Sales', sourcePolicy: 'Everyone' }),
        grant({ targetId: 'SG-All', sourcePolicy: 'Everyone' }),
        grant({ target: 'github', targetId: 'team-dev', sourcePolicy: 'Developers' }),
      ],
    }),
  };
  const policies = { findActive: jest.fn().mockResolvedValue(POLICIES) };
  const identityService = {
    findIdentityById: jest.fn().mockResolvedValue(identity),
    buildProfileWithContractsForPolicy: jest.fn().mockResolvedValue({ email: 'ada@acme.test' }),
  };
  const recorder = new ReviewExclusionRecorder(
    exclusions as unknown as ReviewExclusionService,
    engine as unknown as PolicyEngineService,
    policies as unknown as PolicyService,
    identityService as unknown as IdentityService,
  );
  return { recorder, exclusions, engine, identityService };
}

describe('ReviewExclusionRecorder', () => {
  it('records a revoked group with the policies that grant it now', async () => {
    const { recorder, exclusions, engine } = setup();

    await recorder.record([decision()], TENANT);

    expect(exclusions.record).toHaveBeenCalledWith(
      {
        identityId: ADA,
        targetSystem: 'entra-id',
        scope: 'entitlement',
        entitlementType: 'group',
        entitlementName: 'SG-Sales',
        entitlementId: 'grp-sales-id',
        campaignId: 'camp-1',
        campaignName: 'Q4 review',
        itemId: 'item-1',
        decision: 'revoked',
        reviewer: 'manager@acme.test',
        justification: 'No longer in sales',
        decidedAt: new Date('2026-11-20T10:00:00.000Z'),
        grantingPolicies: [
          { policyId: 'pol-sales', policyName: 'Sales baseline' },
          { policyId: 'pol-all', policyName: 'Everyone' },
        ],
      },
      TENANT,
    );
    // Evaluated with the identity's id, so no exclusion lookup by email is needed later
    expect(engine.evaluateWithPolicies).toHaveBeenCalledWith(
      expect.objectContaining({ _id: ADA, email: 'ada@acme.test' }),
      POLICIES,
      TENANT,
    );
  });

  it('records an account item as the whole system, counted against its policies', async () => {
    const { recorder, exclusions } = setup();
    const github = { system: 'github', type: 'account', name: 'Account' };

    await recorder.record([decision({ entitlement: github })], TENANT);

    const [recorded] = exclusions.record.mock.calls[0];
    expect(recorded).toMatchObject({ scope: 'account', targetSystem: 'github' });
    expect(recorded).not.toHaveProperty('entitlementId');
    expect(recorded.grantingPolicies).toEqual([
      { policyId: 'pol-github', policyName: 'Developers' },
    ]);
  });

  it('evaluates each identity once; what no policy grants has no granting policy', async () => {
    const { recorder, exclusions, engine } = setup();
    const manual = { system: 'entra-id', type: 'administrative-unit', name: 'AU Finland' };

    await recorder.record(
      [decision(), decision({ itemId: 'item-2', entitlement: manual })],
      TENANT,
    );

    expect(engine.evaluateWithPolicies).toHaveBeenCalledTimes(1);
    expect(exclusions.record).toHaveBeenCalledTimes(2);
    expect(exclusions.record.mock.calls[1][0].grantingPolicies).toEqual([]);
  });

  it('records an identity deleted since the review without granting policies', async () => {
    const { recorder, exclusions, engine } = setup(null);

    await recorder.record([decision()], TENANT);

    expect(engine.evaluateWithPolicies).not.toHaveBeenCalled();
    expect(exclusions.record.mock.calls[0][0].grantingPolicies).toEqual([]);
  });

  it('does nothing for an empty batch', async () => {
    const { recorder, exclusions, engine } = setup();
    await recorder.record([], TENANT);
    expect(engine.evaluateWithPolicies).not.toHaveBeenCalled();
    expect(exclusions.record).not.toHaveBeenCalled();
  });
});

describe('exclusionOf', () => {
  it('keeps an expired item the campaign auto-revoked without a reviewer', () => {
    const fields = exclusionOf(
      decision({ decision: 'expired', decidedBy: 'manager@acme.test', justification: undefined }),
    );
    expect(fields.decision).toBe('expired');
    expect(fields).not.toHaveProperty('reviewer');
    expect(fields).not.toHaveProperty('justification');
  });
});
