/**
 * Who approves an access request (in-memory MongoDB, tenant plugin, the real
 * AccessRequestCreationService and SodService; identities and the catalog are stubs).
 *
 * Hunt 04 F9: only the target's manager may request on their behalf, and that manager is the
 * MANAGER step's approver, while the self-approval guard refuses the requester: the step could
 * never be decided and the request timed out REJECTED after 7 days. A MANAGER step without a
 * manager, or an OWNER step whose entry has no owner, was created with no approver and timed out
 * the same way. The OWNER step went to the first entry's owner only, and the longest catalog
 * chain replaced the others. r2-04 N5: the person the access is for could approve it.
 *
 * Now: a step whose approver is the requester is approved by the request itself (the requester
 * asked for it); every other step needs an approver who is neither the requester nor the person
 * the access is for, and at least one such step must remain. A step with no approver refuses the
 * request at once (400, nothing stored). Each entry's owner approves, and every entry's chain
 * counts.
 */
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { accessRequestsConfig } from '@infrastructure/config/access-requests.config';
import { IDENTITY_QUERY_PORT } from '@shared/interfaces/identity-query.port';
import {
  AccessRequest,
  AccessRequestSchema,
  AccessRequestDocument,
} from './schemas/access-request.schema';
import { SodPolicy, SodPolicySchema } from '../policy/schemas/sod-policy.schema';
import { SodService } from '../policy/sod.service';
import { PolicyEngineService } from '../policy/policy-engine.service';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { AccessRequestSodService } from './access-request-sod.service';
import { AccessRequestCreationService } from './access-request-creation.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';

/** The directory: a manager, their report, a report without a manager, and two owners. */
const PEOPLE: Record<string, { email: string; managerEmail?: string }> = {
  'id-manager': { email: 'mia.manager@a.example' },
  'id-report': { email: 'rob.report@a.example', managerEmail: 'mia.manager@a.example' },
  'id-orphan': { email: 'oona.nomanager@a.example' },
  'id-owner-fin': { email: 'fin.owner@a.example' },
  'id-owner-it': { email: 'it.owner@a.example' },
};
const idOf = (email: string) =>
  Object.entries(PEOPLE).find(([, p]) => p.email === email.toLowerCase())?.[0];

type Entry = {
  name: string;
  owner?: string;
  approvalChain?: Array<{ type: string; value?: string }>;
};
const CATALOG: Record<string, Entry> = {
  'cat-payables': { name: 'Payables', owner: 'fin.owner@a.example' },
  'cat-servers': { name: 'Server admins', owner: 'it.owner@a.example' },
  'cat-no-owner': { name: 'Orphan group' },
  'cat-mia-owns': { name: 'Team Mia', owner: 'mia.manager@a.example' },
  'cat-rob-owns': { name: 'Team Rob', owner: 'rob.report@a.example' },
  'cat-role-chain': {
    name: 'Audit log readers',
    owner: 'it.owner@a.example',
    approvalChain: [{ type: 'ROLE', value: 'policy-admin' }],
  },
};

