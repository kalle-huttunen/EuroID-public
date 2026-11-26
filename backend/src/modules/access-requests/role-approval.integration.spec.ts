/**
 * ROLE approval steps (in-memory MongoDB, tenant plugin): a step whose approver is an admin role
 * (e.g. `policy-admin`) can be decided by any active admin user of the request's tenant who holds
 * that role, and the step records who decided. Another role, an inactive holder, a holder in
 * another tenant and the requester cannot; once decided, a second holder cannot decide again.
 * Role holders see the request in their pending approvals, badge count and request detail.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { IDENTITY_QUERY_PORT } from '@shared/interfaces/identity-query.port';
import { AdminUser, AdminUserSchema, AdminUserDocument } from '../auth/schemas/admin-user.schema';
import {
  AccessRequest,
  AccessRequestSchema,
  AccessRequestDocument,
  ApprovalStep,
} from './schemas/access-request.schema';
import { AccessRequestDecisionService } from './access-request-decision.service';
import { AccessRequestQueryService } from './access-request-query.service';
import { AccessRequestClosureService } from './access-request-closure.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';

const ROLE_STEP: ApprovalStep = {
  stepOrder: 0,
  approverType: 'ROLE',
  approverId: 'policy-admin',
  approverEmail: 'policy-admin',
  status: 'PENDING',
};

describe('Access requests: ROLE approval steps (MongoDB)', () => {
  let moduleRef: TestingModule;
  let decision: AccessRequestDecisionService;
  let query: AccessRequestQueryService;
  let requests: Model<AccessRequestDocument>;
  const signal = jest.fn();
  const getHandle = jest.fn(() => ({ signal }));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: AccessRequest.name, schema: AccessRequestSchema },
          { name: AdminUser.name, schema: AdminUserSchema },
        ]),
      ],
      providers: [
        AccessRequestDecisionService,
        AccessRequestQueryService,
        { provide: AccessRequestClosureService, useValue: { close: jest.fn() } },
        {
          provide: TemporalClientProvider,
          useValue: { getClient: () => ({ workflow: { getHandle } }) },
        },
        {
          provide: IDENTITY_QUERY_PORT,
          useValue: { findByEmail: jest.fn(), findById: jest.fn() },
        },
      ],
    }).compile();
    decision = moduleRef.get(AccessRequestDecisionService);
    query = moduleRef.get(AccessRequestQueryService);
    requests = moduleRef.get(getModelToken(AccessRequest.name));

    const admins = moduleRef.get<Model<AdminUserDocument>>(getModelToken(AdminUser.name));
    const admin = (email: string, role: string, tenantId: string, isActive = true) => ({
      email,
      role,
      tenantId,
      isActive,
      passwordHash: 'x',
      name: email,
    });
    await admins.create([
      admin('pa@a.example', 'policy-admin', A),
      admin('pa2@a.example', 'policy-admin', A),
      admin('op@a.example', 'operator', A),
      admin('gone@a.example', 'policy-admin', A, false),
      admin('pa@b.example', 'policy-admin', B),
      admin('requester@a.example', 'policy-admin', A),
    ]);
  });

  beforeEach(async () => {
    signal.mockReset();
    getHandle.mockClear();
    await requests.deleteMany({}).setOptions({ skipTenantScope: true });
    await withTenantContext(A, () =>
      requests.create({
        tenantId: A,
        requestId: 'req-role',
        requesterId: 'id-requester',
        requesterEmail: 'requester@a.example',
        entitlements: [
          {
            catalogEntryId: 'cat-1',
            system: 'entra-id',
            entitlementName: 'Finance',
            justification: 'quarter close',
          },
        ],
        status: 'PENDING_APPROVAL',
        approvalSteps: [ROLE_STEP],
        workflowId: 'wf-req-role',
      }),
    );
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const inA = <T>(fn: () => Promise<T>) => withTenantContext(A, fn) as Promise<T>;
  const step = async () =>
    (await requests.findOne({ requestId: 'req-role' }).setOptions({ skipTenantScope: true }).lean())
      ?.approvalSteps[0];

  it('a policy-admin of the tenant approves a policy-admin step, recorded as the decider', async () => {
    await inA(() => decision.approve('req-role', 0, 'id-pa', 'pa@a.example', 'needed'));

    expect(await step()).toMatchObject({
      status: 'APPROVED',
      decidedBy: 'pa@a.example',
      justification: 'needed',
      approverId: 'policy-admin',
    });
    expect(getHandle).toHaveBeenCalledWith('wf-req-role');
    expect(signal).toHaveBeenCalledWith('APPROVAL_DECISION', {
      stepIndex: 0,
      decision: 'approve',
      justification: 'needed',
    });
  });

  it('a role holder can also reject, recorded as the decider', async () => {
    await inA(() => decision.reject('req-role', 0, 'id-pa', 'pa@a.example', 'not needed'));

    expect(await step()).toMatchObject({ status: 'REJECTED', decidedBy: 'pa@a.example' });
    expect(signal).toHaveBeenCalledWith('APPROVAL_DECISION', {
      stepIndex: 0,
      decision: 'reject',
      justification: 'not needed',
    });
  });

  it.each([
    ['another role', 'op@a.example'],
    ['an inactive holder', 'gone@a.example'],
    ['a holder in another tenant', 'pa@b.example'],
    ['an unknown user', 'nobody@a.example'],
  ])('%s cannot decide it', async (_label, email) => {
    await expect(inA(() => decision.approve('req-role', 0, 'id-x', email))).rejects.toThrow(
      ForbiddenException,
    );
    await expect(inA(() => decision.reject('req-role', 0, 'id-x', email))).rejects.toThrow(
      ForbiddenException,
    );
    expect(await step()).toMatchObject({ status: 'PENDING' });
    expect(signal).not.toHaveBeenCalled();
  });

  it('the requester cannot decide it although they hold the role (segregation of duties)', async () => {
    await expect(
      inA(() => decision.approve('req-role', 0, 'id-requester', 'requester@a.example')),
    ).rejects.toThrow(ForbiddenException);
    expect(signal).not.toHaveBeenCalled();
  });

  it('a step one holder decided cannot be decided again by another holder', async () => {
    await inA(() => decision.approve('req-role', 0, 'id-pa', 'pa@a.example'));
    await expect(
      inA(() => decision.approve('req-role', 0, 'id-pa2', 'pa2@a.example')),
    ).rejects.toThrow(BadRequestException);

    expect(await step()).toMatchObject({ status: 'APPROVED', decidedBy: 'pa@a.example' });
    expect(signal).toHaveBeenCalledTimes(1);
  });

  it('role holders see it in pending approvals, the badge count and the detail; others do not', async () => {
    const ids = (docs: AccessRequestDocument[]) => docs.map((d) => d.requestId);

    expect(ids(await inA(() => query.listPendingApprovals('id-pa', 'pa@a.example')))).toEqual([
      'req-role',
    ]);
    expect(await inA(() => query.countPendingApprovals('id-pa', 'pa@a.example'))).toBe(1);
    await expect(
      inA(() => query.getRequestDetail('req-role', 'id-pa', 'pa@a.example')),
    ).resolves.toMatchObject({ requestId: 'req-role' });

    expect(await inA(() => query.listPendingApprovals('id-op', 'op@a.example'))).toEqual([]);
    expect(await inA(() => query.countPendingApprovals('id-op', 'op@a.example'))).toBe(0);
    await expect(
      inA(() => query.getRequestDetail('req-role', 'id-op', 'op@a.example')),
    ).rejects.toThrow(ForbiddenException);

    expect(
      await inA(() => query.listPendingApprovals('id-requester', 'requester@a.example')),
    ).toEqual([]);
    expect(
      await inA(() => query.countPendingApprovals('id-requester', 'requester@a.example')),
    ).toBe(0);
  });

  it('a delegated ROLE step belongs to the delegate, no longer to the role', async () => {
    await requests
      .updateOne(
        { requestId: 'req-role' },
        {
          $set: {
            'approvalSteps.0.approverId': 'id-delegate',
            'approvalSteps.0.approverEmail': 'delegate@a.example',
            'approvalSteps.0.delegatedFrom': 'pa@a.example',
          },
        },
      )
      .setOptions({ skipTenantScope: true });

    await expect(
      inA(() => decision.approve('req-role', 0, 'id-pa2', 'pa2@a.example')),
    ).rejects.toThrow(ForbiddenException);
    expect(await inA(() => query.countPendingApprovals('id-pa2', 'pa2@a.example'))).toBe(0);

    await inA(() => decision.approve('req-role', 0, 'id-delegate', 'delegate@a.example'));
    expect(await step()).toMatchObject({ status: 'APPROVED', decidedBy: 'delegate@a.example' });
  });
});
