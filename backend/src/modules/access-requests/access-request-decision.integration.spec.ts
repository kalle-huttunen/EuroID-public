/**
 * An approver's decision or delegation when the approval workflow cannot take it (in-memory
 * MongoDB, tenant plugin). The step decision (or the new approver) is claimed before the
 * APPROVAL_DECISION signal, so two approvers never decide one step; when the signal fails the
 * claim must not leave the request stuck:
 *   - the workflow no longer exists (timed out, terminated): the request is closed CANCELLED
 *     (nobody rejected it) with the reason "The approval workflow is no longer running."
 *     (audited as access_request.closed, actor system), the claimed decision stays on the step,
 *     and the approver gets 409 with that message;
 *   - Temporal cannot be reached: the claim is released (step PENDING again, a rejection's
 *     request PENDING_APPROVAL again, a delegated step back with its approver) and the approver
 *     gets 503, so a retry can do it.
 * Before, the step stayed APPROVED or REJECTED while the request stayed PENDING_APPROVAL, and
 * nobody could decide it again.
 *
 * Also AccessRequestClosureService on its own: it closes only a request still in the expected
 * status (the approval workflow's expiry of a request whose end date passed before approval
 * completed uses it, test/workflows/access-request-delegate-end-date.workflow.e2e-spec.ts).
 */
import mongoose, { Model } from 'mongoose';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ServiceError, WorkflowNotFoundError } from '@temporalio/client';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { DomainEventType } from '@infrastructure/events/event-types';
import { connectTestDb, clearTestDb, closeTestDb, withTestTenant, TEST_TENANT_ID } from '@testing';
import {
  AccessRequest,
  AccessRequestSchema,
  type AccessRequestDocument,
  type AccessRequestStatus,
} from './schemas/access-request.schema';
import { AccessRequestClosureService, CLOSE_REASONS } from './access-request-closure.service';
import {
  AccessRequestDecisionService,
  DECISION_NOT_DELIVERED_MESSAGE,
  WORKFLOW_GONE_MESSAGE,
} from './access-request-decision.service';

// Tenant scoping as at runtime (TenantModule registers the plugin at import time)
mongoose.plugin(tenantPlugin);

type DecisionCtor = ConstructorParameters<typeof AccessRequestDecisionService>;
type ClosureCtor = ConstructorParameters<typeof AccessRequestClosureService>;

const APPROVER = 'anna.approver@example.com';
const DELEGATE = 'dave.delegate@example.com';
const TARGET = 'tess.target@example.com';

/** `fn` in the test tenant's context, as a request runs it. */
const inTenant = <T>(fn: () => Promise<T>): Promise<T> => Promise.resolve(withTestTenant(fn));

