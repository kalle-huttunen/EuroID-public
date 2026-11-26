/**
 * The access requests that count for an identity (in-memory MongoDB, tenant plugin):
 * findActiveRequestsForIdentity, read by the offboarding impact preview and by
 * GET /identity/:id/entitlements. A request counts for the identity the access is for (its
 * beneficiary: targetIdentityId, or the requester on a request stored without it), never for a
 * manager who requested it for a direct report. Also the count of requests waiting for approval
 * across tenants (the euroid_access_requests_pending gauge).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { AdminUser, AdminUserSchema } from '../auth/schemas/admin-user.schema';
import {
  AccessRequest,
  AccessRequestSchema,
  AccessRequestDocument,
  AccessRequestStatus,
} from './schemas/access-request.schema';
import { AccessRequestQueryService } from './access-request-query.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';
const MANAGER = 'id-manager';
const REPORT = 'id-report';

describe('Access requests for an identity: the beneficiary (MongoDB)', () => {
  let moduleRef: TestingModule;
  let query: AccessRequestQueryService;
  let requests: Model<AccessRequestDocument>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: AccessRequest.name, schema: AccessRequestSchema },
          { name: AdminUser.name, schema: AdminUserSchema },
        ]),
      ],
      providers: [AccessRequestQueryService],
    }).compile();
    query = moduleRef.get(AccessRequestQueryService);
    requests = moduleRef.get(getModelToken(AccessRequest.name));
  });

  beforeEach(async () => {
    await requests.deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const store = (
    requestId: string,
    fields: {
      requesterId: string;
      targetIdentityId?: string;
      status?: AccessRequestStatus;
      expiresAt?: Date;
      statusReason?: string;
      timeConstraint?: { expiresAt?: Date };
    },
    tenantId = A,
  ) =>
    withTenantContext(tenantId, () =>
      requests.create({
        tenantId,
        requestId,
        requesterEmail: 'someone@a.example',
        entitlements: [
          {
            catalogEntryId: 'cat-1',
            system: 'entra-id',
            entitlementName: 'Finance',
            justification: 'quarter close',
          },
        ],
        status: 'ACTIVE',
        approvalSteps: [],
        ...fields,
      }),
    );

  const idsFor = async (identityId: string) =>
    (await withTenantContext(A, () => query.findActiveRequestsForIdentity(identityId)))
      .map((r) => r.requestId)
      .sort();

  it("a manager's request for a direct report counts for the report, not for the manager", async () => {
    await store('for-report', { requesterId: MANAGER, targetIdentityId: REPORT });

    expect(await idsFor(REPORT)).toEqual(['for-report']);
    expect(await idsFor(MANAGER)).toEqual([]);
  });

  it("the manager's own requests still count for the manager", async () => {
    await store('own', { requesterId: MANAGER, targetIdentityId: MANAGER });
    await store('own-legacy', { requesterId: MANAGER }); // stored without targetIdentityId
    await store('for-report', { requesterId: MANAGER, targetIdentityId: REPORT });

    expect(await idsFor(MANAGER)).toEqual(['own', 'own-legacy']);
  });

  it('only access in force or being given (ACTIVE, PROVISIONING), in the caller tenant', async () => {
    await store('active', { requesterId: REPORT, targetIdentityId: REPORT });
    await store('provisioning', {
      requesterId: MANAGER,
      targetIdentityId: REPORT,
      status: 'PROVISIONING',
    });
    await store('pending', {
      requesterId: REPORT,
      targetIdentityId: REPORT,
      status: 'PENDING_APPROVAL',
    });
    await store('expired', { requesterId: REPORT, targetIdentityId: REPORT, status: 'EXPIRED' });
    await store('other-tenant', { requesterId: REPORT, targetIdentityId: REPORT }, B);

    expect(await idsFor(REPORT)).toEqual(['active', 'provisioning']);
  });

  // The euroid_access_requests_pending gauge, counted at each scrape outside any tenant context
  it('counts the requests waiting for approval in every tenant, nothing that left pending', async () => {
    const statuses: AccessRequestStatus[] = [
      'PENDING_APPROVAL',
      'APPROVED',
      'PROVISIONING',
      'ACTIVE',
      'REJECTED',
      'CANCELLED',
      'EXPIRED',
      'REVOKED',
      // A request whose approval workflow could not be started (it was not in the enum before)
      'FAILED',
    ];
    for (const [i, status] of statuses.entries()) {
      await store(`a-${i}`, { requesterId: REPORT, status });
    }
    await store('b-pending', { requesterId: REPORT, status: 'PENDING_APPROVAL' }, B);

    expect(await query.countPendingInAllTenants()).toBe(2);

    await withTenantContext(A, () =>
      requests.updateOne({ requestId: 'a-0' }, { $set: { status: 'CANCELLED' } }).exec(),
    );
    expect(await query.countPendingInAllTenants()).toBe(1);
  });

  // Hunt 04 F15: the list showed every pending request with a step naming the approver, also
  // one whose own step they had decided while a later step waited; the badge counted only the
  // current step. r2-04 N5: a ROLE step went to the person the access is for too.
  describe('pending approvals: the list and the badge', () => {
    const ANNA = { id: 'id-anna', email: 'anna@a.example' };
    const BEN = { id: 'id-ben', email: 'ben@a.example' };
    const step = (stepOrder: number, who: { id: string; email: string }, status = 'PENDING') => ({
      stepOrder,
      approverType: 'SPECIFIC_USER',
      approverId: who.id,
      approverEmail: who.email,
      status,
    });
    const pending = (requestId: string, steps: unknown[], extra: Record<string, unknown> = {}) =>
      withTenantContext(A, () =>
        requests.create({
          tenantId: A,
          requestId,
          requesterId: 'id-requester',
          requesterEmail: 'requester@a.example',
          entitlements: [
            { catalogEntryId: 'c', system: 'entra-id', entitlementName: 'F', justification: 'x' },
          ],
          status: 'PENDING_APPROVAL',
          approvalSteps: steps as never[],
          ...extra,
        }),
      );
    const listed = async (who: { id: string; email: string }) =>
      (await withTenantContext(A, () => query.listPendingApprovals(who.id, who.email))).map(
        (d) => d.requestId,
      );
    const counted = (who: { id: string; email: string }) =>
      withTenantContext(A, () => query.countPendingApprovals(who.id, who.email));

    beforeEach(async () => {
      // Anna decided step 0; step 1 waits for Ben
      await pending('req-next-step', [step(0, ANNA, 'APPROVED'), step(1, BEN)]);
      // Anna's own step is the current one
      await pending('req-anna-now', [step(0, ANNA), step(1, BEN)]);
      // Anna's step comes after Ben's, which still waits
      await pending('req-anna-later', [step(0, BEN), step(1, ANNA)]);
    });

    it('never shows a ROLE step to the person the access is for, holder of the role or not', async () => {
      const admins = moduleRef.get(getModelToken(AdminUser.name));
      await admins.create({
        email: ANNA.email,
        name: 'Anna',
        authSource: 'saml',
        role: 'policy-admin',
        tenantId: A,
        isActive: true,
      });
      const roleStep = {
        stepOrder: 0,
        approverType: 'ROLE',
        approverId: 'policy-admin',
        approverEmail: 'policy-admin',
        status: 'PENDING',
      };
      await pending('req-role-for-anna', [roleStep], { targetIdentityId: ANNA.id });
      await pending('req-role-for-other', [roleStep], { targetIdentityId: 'id-other' });

      expect(await listed(ANNA)).toEqual(['req-anna-now', 'req-role-for-other']);
      expect(await counted(ANNA)).toBe(2);
      await admins.deleteMany({});
    });

    it('lists only the requests whose current step is the approver’s, as the badge counts', async () => {
      expect(await listed(ANNA)).toEqual(['req-anna-now']);
      expect(await counted(ANNA)).toBe(1);
      expect((await listed(BEN)).sort()).toEqual(['req-anna-later', 'req-next-step']);
      expect(await counted(BEN)).toBe(2);
    });
  });
  // HX-E3: a policy-admin closes a request whose removal keeps failing as removed by hand from its
  // page, so they open any request of the tenant; everyone else only their own or their steps'
  describe('the detail of a request', () => {
    const detail = (anyRequest: boolean, tenantId = A) =>
      withTenantContext(tenantId, () =>
        query.getRequestDetail('req-other', 'id-pat', 'pat@a.example', anyRequest),
      );

    it('opens for a policy-admin (anyRequest) who is neither requester nor approver', async () => {
      await store('req-other', { requesterId: 'id-someone' });

      await expect(detail(true)).resolves.toMatchObject({ requestId: 'req-other' });
      await expect(detail(false)).rejects.toThrow('You can only view your own requests');
    });

    it('stays within the tenant for a policy-admin', async () => {
      await store('req-other', { requesterId: 'id-someone' }, B);

      await expect(detail(true)).rejects.toThrow('Access request not found');
    });
  });

  // HX-E4: no admin view listed the ACTIVE requests past their end date whose removal keeps
  // failing, so a policy-admin needed the request link from elsewhere to close one by hand
  describe('requests whose removal keeps failing', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const past = (days: number) => new Date(Date.now() - days * DAY);
    const REFUSED = 'The removal was refused: entra-id: Graph 403';
    const listed = async (tenantId = A) =>
      withTenantContext(tenantId, () => query.listRemovalFailing({ page: 1, limit: 20 }));

    it('lists ACTIVE requests past their end date with a reason, the oldest end date first', async () => {
      await store('newer', { requesterId: 'x', expiresAt: past(1), statusReason: REFUSED });
      await store('older', { requesterId: 'x', expiresAt: past(5), statusReason: REFUSED });
      await store('by-constraint', {
        requesterId: 'x',
        timeConstraint: { expiresAt: past(3) },
        statusReason: REFUSED,
      });
      // Not failing: no reason, end date not passed, not ACTIVE, another tenant
      await store('no-reason', { requesterId: 'x', expiresAt: past(2) });
      await store('not-ended', {
        requesterId: 'x',
        expiresAt: new Date(Date.now() + DAY),
        statusReason: REFUSED,
      });
      await store('closed', {
        requesterId: 'x',
        status: 'EXPIRED' as AccessRequestStatus,
        expiresAt: past(4),
        statusReason: REFUSED,
      });
      await store(
        'other-tenant',
        { requesterId: 'x', expiresAt: past(2), statusReason: REFUSED },
        B,
      );

      const { data, total } = await listed();

      expect(total).toBe(3);
      expect(data.map((r) => r.requestId).sort()).toEqual(['by-constraint', 'newer', 'older']);
      const order = data.map((r) => r.requestId);
      expect(order.indexOf('older')).toBeLessThan(order.indexOf('newer'));
      expect(data.find((r) => r.requestId === 'older')?.statusReason).toBe(REFUSED);
    });
  });
});
