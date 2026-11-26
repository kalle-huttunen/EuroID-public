/**
 * SoD for access requests (in-memory MongoDB, tenant plugin, the real SodService): a request is
 * checked against the access the person holds now, birthright access from role-based rules (with
 * directory roles and entitlements that go to a linked admin account) and access from earlier
 * requests still in force; and again when the last approval comes in, before fulfilment, against
 * what is granted at that moment, so two pending requests for the two sides of a Block policy
 * cannot both be fulfilled.
 */
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
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
  AccessRequestStatus,
} from './schemas/access-request.schema';
import { SodPolicy, SodPolicySchema, SodPolicyDocument } from '../policy/schemas/sod-policy.schema';
import { SodService } from '../policy/sod.service';
import { PolicyEngineService } from '../policy/policy-engine.service';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { AccessRequestSodService } from './access-request-sod.service';
import { AccessRequestCreationService } from './access-request-creation.service';
import { catalogTargetLookup } from '../entitlement-catalog/catalog-target-lookup';
import { PROVISIONING_STALE_AFTER_MS } from './held-requests';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';
const PERSON = 'id-person';
const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';

type Ent = {
  system: string;
  nativeId: string;
  entitlementType: 'Group' | 'License' | 'DirectoryRole';
};
const group = (nativeId: string): Ent => ({
  system: 'entra-id',
  nativeId,
  entitlementType: 'Group',
});
const directoryRole = (nativeId: string): Ent => ({
  system: 'entra-id',
  nativeId,
  entitlementType: 'DirectoryRole',
});

/**
 * The catalog the SoD check resolves entitlement ids through (EntitlementCatalogService
 * loadTargetLookup): a discovered Entra group has a GUID as its native id and its display name as
 * its name. Requests carry the native id; a rule or an SoD policy may name either.
 */
const CATALOG_TARGETS = [
  { system: 'entra-id', nativeId: '0b5e7c1a-payables', name: 'Payables' },
  { system: 'entra-id', nativeId: '6d2f9e4b-approvers', name: 'Approvers' },
];

/** Catalog entries the request form offers, by catalogEntryId. */
const CATALOG: Record<string, Ent & { name: string }> = {
  'cat-payables': { ...group('Payables'), name: 'Payables' },
  'cat-approvers': { ...group('Approvers'), name: 'Approvers' },
  'cat-auditors': { ...group('Auditors'), name: 'Auditors' },
  'cat-global-admin': { ...directoryRole(GLOBAL_ADMIN), name: 'Global Administrator' },
  'cat-ad-vpn': {
    system: 'ad',
    nativeId: 'CN=GG-VPN,OU=Groups,DC=corp',
    entitlementType: 'Group',
    name: 'GG-VPN',
  },
};

/**
 * The person as IdentityService.findPolicyProfileById answers: the profile onboarding and the
 * mover evaluate (buildProfileWithContractsForPolicy), every profile field and the HR contracts.
 */
const policyProfile = (id: string) => ({
  _id: id,
  tenantId: A,
  firstName: 'Pia',
  lastName: 'Person',
  email: `${id}@a.example`,
  departmentName: 'Finance',
  departmentCode: 'FIN',
  costCenter: 'CC-100',
  division: 'Corporate',
  countryCode: 'FI',
  customAttributes: { score: 7 },
  contracts: [
    { id: 'c-1', title: 'Clerk', department: 'Finance', isPrimary: true, status: 'ACTIVE' },
  ],
});