describe('Access request decisions when the approval workflow cannot take them (MongoDB)', () => {
  let model: Model<AccessRequestDocument>;
  let closure: AccessRequestClosureService;
  let decisions: AccessRequestDecisionService;
  const events = { emit: jest.fn() };
  const signal = jest.fn();
  let temporalConnected = true;
  const temporal = {
    getClient: () => {
      if (!temporalConnected) {
        throw new Error('Temporal is not connected. Start the Temporal server and restart.');
      }
      return { workflow: { getHandle: () => ({ signal }) } };
    },
  };

  /** The stored request as MongoDB holds it, without Mongoose. */
  const stored = () => model.collection.findOne({ requestId: 'req-1' });

  const seed = (status: AccessRequestStatus = 'PENDING_APPROVAL') =>
    inTenant(() =>
      model.create({
        tenantId: TEST_TENANT_ID,
        requestId: 'req-1',
        requesterId: 'id-requester',
        requesterEmail: 'requester@example.com',
        entitlements: [
          {
            catalogEntryId: 'cat-1',
            system: 'entra-id',
            entitlementName: 'Finance',
            justification: 'quarter close',
          },
        ],
        status,
        approvalSteps: [
          {
            stepOrder: 0,
            approverType: 'SPECIFIC_USER',
            approverId: 'id-approver',
            approverEmail: APPROVER,
            status: 'PENDING',
          },
        ],
        workflowId: 'access-request-req-1',
      }),
    );

  const approve = () =>
    inTenant(() => decisions.approve('req-1', 0, 'id-approver', APPROVER, 'ok'));
  const reject = () => inTenant(() => decisions.reject('req-1', 0, 'id-approver', APPROVER, 'no'));
  const delegate = () =>
    inTenant(() => decisions.delegate('req-1', 0, 'id-approver', APPROVER, DELEGATE));

  const workflowGone = () =>
    new WorkflowNotFoundError('workflow execution already completed', 'access-request-req-1', '');
  const unreachable = () =>
    new ServiceError('Failed to signal Workflow', { cause: new Error('14 UNAVAILABLE') });

  beforeAll(async () => {
    await connectTestDb();
    model = mongoose.model(
      AccessRequest.name,
      AccessRequestSchema,
    ) as unknown as Model<AccessRequestDocument>;
    closure = new AccessRequestClosureService(
      model as unknown as ClosureCtor[0],
      events as unknown as ClosureCtor[1],
    );
    decisions = new AccessRequestDecisionService(
      model as unknown as DecisionCtor[0],
      {
        findByEmail: jest.fn(
          async (email: string) =>
            ({
              [DELEGATE]: { _id: 'id-delegate', email: DELEGATE },
              'requester@example.com': { _id: 'id-requester', email: 'requester@example.com' },
              [TARGET]: { _id: 'id-target', email: TARGET },
            })[email] ?? null,
        ),
        findById: jest.fn().mockResolvedValue(null),
      } as unknown as DecisionCtor[1],
      temporal as unknown as DecisionCtor[2],
      {
        approverRoleOf: jest.fn().mockResolvedValue(null),
        isStepApprover: jest.fn().mockReturnValue(true),
      } as unknown as DecisionCtor[3],
      closure,
    );
  });

  beforeEach(() => {
    events.emit.mockReset();
    signal.mockReset().mockResolvedValue(undefined);
    temporalConnected = true;
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe('the approval workflow no longer exists', () => {
    it('an approval closes the request CANCELLED with the reason and answers 409', async () => {
      await seed();
      signal.mockRejectedValue(workflowGone());

      const error = await approve().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toBe(WORKFLOW_GONE_MESSAGE);
      expect(WORKFLOW_GONE_MESSAGE).toContain('The approval workflow is no longer running.');
      const doc = await stored();
      expect(doc).toMatchObject({
        status: 'CANCELLED',
        statusReason: CLOSE_REASONS.workflowGone,
      });
      // What the approver did stays on the step
      expect(doc?.approvalSteps[0]).toMatchObject({ status: 'APPROVED', decidedBy: APPROVER });
      expect(events.emit).toHaveBeenCalledWith(
        DomainEventType.ACCESS_REQUEST_CLOSED,
        'req-1',
        { requestId: 'req-1', status: 'CANCELLED', reason: CLOSE_REASONS.workflowGone },
        { actor: 'system' },
      );
      // Closed: nobody decides it again
      await expect(approve()).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a rejection closes the request CANCELLED, keeps the rejected step, answers 409', async () => {
      await seed();
      signal.mockRejectedValue(workflowGone());

      const error = await reject().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toBe(WORKFLOW_GONE_MESSAGE);
      const doc = await stored();
      expect(doc).toMatchObject({
        status: 'CANCELLED',
        statusReason: CLOSE_REASONS.workflowGone,
      });
      expect(doc?.approvalSteps[0]).toMatchObject({ status: 'REJECTED', decidedBy: APPROVER });
      expect(events.emit).toHaveBeenCalledWith(
        DomainEventType.ACCESS_REQUEST_CLOSED,
        'req-1',
        expect.objectContaining({ status: 'CANCELLED', reason: CLOSE_REASONS.workflowGone }),
        { actor: 'system' },
      );
    });

    it('a delegation closes the request CANCELLED, keeps the delegate, answers 409', async () => {
      await seed();
      signal.mockRejectedValue(workflowGone());

      const error = await delegate().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toBe(WORKFLOW_GONE_MESSAGE);
      const doc = await stored();
      expect(doc).toMatchObject({
        status: 'CANCELLED',
        statusReason: CLOSE_REASONS.workflowGone,
      });
      expect(doc?.approvalSteps[0]).toMatchObject({
        status: 'PENDING',
        approverId: 'id-delegate',
        approverEmail: DELEGATE,
        delegatedFrom: APPROVER,
      });
    });
  });

  describe('Temporal cannot be reached', () => {
    it('an approval releases the step, answers 503, and a retry decides it', async () => {
      await seed();
      signal.mockRejectedValueOnce(unreachable());

      const error = await approve().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as Error).message).toBe(DECISION_NOT_DELIVERED_MESSAGE);
      const released = await stored();
      expect(released?.status).toBe('PENDING_APPROVAL');
      expect(released?.statusReason).toBeUndefined();
      expect(released?.approvalSteps[0].status).toBe('PENDING');
      expect(released?.approvalSteps[0]).not.toHaveProperty('decidedAt');
      expect(released?.approvalSteps[0]).not.toHaveProperty('decidedBy');
      expect(released?.approvalSteps[0]).not.toHaveProperty('justification');
      expect(events.emit).not.toHaveBeenCalled();

      await approve();

      expect(signal).toHaveBeenCalledTimes(2);
      expect(signal).toHaveBeenLastCalledWith('APPROVAL_DECISION', {
        stepIndex: 0,
        decision: 'approve',
        justification: 'ok',
      });
      expect((await stored())?.approvalSteps[0]).toMatchObject({
        status: 'APPROVED',
        decidedBy: APPROVER,
      });
    });

    it('a rejection puts the request back to PENDING_APPROVAL and answers 503', async () => {
      await seed();
      temporalConnected = false;

      const error = await reject().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const released = await stored();
      expect(released?.status).toBe('PENDING_APPROVAL');
      expect(released?.approvalSteps[0].status).toBe('PENDING');
      expect(released?.approvalSteps[0]).not.toHaveProperty('decidedBy');

      temporalConnected = true;
      await reject();
      expect((await stored())?.status).toBe('REJECTED');
    });

    it('a delegation gives the step back to its approver and answers 503; a retry works', async () => {
      await seed();
      signal.mockRejectedValueOnce(unreachable());

      const error = await delegate().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as Error).message).toBe(DECISION_NOT_DELIVERED_MESSAGE);
      const released = await stored();
      expect(released?.status).toBe('PENDING_APPROVAL');
      expect(released?.approvalSteps[0]).toMatchObject({
        status: 'PENDING',
        approverId: 'id-approver',
        approverEmail: APPROVER,
      });
      expect(released?.approvalSteps[0]).not.toHaveProperty('delegatedFrom');

      await delegate();

      expect(signal).toHaveBeenLastCalledWith('APPROVAL_DECISION', {
        stepIndex: 0,
        decision: 'delegate',
        delegateTo: DELEGATE,
      });
      expect((await stored())?.approvalSteps[0]).toMatchObject({
        approverEmail: DELEGATE,
        delegatedFrom: APPROVER,
      });
    });

    it('never delegates a step that was decided meanwhile', async () => {
      await seed();
      await approve();

      await expect(delegate()).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // r2-04 N5: the guard compared the approver with the requester only, so the person a
  // manager asked access for could approve it (owning the entry, or as a delegate)
  describe('the person the access is for', () => {
    const forTarget = () =>
      model.collection.updateOne(
        { requestId: 'req-1' },
        { $set: { targetIdentityId: 'id-target' } },
      );

    it('cannot approve their own access', async () => {
      await seed();
      await forTarget();

      await expect(
        inTenant(() => decisions.approve('req-1', 0, 'id-target', TARGET, 'ok')),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect((await stored())?.approvalSteps[0].status).toBe('PENDING');
    });

    it.each([
      ['the person the access is for', TARGET],
      ['the requester', 'requester@example.com'],
    ])('cannot be handed a step by delegation: %s', async (_who, delegateTo) => {
      await seed();
      await forTarget();

      await expect(
        inTenant(() => decisions.delegate('req-1', 0, 'id-approver', APPROVER, delegateTo)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect((await stored())?.approvalSteps[0].approverEmail).toBe(APPROVER);
      expect(signal).not.toHaveBeenCalled();
    });
  });

  // Hunt 04 F5: cancel read PENDING_APPROVAL, then wrote CANCELLED with no status condition. A
  // final approval in between let the workflow claim the request for fulfilment (PROVISIONING);
  // the cancel then wrote CANCELLED over it, and the run still fulfilled it and wrote ACTIVE.
  describe('the requester cancels', () => {
    const cancel = () => inTenant(() => decisions.cancel('req-1', 'id-requester'));

    it('cancels a pending request and tells the workflow', async () => {
      await seed();

      await cancel();

      expect(await stored()).toMatchObject({ status: 'CANCELLED' });
      expect(signal).toHaveBeenCalledWith('CANCEL_REQUEST');
    });

    it('leaves a request claimed for fulfilment after it was read as pending', async () => {
      await seed();
      const pendingAsRead = await inTenant(() => model.findOne({ requestId: 'req-1' }).exec());
      await model.collection.updateOne(
        { requestId: 'req-1' },
        { $set: { status: 'PROVISIONING' } },
      );
      const findOne = jest
        .spyOn(model, 'findOne')
        .mockReturnValueOnce({ exec: async () => pendingAsRead } as never);

      try {
        await expect(cancel()).rejects.toBeInstanceOf(BadRequestException);
      } finally {
        findOne.mockRestore();
      }
      expect(await stored()).toMatchObject({ status: 'PROVISIONING' });
      expect(signal).not.toHaveBeenCalled();
    });
  });

  describe('AccessRequestClosureService', () => {
    it('closes a pending request as EXPIRED with the reason, audited', async () => {
      await seed();

      const closed = await inTenant(() =>
        closure.close('req-1', 'EXPIRED', CLOSE_REASONS.endDatePassed, 'PENDING_APPROVAL'),
      );

      expect(closed).toBe(true);
      expect(await stored()).toMatchObject({
        status: 'EXPIRED',
        statusReason: 'The requested end date passed before approval completed.',
      });
      expect(events.emit).toHaveBeenCalledWith(
        DomainEventType.ACCESS_REQUEST_CLOSED,
        'req-1',
        { requestId: 'req-1', status: 'EXPIRED', reason: CLOSE_REASONS.endDatePassed },
        { actor: 'system' },
      );
    });

    it('leaves a request that is no longer in the expected status as it is', async () => {
      await seed('CANCELLED');

      const closed = await inTenant(() =>
        closure.close('req-1', 'EXPIRED', CLOSE_REASONS.endDatePassed, 'PENDING_APPROVAL'),
      );

      expect(closed).toBe(false);
      expect(await stored()).toMatchObject({ status: 'CANCELLED' });
      expect((await stored())?.statusReason).toBeUndefined();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });
});
