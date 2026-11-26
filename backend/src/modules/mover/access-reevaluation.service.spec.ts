/**
 * Access preview and re-evaluation against the identity's access baseline: the preview shows the
 * entitlements the policies give differently for the baseline and the current profile, writes
 * nothing and starts nothing; the re-evaluation starts the existing mover run with the baseline
 * values as previousAttributes, audited with the operator, in the request tenant.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { IPolicyDecisionPort } from '@shared/interfaces/policy-decision.port';
import type { IdentityService } from '../identity/identity.service';
import type { AuditService } from '../audit/audit.service';
import type { MoverService } from './mover.service';
import { AccessReevaluationService } from './access-reevaluation.service';

const TENANT = 'tenant-a';

type Profile = Record<string, unknown> & { departmentName?: string; costCenter?: string };
const op = (target: string, targetId: string) => ({
  type: 'group' as const,
  action: 'add' as const,
  target,
  targetId,
  sourcePolicy: 'p-dept',
});

/** Sales and Engineering get a group in Entra ID; Engineering also one in Okta and GitHub. */
function policyOps(profile: Profile) {
  if (profile.departmentName === 'Sales') return [op('entra-id', 'g-sales')];
  if (profile.departmentName === 'Engineering') {
    return [op('entra-id', 'g-eng'), op('okta', 'okta-eng'), op('github', 'gh-eng')];
  }
  return [];
}

function setup(
  identity: Record<string, unknown> | null,
  requests: Array<{ entitlements: Array<Record<string, unknown>> }> = [],
) {
  const identityService = {
    findIdentityById: jest.fn(async () => identity),
    buildProfileWithContractsForPolicy: jest.fn(async (doc: { profile: Profile }) => ({
      ...doc.profile,
      contracts: undefined,
    })),
  };
  const evaluatedTenants: Array<string | undefined> = [];
  const policy: IPolicyDecisionPort = {
    evaluate: jest.fn(),
    evaluateOperationsWithoutSod: jest.fn(async (user, tenantId) => {
      evaluatedTenants.push(tenantId);
      return policyOps(user as unknown as Profile);
    }),
  } as unknown as IPolicyDecisionPort;
  const moverService = { triggerMover: jest.fn(async () => `t-${TENANT}-mover-id-1`) };
  const auditService = { log: jest.fn(async () => ({})), logFireAndForget: jest.fn() };
  const accessRequests = {
    find: jest.fn(() => ({ lean: () => ({ exec: async () => requests }) })),
  };
  const service = new AccessReevaluationService(
    identityService as unknown as IdentityService,
    moverService as unknown as MoverService,
    auditService as unknown as AuditService,
    policy,
    accessRequests as unknown as ConstructorParameters<typeof AccessReevaluationService>[4],
  );
  return { service, identityService, policy, moverService, auditService, evaluatedTenants };
}

const inTenant = <T>(fn: () => Promise<T>) => withTenantContext(TENANT, fn);

const identity = (over: Record<string, unknown> = {}) => ({
  _id: 'id-1',
  profile: { email: 'ada@acme.test', firstName: 'Ada', departmentName: 'Engineering' },
  provisioning: [
    { targetSystem: 'entra-id', status: 'SYNCED' },
    { targetSystem: 'okta', status: 'SYNCED' },
  ],
  accessBaseline: {
    attributes: { departmentName: 'Sales' },
    recordedAt: new Date('2026-11-01T08:00:00Z'),
    recordedBy: 'provisioning',
  },
  ...over,
});