describe('Access requests: who approves (MongoDB)', () => {
  let moduleRef: TestingModule;
  let creation: AccessRequestCreationService;
  let requests: Model<AccessRequestDocument>;
  const workflowStart = jest.fn();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: AccessRequest.name, schema: AccessRequestSchema },
          { name: SodPolicy.name, schema: SodPolicySchema },
        ]),
      ],
      providers: [
        AccessRequestSodService,
        AccessRequestCreationService,
        SodService,
        { provide: DomainEventEmitterService, useValue: { emit: jest.fn() } },
        {
          provide: PolicyEngineService,
          useValue: { evaluateOperationsWithoutSod: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: IDENTITY_QUERY_PORT,
          useValue: {
            findById: jest.fn(async (id: string) =>
              PEOPLE[id] ? { _id: id, tenantId: A, ...PEOPLE[id] } : null,
            ),
            findPolicyProfileById: jest.fn(async (id: string) =>
              PEOPLE[id] ? { _id: id, tenantId: A, ...PEOPLE[id] } : null,
            ),
            findByEmail: jest.fn(async (email: string) => {
              const id = idOf(email);
              return id ? { _id: id, tenantId: A, ...PEOPLE[id] } : null;
            }),
          },
        },
        {
          provide: EntitlementCatalogService,
          useValue: {
            loadTargetLookup: jest.fn(async () => () => undefined),
            findCatalogEntryById: jest.fn(async (_tenantId: string, id: string) => {
              const e = CATALOG[id];
              return (
                e && {
                  system: 'entra-id',
                  nativeId: `native-${id}`,
                  type: 'Group',
                  requestable: true,
                  ...e,
                }
              );
            }),
          },
        },
        {
          provide: TemporalClientProvider,
          useValue: { getClient: () => ({ workflow: { start: workflowStart } }) },
        },
        { provide: accessRequestsConfig.KEY, useValue: { approvalTimeoutDays: 7 } },
      ],
    }).compile();
    creation = moduleRef.get(AccessRequestCreationService);
    requests = moduleRef.get(getModelToken(AccessRequest.name));
  });

  beforeEach(async () => {
    workflowStart.mockReset();
    await requests.deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const request = (requesterId: string, catalogEntryIds: string[], targetIdentityId?: string) =>
    withTenantContext(A, async () =>
      creation.createRequest(
        {
          entitlements: catalogEntryIds.map((catalogEntryId) => ({
            catalogEntryId,
            justification: 'needed for the quarter close',
          })),
          ...(targetIdentityId ? { targetIdentityId } : {}),
        },
        requesterId,
        PEOPLE[requesterId]?.email ?? requesterId,
      ),
    );

  const steps = async (requesterId: string, ids: string[], target?: string) =>
    (await request(requesterId, ids, target)).toObject().approvalSteps.map((s) => ({
      type: s.approverType,
      approver: s.approverEmail,
      status: s.status,
      ...(s.status === 'APPROVED' ? { decidedBy: s.decidedBy } : {}),
    }));

  const refusal = async (requesterId: string, ids: string[], target?: string) => {
    const error = await Promise.resolve(request(requesterId, ids, target)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(await requests.countDocuments({}).setOptions({ skipTenantScope: true })).toBe(0);
    expect(workflowStart).not.toHaveBeenCalled();
    return (error as BadRequestException).message;
  };

  it('a self-request goes to the manager, then the owner', async () => {
    expect(await steps('id-report', ['cat-payables'])).toEqual([
      { type: 'MANAGER', approver: 'mia.manager@a.example', status: 'PENDING' },
      { type: 'OWNER', approver: 'fin.owner@a.example', status: 'PENDING' },
    ]);
  });

  it('a manager’s request for a report counts as the manager’s approval; the owner decides', async () => {
    expect(await steps('id-manager', ['cat-payables'], 'id-report')).toEqual([
      {
        type: 'MANAGER',
        approver: 'mia.manager@a.example',
        status: 'APPROVED',
        decidedBy: 'mia.manager@a.example',
      },
      { type: 'OWNER', approver: 'fin.owner@a.example', status: 'PENDING' },
    ]);
  });

  it('every entry’s owner approves, each once', async () => {
    expect(await steps('id-report', ['cat-payables', 'cat-servers', 'cat-payables'])).toEqual([
      { type: 'MANAGER', approver: 'mia.manager@a.example', status: 'PENDING' },
      { type: 'OWNER', approver: 'fin.owner@a.example', status: 'PENDING' },
      { type: 'OWNER', approver: 'it.owner@a.example', status: 'PENDING' },
    ]);
  });

  it('every entry’s chain counts: one entry’s own chain does not replace the default', async () => {
    expect(await steps('id-report', ['cat-payables', 'cat-role-chain'])).toEqual([
      { type: 'MANAGER', approver: 'mia.manager@a.example', status: 'PENDING' },
      { type: 'OWNER', approver: 'fin.owner@a.example', status: 'PENDING' },
      { type: 'ROLE', approver: 'policy-admin', status: 'PENDING' },
    ]);
  });

  it('refuses a request for a person without a manager', async () => {
    expect(await refusal('id-orphan', ['cat-payables'])).toMatch(/MANAGER.*no manager/);
  });

  it('refuses a request for an entitlement without an owner', async () => {
    expect(await refusal('id-report', ['cat-no-owner'])).toMatch(/OWNER.*Orphan group.*no owner/);
  });

  it('refuses when the person the access is for would approve it', async () => {
    expect(await refusal('id-manager', ['cat-rob-owns'], 'id-report')).toMatch(
      /person the access is for/,
    );
  });

  it('refuses when nobody but the requester would approve it', async () => {
    expect(await refusal('id-manager', ['cat-mia-owns'], 'id-report')).toMatch(
      /approver other than you/,
    );
  });

  // Hunt 04 F16: a requester without an identity is known by their email, and a request for
  // themselves looked the email up as an identity id (a cast error answered "Invalid ID format")
  it('refuses a self-request of a requester who has no identity, naming what to do', async () => {
    expect(await refusal('admin@a.example', ['cat-payables'])).toMatch(
      /no identity.*targetIdentityId/,
    );
  });
});