describe('Access requests: SoD against the access held now (MongoDB)', () => {
  let moduleRef: TestingModule;
  let sod: AccessRequestSodService;
  let creation: AccessRequestCreationService;
  let requests: Model<AccessRequestDocument>;
  let policies: Model<SodPolicyDocument>;
  let birthright: Array<Record<string, unknown>>;
  let adminBirthright: Array<Record<string, unknown>>;
  const evaluateOperationsWithoutSod = jest.fn(
    async (_user: unknown, _tenantId?: string, options?: { includeAdminOperations?: boolean }) =>
      options?.includeAdminOperations ? [...birthright, ...adminBirthright] : birthright,
  );
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
        { provide: PolicyEngineService, useValue: { evaluateOperationsWithoutSod } },
        {
          provide: IDENTITY_QUERY_PORT,
          useValue: {
            // As IdentityService answers: the profile flattened, with _id and tenantId
            findById: jest.fn(async (id: string) => ({
              _id: id,
              tenantId: A,
              email: `${id}@a.example`,
              departmentName: 'Finance',
              managerEmail: 'manager@a.example',
            })),
            findPolicyProfileById: jest.fn(async (id: string) => policyProfile(id)),
            findByEmail: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: EntitlementCatalogService,
          useValue: {
            loadTargetLookup: jest.fn(async () => catalogTargetLookup(CATALOG_TARGETS)),
            findCatalogEntryById: jest.fn(async (_tenantId: string, id: string) => {
              const e = CATALOG[id];
              return (
                e && {
                  system: e.system,
                  name: e.name,
                  nativeId: e.nativeId,
                  type: e.entitlementType,
                  owner: 'owner@a.example',
                  requestable: true,
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
    sod = moduleRef.get(AccessRequestSodService);
    creation = moduleRef.get(AccessRequestCreationService);
    requests = moduleRef.get(getModelToken(AccessRequest.name));
    policies = moduleRef.get(getModelToken(SodPolicy.name));
  });

  beforeEach(async () => {
    birthright = [];
    adminBirthright = [];
    evaluateOperationsWithoutSod.mockClear();
    workflowStart.mockReset();
    await requests.deleteMany({}).setOptions({ skipTenantScope: true });
    await policies.deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const inA = <T>(fn: () => Promise<T>) => withTenantContext(A, fn) as Promise<T>;

  const blockPolicy = (
    name: string,
    refs: Array<{ type: string; targetId: string }>,
    action = 'BLOCK',
  ) =>
    inA(() =>
      policies.create({
        tenantId: A,
        name,
        severity: 'HIGH',
        action,
        isActive: true,
        conflictingEntitlements: refs.map((r) => ({ system: 'entra-id', ...r })),
      }),
    );

  const storedRequest = (
    requestId: string,
    status: AccessRequestStatus,
    entitlements: Ent[],
    extra: Record<string, unknown> = {},
  ) =>
    inA(() =>
      requests.create({
        tenantId: A,
        requestId,
        requesterId: PERSON,
        requesterEmail: 'person@a.example',
        targetIdentityId: PERSON,
        entitlements: entitlements.map((e) => ({
          ...e,
          catalogEntryId: `cat-${e.nativeId}`,
          entitlementName: e.nativeId,
          justification: 'needed for quarter close',
        })),
        status,
        approvalSteps: [],
        ...extra,
      }),
    );

  const blockersOf = async (entitlements: Ent[], excludeRequestId?: string) =>
    (await inA(() => sod.check(A, PERSON, entitlements, excludeRequestId))).blockers.map(
      (v) => v.policyName,
    );

  describe('at request time', () => {
    beforeEach(async () => {
      await blockPolicy('Payments vs approvals', [
        { type: 'group', targetId: 'Payables' },
        { type: 'group', targetId: 'Approvers' },
      ]);
    });

    it('counts access from an earlier request still in force', async () => {
      await storedRequest('req-a', 'ACTIVE', [group('Payables')]);

      expect(await blockersOf([group('Approvers')])).toEqual(['Payments vs approvals']);
    });

    it('counts access being fulfilled', async () => {
      await storedRequest('req-a', 'PROVISIONING', [group('Payables')]);

      expect(await blockersOf([group('Approvers')])).toEqual(['Payments vs approvals']);
    });

    // Final review AG5: a run lost after the claim leaves the request PROVISIONING for good
    it('does not count a request PROVISIONING for longer than PROVISIONING_STALE_AFTER_MS', async () => {
      await storedRequest('req-a', 'PROVISIONING', [group('Payables')]);
      await requests.collection.updateOne(
        { requestId: 'req-a' },
        { $set: { updatedAt: new Date(Date.now() - PROVISIONING_STALE_AFTER_MS - 60_000) } },
      );

      expect(await blockersOf([group('Approvers')])).toEqual([]);
    });

    it.each<[string, AccessRequestStatus, Record<string, unknown>]>([
      ['revoked', 'REVOKED', {}],
      ['expired', 'EXPIRED', {}],
      ['rejected', 'REJECTED', {}],
      ['cancelled', 'CANCELLED', {}],
      ['still pending', 'PENDING_APPROVAL', {}],
      ['active past its expiry', 'ACTIVE', { expiresAt: new Date(Date.now() - 60_000) }],
    ])('does not count access from a request that is %s', async (_label, status, extra) => {
      await storedRequest('req-a', status, [group('Payables')], extra);

      expect(await blockersOf([group('Approvers')])).toEqual([]);
    });

    it('does not count another person’s requests or another tenant’s', async () => {
      await inA(() =>
        requests.create({
          tenantId: A,
          requestId: 'req-other-person',
          requesterId: 'id-manager',
          requesterEmail: 'manager@a.example',
          targetIdentityId: 'id-report',
          entitlements: [
            { ...group('Payables'), catalogEntryId: 'c', entitlementName: 'P', justification: 'x' },
          ],
          status: 'ACTIVE',
        }),
      );
      await withTenantContext(B, () =>
        requests.create({
          tenantId: B,
          requestId: 'req-other-tenant',
          requesterId: PERSON,
          requesterEmail: 'person@b.example',
          targetIdentityId: PERSON,
          entitlements: [
            { ...group('Payables'), catalogEntryId: 'c', entitlementName: 'P', justification: 'x' },
          ],
          status: 'ACTIVE',
        }),
      );

      expect(await blockersOf([group('Approvers')])).toEqual([]);
    });

    it('createRequest refuses side B when an earlier request gave side A, storing nothing', async () => {
      await storedRequest('req-a', 'ACTIVE', [group('Payables')]);

      const error = await inA(() =>
        creation.createRequest(
          {
            entitlements: [{ catalogEntryId: 'cat-approvers', justification: 'needed for audits' }],
          },
          PERSON,
          'person@a.example',
        ),
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        sodViolations: [{ policyName: 'Payments vs approvals', severity: 'HIGH' }],
      });
      expect(
        await requests
          .countDocuments({ requestId: { $ne: 'req-a' } })
          .setOptions({ skipTenantScope: true }),
      ).toBe(0);
      expect(workflowStart).not.toHaveBeenCalled();
    });

    it('createRequest stores a Warn match with its action, for the reviewer', async () => {
      await blockPolicy(
        'Auditor also approving',
        [
          { type: 'group', targetId: 'Auditors' },
          { type: 'group', targetId: 'Approvers' },
        ],
        'WARN',
      );
      await storedRequest('req-a', 'ACTIVE', [group('Auditors')]);

      const doc = await inA(() =>
        creation.createRequest(
          {
            entitlements: [{ catalogEntryId: 'cat-approvers', justification: 'needed for audits' }],
          },
          PERSON,
          'person@a.example',
        ),
      );

      expect(doc.toObject().sodCheckResult).toMatchObject({
        passed: true,
        violations: [
          {
            policyName: 'Auditor also approving',
            severity: 'HIGH',
            action: 'WARN',
            conflictingEntitlements: ['entra-id:Auditors', 'entra-id:Approvers'],
          },
        ],
      });
    });
  });

  // Hunt 04 F2: the person was handed to the policy engine with only a few profile fields
  // (`department`, no departmentName or departmentCode, no cost center, division, country, custom
  // attributes or contracts), so a rule on any of those gave no birthright access to the check.
  describe('birthright access from the person’s attributes', () => {
    beforeEach(async () => {
      await blockPolicy('Payments vs approvals', [
        { type: 'group', targetId: 'Payables' },
        { type: 'group', targetId: 'Approvers' },
      ]);
    });

    it('evaluates the rules on the profile onboarding evaluates, contracts included', async () => {
      await blockersOf([group('Approvers')]);

      const user = evaluateOperationsWithoutSod.mock.calls[0][0] as Record<string, unknown>;
      expect(user).toMatchObject({
        tenantId: A,
        email: `${PERSON}@a.example`,
        departmentName: 'Finance',
        departmentCode: 'FIN',
        costCenter: 'CC-100',
        division: 'Corporate',
        countryCode: 'FI',
        customAttributes: { score: 7 },
        contracts: [expect.objectContaining({ department: 'Finance', isPrimary: true })],
      });
    });

    it('a department rule’s group counts against the requested side', async () => {
      // A rule "department is Finance gives Payables", as the engine's department accessor
      // reads it (departmentName, else departmentCode)
      evaluateOperationsWithoutSod.mockImplementationOnce(async (user: unknown) => {
        const u = user as { departmentName?: string; departmentCode?: string };
        return (u.departmentName ?? u.departmentCode) === 'Finance'
          ? [{ type: 'group', action: 'add', target: 'entra-id', targetId: 'Payables' }]
          : [];
      });

      expect(await blockersOf([group('Approvers')])).toEqual(['Payments vs approvals']);
    });
  });

  // Hunt 04 F8: a conflict the person already holds (from rules or other requests) is not
  // caused by an unrelated request. The request check is preventive: it refuses what the request
  // would add to a conflict; a conflict already held is for detective controls (the access
  // graph's SoD view, access reviews), not a reason to refuse every other request.
  describe('a conflict the person already holds', () => {
    beforeEach(async () => {
      await blockPolicy('Payments vs approvals', [
        { type: 'group', targetId: 'Payables' },
        { type: 'group', targetId: 'Approvers' },
      ]);
      birthright = [{ type: 'group', action: 'add', target: 'entra-id', targetId: 'Payables' }];
      await storedRequest('req-a', 'ACTIVE', [group('Approvers')]);
    });

    it('does not refuse a request for an unrelated entitlement', async () => {
      expect(await blockersOf([group('Auditors')])).toEqual([]);
    });

    it('still refuses a request for one of the conflicting entitlements', async () => {
      await requests.deleteMany({ requestId: 'req-a' }).setOptions({ skipTenantScope: true });

      expect(await blockersOf([group('Approvers')])).toEqual(['Payments vs approvals']);
    });

    it('fulfils a pending unrelated request at the re-check', async () => {
      await storedRequest('req-c', 'PENDING_APPROVAL', [group('Auditors')]);

      expect(await inA(() => sod.claimForProvisioning(A, 'req-c'))).toEqual({ passed: true });
    });
  });

  // r2-04 N1: a rule names a group by display name (params.groupName), a request by its catalog
  // native id, and an SoD policy by either; the check compared the ids exactly, so the policy
  // never matched across the two forms.
  describe('an entitlement named by display name on one side and native id on the other', () => {
    const PAYABLES_ID = '0b5e7c1a-payables';
    const APPROVERS_ID = '6d2f9e4b-approvers';

    it('a rule naming the group counts against a policy naming its native id', async () => {
      await blockPolicy('Payments vs approvals', [
        { type: 'group', targetId: PAYABLES_ID },
        { type: 'group', targetId: APPROVERS_ID },
      ]);
      birthright = [{ type: 'group', action: 'add', target: 'entra-id', targetId: 'Payables' }];

      expect(await blockersOf([group(APPROVERS_ID)])).toEqual(['Payments vs approvals']);
    });

    it('a requested native id matches a policy naming the group', async () => {
      await blockPolicy('Payments vs approvals', [
        { type: 'group', targetId: 'Payables' },
        { type: 'group', targetId: 'Approvers' },
      ]);
      await storedRequest('req-a', 'ACTIVE', [group(PAYABLES_ID)]);

      expect(await blockersOf([group(APPROVERS_ID)])).toEqual(['Payments vs approvals']);
    });

    it('a name the catalog does not know still matches only itself', async () => {
      await blockPolicy('Payments vs approvals', [
        { type: 'group', targetId: 'Payables' },
        { type: 'group', targetId: 'Approvers' },
      ]);
      birthright = [{ type: 'group', action: 'add', target: 'entra-id', targetId: 'Payroll' }];

      expect(await blockersOf([group(APPROVERS_ID)])).toEqual([]);
    });
  });

  // Hunt 04 F4: revoking an expired request removed its entitlements even when a rule or another
  // request in force still granted them (AccessRequestActivities.revokeAccessRequest)
  describe('entitlements a request shares with other access (grantedElsewhere)', () => {
    const PAYABLES_ID = '0b5e7c1a-payables';
    const APPROVERS_ID = '6d2f9e4b-approvers';
    const sharedWith = (entitlements: Ent[]) =>
      inA(() => sod.grantedElsewhere(A, PERSON, 'req-own', entitlements));

    it('names an entitlement a rule grants, by display name or native id', async () => {
      birthright = [{ type: 'group', action: 'add', target: 'entra-id', targetId: 'Payables' }];

      expect(await sharedWith([group(PAYABLES_ID), group(APPROVERS_ID)])).toEqual([
        group(PAYABLES_ID),
      ]);
    });

    it('names an entitlement another request in force grants, never the request itself', async () => {
      await storedRequest('req-own', 'ACTIVE', [group(APPROVERS_ID), group(PAYABLES_ID)]);
      await storedRequest('req-other', 'ACTIVE', [group(APPROVERS_ID)]);
      await storedRequest('req-old', 'EXPIRED', [group(PAYABLES_ID)]);

      expect(await sharedWith([group(APPROVERS_ID), group(PAYABLES_ID)])).toEqual([
        group(APPROVERS_ID),
      ]);
    });

    it('does not name an entitlement of a stale PROVISIONING request', async () => {
      await storedRequest('req-own', 'ACTIVE', [group(APPROVERS_ID)]);
      await storedRequest('req-stuck', 'PROVISIONING', [group(APPROVERS_ID)]);
      await requests.collection.updateOne(
        { requestId: 'req-stuck' },
        { $set: { updatedAt: new Date(Date.now() - PROVISIONING_STALE_AFTER_MS - 60_000) } },
      );

      expect(await sharedWith([group(APPROVERS_ID)])).toEqual([]);
    });

    it('does not confuse a group with a directory role of the same id', async () => {
      birthright = [{ type: 'role', action: 'add', target: 'entra-id', targetId: GLOBAL_ADMIN }];

      expect(await sharedWith([group(GLOBAL_ADMIN)])).toEqual([]);
      expect(await sharedWith([directoryRole(GLOBAL_ADMIN)])).toEqual([
        directoryRole(GLOBAL_ADMIN),
      ]);
    });

    // Final review AG2: the revoke removes access from the person's own account only, so access a
    // rule gives the linked admin account does not keep it there
    it('does not name an entitlement a rule gives only the linked admin account', async () => {
      adminBirthright = [
        {
          type: 'group',
          action: 'add',
          target: 'entra-id',
          targetId: 'Payables',
          adminTier: 'TIER_0',
        },
      ];

      expect(await sharedWith([group(PAYABLES_ID)])).toEqual([]);
      expect(evaluateOperationsWithoutSod).toHaveBeenCalled();
    });
  });

  describe('directory roles and admin-account access', () => {
    beforeEach(async () => {
      await blockPolicy('No admin approving payments', [
        { type: 'role', targetId: GLOBAL_ADMIN },
        { type: 'group', targetId: 'Payables' },
      ]);
    });

    it('a requested directory role matches the role the policy names', async () => {
      birthright = [{ type: 'group', action: 'add', target: 'entra-id', targetId: 'Payables' }];

      expect(await blockersOf([directoryRole(GLOBAL_ADMIN)])).toEqual([
        'No admin approving payments',
      ]);
    });

    it('a birthright directory role counts against a requested group', async () => {
      birthright = [{ type: 'role', action: 'add', target: 'entra-id', targetId: GLOBAL_ADMIN }];

      expect(await blockersOf([group('Payables')])).toEqual(['No admin approving payments']);
    });

    it('a directory role from an earlier request counts, also under a policy stored as `directoryrole`', async () => {
      await policies.deleteMany({}).setOptions({ skipTenantScope: true });
      await blockPolicy('No admin approving payments', [
        { type: 'directoryrole', targetId: GLOBAL_ADMIN },
        { type: 'group', targetId: 'Payables' },
      ]);
      await storedRequest('req-a', 'ACTIVE', [directoryRole(GLOBAL_ADMIN)]);

      expect(await blockersOf([group('Payables')])).toEqual(['No admin approving payments']);
    });

    it('birthright access that goes to the linked admin account counts', async () => {
      adminBirthright = [
        {
          type: 'role',
          action: 'add',
          target: 'entra-id',
          targetId: GLOBAL_ADMIN,
          adminTier: 'TIER_0',
        },
      ];

      expect(await blockersOf([group('Payables')])).toEqual(['No admin approving payments']);
    });
  });

  describe('when the last approval comes in (claimForProvisioning)', () => {
    beforeEach(async () => {
      await blockPolicy('Payments vs approvals', [
        { type: 'group', targetId: 'Payables' },
        { type: 'group', targetId: 'Approvers' },
      ]);
      // Both passed the check at request time: neither side was granted then
      await storedRequest('req-a', 'PENDING_APPROVAL', [group('Payables')]);
      await storedRequest('req-b', 'PENDING_APPROVAL', [group('Approvers')]);
    });

    const stored = (requestId: string) =>
      requests.findOne({ requestId }).setOptions({ skipTenantScope: true }).lean();

    it('fulfils the first and rejects the second with the conflict', async () => {
      expect(await inA(() => sod.claimForProvisioning(A, 'req-a'))).toEqual({ passed: true });
      expect((await stored('req-a'))?.status).toBe('PROVISIONING');

      expect(await inA(() => sod.claimForProvisioning(A, 'req-b'))).toEqual({ passed: false });
      const rejected = await stored('req-b');
      expect(rejected?.status).toBe('REJECTED');
      expect(rejected?.sodCheckResult).toMatchObject({
        passed: false,
        violations: [
          {
            policyName: 'Payments vs approvals',
            severity: 'HIGH',
            action: 'BLOCK',
            conflictingEntitlements: ['entra-id:Payables', 'entra-id:Approvers'],
          },
        ],
      });
    });

    it('never fulfils both when the two approvals come in at once', async () => {
      const results = await inA(() =>
        Promise.all([sod.claimForProvisioning(A, 'req-a'), sod.claimForProvisioning(A, 'req-b')]),
      );

      expect(results.filter((r) => r.passed).length).toBeLessThanOrEqual(1);
      const statuses = [(await stored('req-a'))?.status, (await stored('req-b'))?.status];
      expect(statuses.filter((s) => s === 'PROVISIONING').length).toBeLessThanOrEqual(1);
    });

    it('a request an earlier attempt rejected stays rejected', async () => {
      await requests
        .updateOne({ requestId: 'req-b' }, { $set: { status: 'REJECTED' } })
        .setOptions({ skipTenantScope: true });

      expect(await inA(() => sod.claimForProvisioning(A, 'req-b'))).toEqual({ passed: false });
      expect((await stored('req-b'))?.status).toBe('REJECTED');
    });

    // Hunt 04 F5: the claim set PROVISIONING on any request not REJECTED, a cancelled one too
    it('never claims a request the requester cancelled', async () => {
      await requests
        .updateOne({ requestId: 'req-b' }, { $set: { status: 'CANCELLED' } })
        .setOptions({ skipTenantScope: true });

      expect(await inA(() => sod.claimForProvisioning(A, 'req-b'))).toEqual({ passed: false });
      expect((await stored('req-b'))?.status).toBe('CANCELLED');
    });

    it('claims again on a retried attempt that already marked it PROVISIONING', async () => {
      await requests
        .updateOne({ requestId: 'req-a' }, { $set: { status: 'PROVISIONING' } })
        .setOptions({ skipTenantScope: true });

      expect(await inA(() => sod.claimForProvisioning(A, 'req-a'))).toEqual({ passed: true });
    });

    it('fulfils a request whose conflict is gone', async () => {
      await requests
        .updateOne({ requestId: 'req-a' }, { $set: { status: 'REVOKED' } })
        .setOptions({ skipTenantScope: true });

      expect(await inA(() => sod.claimForProvisioning(A, 'req-b'))).toEqual({ passed: true });
      expect((await stored('req-b'))?.status).toBe('PROVISIONING');
    });
  });

  // Hunt 04 F4: fulfilment grants Entra ID entitlements only; another system's request was
  // approved and ended ACTIVE with nothing granted
  it('refuses a request for an entitlement of a system access requests cannot fulfil', async () => {
    const error = await inA(() =>
      creation.createRequest(
        { entitlements: [{ catalogEntryId: 'cat-ad-vpn', justification: 'remote work setup' }] },
        PERSON,
        'person@a.example',
      ),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toMatch(/GG-VPN.*ad.*Entra ID/);
    expect(await requests.countDocuments({}).setOptions({ skipTenantScope: true })).toBe(0);
    expect(workflowStart).not.toHaveBeenCalled();
  });

  // access_request.created reaches the audit log, the tenant websocket and webhooks
  describe('the access_request.created event', () => {
    it.each([
      ['by identity id', PERSON, 'person@a.example', { requesterId: PERSON }],
      // A requester without an identity is known by their email: no requesterId then. Such a
      // requester asks for someone else (their report: the stubbed identities' manager)
      ['known only by email', 'manager@a.example', 'manager@a.example', {}],
    ])('names a requester %s, never by the address', async (_label, requesterId, email, who) => {
      const emit = moduleRef.get(DomainEventEmitterService).emit as unknown as jest.Mock;
      emit.mockClear();

      const doc = await inA(() =>
        creation.createRequest(
          {
            entitlements: [{ catalogEntryId: 'cat-payables', justification: 'quarter close' }],
            ...(requesterId === email ? { targetIdentityId: PERSON } : {}),
          },
          requesterId,
          email,
        ),
      );

      expect(emit).toHaveBeenCalledWith('access_request.created', doc.requestId, {
        requestId: doc.requestId,
        ...who,
        status: 'PENDING_APPROVAL',
      });
      expect(JSON.stringify(emit.mock.calls)).not.toContain('@a.example');
    });
  });
});
