import { Test } from '@nestjs/testing';
import { ApplicationFailure } from '@temporalio/common';
import { MoverActivities, MOVER_SOD_VIOLATION } from './mover.activities';
import { PolicyActivities, sodViolationFailure } from './policy.activities';
import { TEST_TENANT_ID } from '@testing/test-helpers';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { IdentityService } from '../modules/identity/identity.service';
import type { MoverOutcome } from '@shared/types/mover';
import { getModelToken } from '@nestjs/mongoose';
import { AccessRequest } from '../modules/access-requests/schemas/access-request.schema';

describe('MoverActivities', () => {
  let activities: MoverActivities;
  const emit = jest.fn();
  const tenantsSeen: string[] = [];
  const advanceAccessBaseline = jest.fn(async () => {
    tenantsSeen.push(requestContext.getStore()?.tenantId ?? '');
  });
  const findIdentityById = jest.fn();
  const buildProfileWithContractsForPolicy = jest.fn();
  const evaluateUser = jest.fn();
  /** The access_requests find (read only): the requests evaluateMoverChange reads. */
  const accessRequests = jest.fn();

  beforeEach(async () => {
    emit.mockReset();
    accessRequests.mockReset().mockResolvedValue([]);
    advanceAccessBaseline.mockClear();
    findIdentityById.mockReset();
    buildProfileWithContractsForPolicy.mockReset();
    evaluateUser.mockReset();
    tenantsSeen.length = 0;
    const module = await Test.createTestingModule({
      providers: [
        MoverActivities,
        { provide: DomainEventEmitterService, useValue: { emit } },
        {
          provide: IdentityService,
          useValue: { advanceAccessBaseline, findIdentityById, buildProfileWithContractsForPolicy },
        },
        { provide: PolicyActivities, useValue: { evaluateUser } },
        {
          provide: getModelToken(AccessRequest.name),
          useValue: {
            find: (filter: unknown) => ({ lean: () => ({ exec: () => accessRequests(filter) }) }),
          },
        },
      ],
    }).compile();

    activities = module.get(MoverActivities);
  });

  describe('evaluateMoverChange', () => {
    const PROFILE = {
      email: 'ada@acme.test',
      firstName: 'Ada',
      mobilePhone: '+358 40 123 4567',
      departmentName: 'Engineering',
    };
    const group = (target: string, targetId: string) => ({
      type: 'group',
      action: 'add',
      target,
      targetId,
      sourcePolicy: 'p-dept',
      params: { groupName: targetId },
    });
    /** Sales: Entra and Okta groups; Engineering: other Entra and Okta groups plus one in AD. */
    const policy = (user: { departmentName?: string }) => ({
      operations:
        user.departmentName === 'Sales'
          ? [group('entra-id', 'g-sales'), group('okta', 'okta-sales')]
          : [group('entra-id', 'g-eng'), group('okta', 'okta-eng'), group('ad', 'ad-eng')],
    });

    const PROVISIONING = [
      { targetSystem: 'entra-id', status: 'SYNCED' },
      { targetSystem: 'ad', status: 'SYNCED', writebackComplete: true },
    ];

    beforeEach(() => {
      findIdentityById.mockResolvedValue({
        _id: 'id-1',
        profile: PROFILE,
        provisioning: PROVISIONING,
      });
      buildProfileWithContractsForPolicy.mockResolvedValue({ ...PROFILE });
      evaluateUser.mockImplementation(async (user: { departmentName?: string }) => policy(user));
    });

    it('reads the identity by id and returns the delta with ids and attribute values only', async () => {
      const result = await activities.evaluateMoverChange(
        'id-1',
        ['departmentName'],
        { departmentName: 'Sales' },
        TEST_TENANT_ID,
        'wf-1',
      );

      expect(findIdentityById).toHaveBeenCalledWith('id-1');
      expect(evaluateUser).toHaveBeenNthCalledWith(1, PROFILE, TEST_TENANT_ID, 'wf-1');
      expect(evaluateUser).toHaveBeenNthCalledWith(
        2,
        { ...PROFILE, departmentName: 'Sales' },
        TEST_TENANT_ID,
        'wf-1',
      );
      const op = (target: string, targetId: string, action: string) => ({
        type: 'group',
        action,
        target,
        targetId,
        sourcePolicy: 'p-dept',
      });
      expect(result).toEqual({
        applied: { departmentName: 'Engineering' },
        toAdd: [
          op('entra-id', 'g-eng', 'add'),
          op('okta', 'okta-eng', 'add'),
          op('ad', 'ad-eng', 'add'),
        ],
        toRemove: [op('entra-id', 'g-sales', 'remove'), op('okta', 'okta-sales', 'remove')],
        operationCounts: { before: 2, after: 3 },
        provisionedSystems: ['entra-id', 'ad'],
      });
      // What goes back into workflow history: no email, name, phone or policy params
      const history = JSON.stringify(result);
      for (const personal of ['ada@acme.test', 'Ada', '4567', 'params']) {
        expect(history).not.toContain(personal);
      }
    });

    // A group the old department's policy gave and an approved access request also gave stays:
    // the move ends the policy's grant, not the request's (hunt 03 F9)
    it("does not remove what the identity's active access requests also grant", async () => {
      accessRequests.mockResolvedValue([
        {
          entitlements: [
            { system: 'entra-id', entitlementType: 'Group', nativeId: 'g-sales' },
            { system: 'entra-id', entitlementType: 'Group' },
          ],
        },
      ]);

      const result = await activities.evaluateMoverChange(
        'id-1',
        ['departmentName'],
        { departmentName: 'Sales' },
        TEST_TENANT_ID,
        'wf-1',
      );

      expect(accessRequests).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TEST_TENANT_ID,
          status: { $in: ['ACTIVE', 'PROVISIONING'] },
        }),
      );
      expect(result?.toRemove.map((op) => op.targetId)).toEqual(['okta-sales']);
      expect(result?.toAdd.map((op) => op.targetId)).toEqual(['g-eng', 'okta-eng', 'ad-eng']);
    });

    // R1: a lifted access review exclusion's access is given back by the next run. Its "before"
    // side still leaves out what exclusions lifted after the access baseline took away.
    it('evaluates the before side with exclusions lifted since the baseline', async () => {
      const recordedAt = new Date('2026-11-20T08:00:00.000Z');
      findIdentityById.mockResolvedValue({
        _id: 'id-1',
        profile: PROFILE,
        provisioning: PROVISIONING,
        accessBaseline: { attributes: { departmentName: 'Engineering' }, recordedAt },
      });

      await activities.evaluateMoverChange('id-1', [], {}, TEST_TENANT_ID, 'wf-1');

      expect(evaluateUser).toHaveBeenNthCalledWith(1, PROFILE, TEST_TENANT_ID, 'wf-1');
      expect(evaluateUser).toHaveBeenNthCalledWith(2, PROFILE, TEST_TENANT_ID, 'wf-1', {
        reviewExclusionsLiftedSince: recordedAt,
      });
    });

    it('returns the systems the identity is provisioned to, where the mover may change access', async () => {
      findIdentityById.mockResolvedValue({
        _id: 'id-1',
        profile: PROFILE,
        provisioning: [
          { targetSystem: 'entra-id', status: 'SYNCED' },
          // Onboarding completed there; the last (mover) run failed: the next run tries again
          { targetSystem: 'ad', status: 'ERROR', writebackComplete: true },
          { targetSystem: 'scim', status: 'SYNCING', writebackComplete: true },
          // Onboarding failed or stopped there: no account to change
          { targetSystem: 'okta', status: 'ERROR', errorMsg: 'Okta refused the user' },
          { targetSystem: 'servicenow', status: 'SYNCING' },
          { targetSystem: 'github', status: 'PENDING' },
          // Offboarded or revoked
          { targetSystem: 'ad-legacy', status: 'DEPROVISIONED', writebackComplete: true },
        ],
      });

      const result = await activities.evaluateMoverChange(
        'id-1',
        ['departmentName'],
        { departmentName: 'Sales' },
        TEST_TENANT_ID,
      );

      expect(result?.provisionedSystems).toEqual(['entra-id', 'ad', 'scim']);
    });

    it('returns no provisioned system for an identity without provisioning entries', async () => {
      findIdentityById.mockResolvedValue({ _id: 'id-1', profile: PROFILE });
      const result = await activities.evaluateMoverChange(
        'id-1',
        ['departmentName'],
        { departmentName: 'Sales' },
        TEST_TENANT_ID,
      );
      expect(result?.provisionedSystems).toEqual([]);
    });

    describe('an HR move of an identity whose HR contract the policies also evaluate', () => {
      /** The contract IdentityOnionService derives from the HR source, as the HR data says. */
      const contract = (department: string) => ({
        id: 'E100',
        title: 'Engineer',
        department,
        isPrimary: true,
        status: 'ACTIVE',
      });
      /** The policy engine: the profile and each contract, unioned (evaluateWithPolicies). */
      const withContracts = (user: {
        departmentName?: string;
        contracts?: Array<{ department: string }>;
      }) => {
        const views = [
          user,
          ...(user.contracts ?? []).map((c) => ({ departmentName: c.department })),
        ];
        const ops = views.flatMap((view) => policy(view).operations);
        return {
          operations: ops.filter(
            (op, i) =>
              ops.findIndex((o) => o.target === op.target && o.targetId === op.targetId) === i,
          ),
        };
      };
      const MOVED = { ...PROFILE, departmentName: 'Sales' };

      beforeEach(() => {
        // The HR sync moved Ada to Sales: profile and contract say Sales; the baseline still has
        // the Engineering profile and contract access was applied with
        findIdentityById.mockResolvedValue({
          _id: 'id-1',
          profile: MOVED,
          provisioning: PROVISIONING,
          accessBaseline: {
            attributes: { departmentName: 'Engineering', contracts: [contract('Engineering')] },
          },
        });
        buildProfileWithContractsForPolicy.mockResolvedValue({
          ...MOVED,
          contracts: [contract('Sales')],
        });
        evaluateUser.mockImplementation(async (user) => withContracts(user));
      });

      it('evaluates the before side with the contracts access was applied with', async () => {
        const result = await activities.evaluateMoverChange(
          'id-1',
          ['departmentName'],
          { departmentName: 'Engineering' },
          TEST_TENANT_ID,
        );

        expect(evaluateUser).toHaveBeenNthCalledWith(
          2,
          { ...MOVED, departmentName: 'Engineering', contracts: [contract('Engineering')] },
          TEST_TENANT_ID,
          undefined,
        );
        expect(result?.toAdd.map((op) => op.targetId)).toEqual(['g-sales', 'okta-sales']);
        expect(result?.toRemove.map((op) => op.targetId)).toEqual(['g-eng', 'okta-eng', 'ad-eng']);
        // A completed run advances the baseline's contracts too, so the preview shows no change
        expect(result?.applied).toEqual({
          departmentName: 'Sales',
          contracts: [contract('Sales')],
        });
      });

      it('keeps the contracts a re-evaluation names as previous', async () => {
        await activities.evaluateMoverChange(
          'id-1',
          ['departmentName', 'contracts'],
          { departmentName: 'Engineering', contracts: [contract('Engineering')] },
          TEST_TENANT_ID,
        );
        expect(evaluateUser).toHaveBeenNthCalledWith(
          2,
          { ...MOVED, departmentName: 'Engineering', contracts: [contract('Engineering')] },
          TEST_TENANT_ID,
          undefined,
        );
      });
    });

    // Plan 2.0dn: identity.updated carries the old manager masked (it reaches the audit log, the
    // analytics index and the websocket). A policy on managerEmail needs the real value.
    describe('an edit of the manager, whose old value the event carries masked', () => {
      /** Reports to the CFO: a finance-reports group; anyone else: none. */
      const managerPolicy = (user: { managerEmail?: string }) => ({
        operations:
          user.managerEmail === 'cfo@acme.test' ? [group('entra-id', 'g-finance-reports')] : [],
      });
      const EDITED = { ...PROFILE, managerEmail: 'cto@acme.test' };

      beforeEach(() => {
        buildProfileWithContractsForPolicy.mockResolvedValue({ ...EDITED });
        evaluateUser.mockImplementation(async (user) => managerPolicy(user));
      });

      it('evaluates the before side with the manager access was applied with', async () => {
        findIdentityById.mockResolvedValue({
          _id: 'id-1',
          profile: EDITED,
          provisioning: PROVISIONING,
          accessBaseline: {
            attributes: { departmentName: 'Engineering', managerEmail: 'cfo@acme.test' },
          },
        });

        const result = await activities.evaluateMoverChange(
          'id-1',
          ['managerEmail'],
          { managerEmail: 'c•••@acme.test' },
          TEST_TENANT_ID,
        );

        expect(evaluateUser).toHaveBeenNthCalledWith(
          2,
          { ...EDITED, managerEmail: 'cfo@acme.test' },
          TEST_TENANT_ID,
          undefined,
        );
        expect(result?.toRemove.map((op) => op.targetId)).toEqual(['g-finance-reports']);
        expect(JSON.stringify(result)).not.toContain('cfo@acme.test');
      });

      it('evaluates no manager on the before side when access was applied without one', async () => {
        findIdentityById.mockResolvedValue({
          _id: 'id-1',
          profile: EDITED,
          provisioning: PROVISIONING,
          accessBaseline: { attributes: { departmentName: 'Engineering' } },
        });

        await activities.evaluateMoverChange(
          'id-1',
          ['managerEmail'],
          { managerEmail: 'c•••@acme.test' },
          TEST_TENANT_ID,
        );

        expect(evaluateUser).toHaveBeenNthCalledWith(
          2,
          { ...EDITED, managerEmail: null },
          TEST_TENANT_ID,
          undefined,
        );
      });

      it('keeps the masked value without an access baseline: no rule on the old manager matches', async () => {
        findIdentityById.mockResolvedValue({
          _id: 'id-1',
          profile: EDITED,
          provisioning: PROVISIONING,
        });

        await activities.evaluateMoverChange(
          'id-1',
          ['managerEmail'],
          { managerEmail: 'c•••@acme.test' },
          TEST_TENANT_ID,
        );

        expect(evaluateUser).toHaveBeenNthCalledWith(
          2,
          { ...EDITED, managerEmail: 'c•••@acme.test' },
          TEST_TENANT_ID,
          undefined,
        );
      });
    });

    it('returns null for an identity the tenant does not have (or a deleted one)', async () => {
      findIdentityById.mockResolvedValue(null);
      await expect(
        activities.evaluateMoverChange('id-x', ['departmentName'], {}, TEST_TENANT_ID),
      ).resolves.toBeNull();
      expect(evaluateUser).not.toHaveBeenCalled();
    });

    it('fails at once on a BLOCK SoD conflict, naming the SoD policy', async () => {
      // As PolicyActivities.evaluateUser fails it: the mover passes it on unchanged
      evaluateUser.mockRejectedValueOnce(
        sodViolationFailure([
          {
            policyName: 'Payments vs approvals',
            severity: 'high',
            action: 'BLOCK',
            conflictingEntitlements: [],
          },
        ]),
      );

      const error = await activities
        .evaluateMoverChange(
          'id-1',
          ['departmentName'],
          { departmentName: 'Sales' },
          TEST_TENANT_ID,
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApplicationFailure);
      expect((error as ApplicationFailure).nonRetryable).toBe(true);
      expect((error as ApplicationFailure).type).toBe(MOVER_SOD_VIOLATION);
      expect((error as ApplicationFailure).message).toContain('Payments vs approvals');
    });

    it('lets other evaluation failures be retried', async () => {
      const failure = ApplicationFailure.create({ message: 'Policy evaluation failed: db down' });
      evaluateUser.mockRejectedValueOnce(failure);
      await expect(
        activities.evaluateMoverChange('id-1', ['departmentName'], {}, TEST_TENANT_ID),
      ).rejects.toBe(failure);
    });
  });

  describe('computeEntitlementDelta', () => {
    const makeOp = (
      type: string,
      target: string,
      targetId: string,
      action: string = 'add',
      sourcePolicy?: string,
    ) => ({
      type,
      action,
      target,
      targetId,
      sourcePolicy,
    });

    it('should identify new additions (in new but not old)', async () => {
      const oldOps = [makeOp('group', 'entra-id', 'g-sales')];
      const newOps = [
        makeOp('group', 'entra-id', 'g-sales'),
        makeOp('group', 'entra-id', 'g-engineering'),
      ];

      const delta = await activities.computeEntitlementDelta(oldOps, newOps, TEST_TENANT_ID);

      expect(delta.toAdd).toHaveLength(1);
      expect(delta.toAdd[0].targetId).toBe('g-engineering');
      expect(delta.toRemove).toHaveLength(0);
    });

    it('should identify removals (in old but not new)', async () => {
      const oldOps = [
        makeOp('group', 'entra-id', 'g-sales'),
        makeOp('group', 'entra-id', 'g-engineering'),
      ];
      const newOps = [makeOp('group', 'entra-id', 'g-sales')];

      const delta = await activities.computeEntitlementDelta(oldOps, newOps, TEST_TENANT_ID);

      expect(delta.toAdd).toHaveLength(0);
      expect(delta.toRemove).toHaveLength(1);
      expect(delta.toRemove[0].targetId).toBe('g-engineering');
      expect(delta.toRemove[0].action).toBe('remove');
    });

    it('should handle both additions and removals (department change), and an empty side', async () => {
      const oldOps = [
        makeOp('group', 'entra-id', 'g-sales'),
        makeOp('license', 'entra-id', 'l-salesforce'),
      ];
      const newOps = [
        makeOp('group', 'entra-id', 'g-engineering'),
        makeOp('license', 'entra-id', 'l-github'),
      ];

      const delta = await activities.computeEntitlementDelta(oldOps, newOps, TEST_TENANT_ID);

      expect(delta.toAdd).toHaveLength(2);
      expect(delta.toRemove).toHaveLength(2);
      expect(delta.toAdd.map((op) => op.targetId).sort()).toEqual(['g-engineering', 'l-github']);
      expect(delta.toRemove.map((op) => op.targetId).sort()).toEqual(['g-sales', 'l-salesforce']);

      // No old evaluation (new hire): everything is added. No new one (full revocation): removed.
      const hire = await activities.computeEntitlementDelta([], newOps, TEST_TENANT_ID);
      expect(hire.toAdd.map((op) => op.targetId).sort()).toEqual(['g-engineering', 'l-github']);
      expect(hire.toRemove).toHaveLength(0);
      const revocation = await activities.computeEntitlementDelta(oldOps, [], TEST_TENANT_ID);
      expect(revocation.toAdd).toHaveLength(0);
      expect(revocation.toRemove.map((op) => op.targetId).sort()).toEqual([
        'g-sales',
        'l-salesforce',
      ]);
    });

    it('should return empty delta when no changes', async () => {
      const ops = [
        makeOp('group', 'entra-id', 'g-sales'),
        makeOp('license', 'entra-id', 'l-office'),
      ];

      const delta = await activities.computeEntitlementDelta(ops, [...ops], TEST_TENANT_ID);

      expect(delta.toAdd).toHaveLength(0);
      expect(delta.toRemove).toHaveLength(0);
    });

    it('should only compare add operations, ignoring remove ops', async () => {
      const oldOps = [
        makeOp('group', 'entra-id', 'g-sales', 'add'),
        makeOp('group', 'entra-id', 'g-temp', 'remove'),
      ];
      const newOps = [makeOp('group', 'entra-id', 'g-sales', 'add')];

      const delta = await activities.computeEntitlementDelta(oldOps, newOps, TEST_TENANT_ID);

      // g-temp was a remove op, so it should not appear in the delta
      expect(delta.toAdd).toHaveLength(0);
      expect(delta.toRemove).toHaveLength(0);
    });

    it('should use composite key (type|target|targetId) for comparison', async () => {
      const oldOps = [makeOp('group', 'entra-id', 'g-1')];
      const newOps = [
        makeOp('license', 'entra-id', 'g-1'), // Same targetId, different type
      ];

      const delta = await activities.computeEntitlementDelta(oldOps, newOps, TEST_TENANT_ID);

      expect(delta.toAdd).toHaveLength(1);
      expect(delta.toRemove).toHaveLength(1);
    });

    it('should throw on empty tenantId', async () => {
      await expect(activities.computeEntitlementDelta([], [], '')).rejects.toThrow('[SECURITY]');
    });
  });

  describe('recordMoverOutcome', () => {
    const outcome = (over: Partial<MoverOutcome> = {}): MoverOutcome => ({
      identityId: 'id-1',
      workflowId: 'wf-1',
      trigger: 're-evaluate',
      status: 'completed',
      changedFields: ['departmentName'],
      added: 1,
      removed: 1,
      systems: [{ system: 'entra-id', outcome: 'updated', added: ['g-eng'], removed: ['g-sales'] }],
      durationMs: 1200,
      ...over,
    });

    it('advances the access baseline in the tenant, then publishes mover.completed', async () => {
      const result = outcome();
      await activities.recordMoverOutcome(
        result,
        { departmentName: 'Engineering' },
        TEST_TENANT_ID,
      );

      expect(advanceAccessBaseline).toHaveBeenCalledWith('id-1', { departmentName: 'Engineering' });
      expect(tenantsSeen).toEqual([TEST_TENANT_ID]);
      expect(emit).toHaveBeenCalledWith(DomainEventType.MOVER_COMPLETED, 'id-1', result, {
        tenantId: TEST_TENANT_ID,
        actor: 'mover-workflow',
      });
      expect(advanceAccessBaseline.mock.invocationCallOrder[0]).toBeLessThan(
        emit.mock.invocationCallOrder[0],
      );
    });

    it('does not advance the baseline for a failed run, publishes mover.failed with emails masked', async () => {
      await activities.recordMoverOutcome(
        outcome({
          status: 'failed',
          reason: 'Graph 404 for ada@acme.test',
          systems: [
            {
              system: 'entra-id',
              outcome: 'failed',
              added: ['g-eng'],
              removed: [],
              reason: 'user ada@acme.test not found ' + 'x'.repeat(1000),
            },
            { system: 'ad', outcome: 'not-attempted', added: ['g-eng'], removed: [] },
          ],
        }),
        { departmentName: 'Engineering' },
        TEST_TENANT_ID,
      );

      expect(advanceAccessBaseline).not.toHaveBeenCalled();
      const [type, , payload] = emit.mock.calls[0];
      expect(type).toBe(DomainEventType.MOVER_FAILED);
      expect(payload.reason).toBe('Graph 404 for a•••@acme.test');
      expect(payload.systems[0].reason).toMatch(/^user a•••@acme\.test not found/);
      expect(payload.systems[0].reason).toHaveLength(500);
      expect(JSON.stringify(payload)).not.toContain('ada@acme.test');
    });

    it('does not advance the baseline of a skipped run', async () => {
      await activities.recordMoverOutcome(
        outcome({ status: 'skipped', reason: 'pipeline PAUSED', systems: [] }),
        undefined,
        TEST_TENANT_ID,
      );
      expect(advanceAccessBaseline).not.toHaveBeenCalled();
      expect(emit.mock.calls[0][0]).toBe(DomainEventType.MOVER_COMPLETED);
    });

    it('refuses to run without a tenant', async () => {
      await expect(activities.recordMoverOutcome(outcome(), undefined, '')).rejects.toThrow(
        '[SECURITY]',
      );
    });
  });
});