describe('AccessReevaluationService', () => {
  describe('preview', () => {
    // The mover keeps what an active access request also grants (hunt 03 F9), so the preview
    // shows no such removal either
    it('leaves out a removal of what an active access request also grants', async () => {
      const { service } = setup(identity(), [
        { entitlements: [{ system: 'entra-id', entitlementType: 'Group', nativeId: 'g-sales' }] },
      ]);

      const preview = await inTenant(() => service.preview('id-1'));

      expect(preview.toRemove).toEqual([]);
      expect(preview.toAdd.map((e) => e.targetId)).toEqual(['g-eng', 'okta-eng', 'gh-eng']);
    });

    it('shows what changed since the baseline and the entitlements to add and remove', async () => {
      const { service, moverService, auditService, evaluatedTenants } = setup(identity());

      const preview = await inTenant(() => service.preview('id-1'));

      expect(preview).toEqual({
        identityId: 'id-1',
        baselineRecordedAt: '2026-11-01T08:00:00.000Z',
        changes: [{ field: 'departmentName', before: 'Sales', after: 'Engineering' }],
        toAdd: [
          {
            type: 'group',
            target: 'entra-id',
            targetId: 'g-eng',
            sourcePolicy: 'p-dept',
            appliedByMover: true,
          },
          {
            type: 'group',
            target: 'okta',
            targetId: 'okta-eng',
            sourcePolicy: 'p-dept',
            appliedByMover: true,
          },
          {
            type: 'group',
            target: 'github',
            targetId: 'gh-eng',
            sourcePolicy: 'p-dept',
            appliedByMover: false,
          },
        ],
        toRemove: [
          {
            type: 'group',
            target: 'entra-id',
            targetId: 'g-sales',
            sourcePolicy: 'p-dept',
            appliedByMover: true,
          },
        ],
        provisionedTargets: ['entra-id', 'okta'],
        canReevaluate: true,
      });
      expect(evaluatedTenants).toEqual([TENANT, TENANT]);
      // Read-only: no workflow, no audit entry.
      expect(moverService.triggerMover).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
      expect(auditService.logFireAndForget).not.toHaveBeenCalled();
    });

    it('leaves names and contact data out of the changes', async () => {
      const { service } = setup(
        identity({
          profile: { email: 'new@acme.test', firstName: 'Adaline', departmentName: 'Sales' },
        }),
      );

      const preview = await inTenant(() => service.preview('id-1'));

      expect(preview.changes).toEqual([]);
      expect(preview.toAdd).toEqual([]);
      expect(preview.toRemove).toEqual([]);
      expect(JSON.stringify(preview)).not.toContain('acme.test');
    });

    // R1: a lifted access review exclusion gives its access back at the next run. The baseline
    // side still leaves out what exclusions lifted after the baseline took away.
    it('shows the access of a lifted exclusion as an add, no attribute changed', async () => {
      const { service, policy } = setup(
        identity({
          profile: { email: 'ada@acme.test', firstName: 'Ada', departmentName: 'Sales' },
        }),
      );
      jest
        .mocked(policy.evaluateOperationsWithoutSod)
        .mockImplementation(async (_user, _tenantId, options) =>
          options?.reviewExclusionsLiftedSince ? [] : [op('entra-id', 'g-sales')],
        );

      const preview = await inTenant(() => service.preview('id-1'));

      expect(preview.changes).toEqual([]);
      expect(preview.toAdd.map((e) => e.targetId)).toEqual(['g-sales']);
      expect(preview.toRemove).toEqual([]);
      expect(policy.evaluateOperationsWithoutSod).toHaveBeenCalledWith(
        expect.objectContaining({ departmentName: 'Sales' }),
        TENANT,
        { reviewExclusionsLiftedSince: new Date('2026-11-01T08:00:00Z') },
      );
    });

    it('says why it cannot tell what to remove without a baseline', async () => {
      const { service, policy } = setup(identity({ accessBaseline: undefined }));

      const preview = await inTenant(() => service.preview('id-1'));

      expect(preview).toMatchObject({
        baselineRecordedAt: null,
        changes: [],
        toAdd: [],
        toRemove: [],
        canReevaluate: false,
        blockedReason: expect.stringContaining('cannot tell what to remove'),
      });
      expect(policy.evaluateOperationsWithoutSod).not.toHaveBeenCalled();
    });

    it('cannot re-evaluate an identity with no provisioned target', async () => {
      const { service } = setup(
        identity({ provisioning: [{ targetSystem: 'entra-id', status: 'ERROR' }] }),
      );

      const preview = await inTenant(() => service.preview('id-1'));

      expect(preview.canReevaluate).toBe(false);
      expect(preview.blockedReason).toMatch(/onboarding gives it access/);
    });

    it('counts a target whose last mover run failed there as provisioned (hasProvisionedAccount)', async () => {
      // SYNCED once (provisionedAt), then the mover's own run there ended in ERROR
      const { service } = setup(
        identity({
          provisioning: [
            { targetSystem: 'entra-id', status: 'ERROR', provisionedAt: new Date('2026-11-02') },
            { targetSystem: 'okta', status: 'ERROR' },
          ],
        }),
      );

      const preview = await inTenant(() => service.preview('id-1'));

      expect(preview.provisionedTargets).toEqual(['entra-id']);
      expect(preview.canReevaluate).toBe(true);
    });

    it('404 for an identity not found in the tenant', async () => {
      const { service } = setup(null);
      await expect(inTenant(() => service.preview('id-x'))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('reevaluate', () => {
    it('starts the mover with the baseline values and audits the operator', async () => {
      const { service, moverService, auditService } = setup(identity());

      const result = await inTenant(() => service.reevaluate('id-1', 'ops@acme.test'));

      expect(result).toEqual({
        workflowId: `t-${TENANT}-mover-id-1`,
        changedFields: ['departmentName'],
      });
      expect(moverService.triggerMover).toHaveBeenCalledWith(
        {
          identityId: 'id-1',
          tenantId: TENANT,
          changedFields: ['departmentName'],
          previousAttributes: { departmentName: 'Sales' },
          trigger: 're-evaluate',
        },
        { requestedBy: 'ops@acme.test' },
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ACCESS_REEVALUATION_REQUESTED',
          actor: 'ops@acme.test',
          resourceType: 'identity',
          resourceId: 'id-1',
          tenantId: TENANT,
          payload: {
            metadata: { workflowId: `t-${TENANT}-mover-id-1`, changedFields: ['departmentName'] },
          },
        }),
      );
      expect(JSON.stringify(auditService.log.mock.calls)).not.toContain('ada@acme.test');
    });

    it('starts an identity without an email too: the mover reads it by id', async () => {
      const { service, moverService } = setup(
        identity({ profile: { firstName: 'Ada', departmentName: 'Engineering' } }),
      );

      await inTenant(() => service.reevaluate('id-1', 'ops@acme.test'));

      expect(moverService.triggerMover).toHaveBeenCalledWith(
        expect.objectContaining({
          identityId: 'id-1',
          previousAttributes: { departmentName: 'Sales' },
        }),
        { requestedBy: 'ops@acme.test' },
      );
    });

    it('starts an identity whose only target is in ERROR after a failed mover run', async () => {
      const { service, moverService } = setup(
        identity({
          provisioning: [
            { targetSystem: 'okta', status: 'ERROR', provisionedAt: new Date('2026-11-02') },
          ],
        }),
      );

      await inTenant(() => service.reevaluate('id-1', 'ops@acme.test'));

      expect(moverService.triggerMover).toHaveBeenCalledWith(
        expect.objectContaining({ identityId: 'id-1', trigger: 're-evaluate' }),
        { requestedBy: 'ops@acme.test' },
      );
    });

    it('409 without a baseline or without a provisioned target, nothing started', async () => {
      for (const over of [
        { accessBaseline: undefined },
        { provisioning: [{ targetSystem: 'entra-id', status: 'DEPROVISIONED' }] },
        // Onboarding failed there before any account existed
        { provisioning: [{ targetSystem: 'okta', status: 'ERROR' }] },
        // Deprovisioned, then a provision that failed: the removed account is no account
        {
          provisioning: [
            { targetSystem: 'okta', status: 'ERROR', provisionedAt: null, writebackComplete: true },
          ],
        },
      ]) {
        const { service, moverService } = setup(identity(over));
        await expect(
          inTenant(() => service.reevaluate('id-1', 'ops@acme.test')),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(moverService.triggerMover).not.toHaveBeenCalled();
      }
    });

    it('409 while a mover run for the identity is in progress, not audited', async () => {
      const { service, moverService, auditService } = setup(identity());
      moverService.triggerMover.mockRejectedValueOnce(
        new WorkflowExecutionAlreadyStartedError('already started', 'wf', 'moverWorkflow'),
      );

      await expect(inTenant(() => service.reevaluate('id-1', 'ops@acme.test'))).rejects.toThrow(
        'already in progress',
      );
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('404 for an identity not found in the tenant', async () => {
      const { service, moverService } = setup(null);
      await expect(
        inTenant(() => service.reevaluate('id-x', 'ops@acme.test')),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(moverService.triggerMover).not.toHaveBeenCalled();
    });
  });
});
