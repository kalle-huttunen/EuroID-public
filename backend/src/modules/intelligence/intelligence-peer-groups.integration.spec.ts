/**
 * Peer groups on in-memory MongoDB (tenant plugin), with the real models and a mocked policy
 * engine: buildPeerGroups, the unusual-request check and the recommendations.
 *
 * FOLLOWUPS 2026-11-24 (intelligence.service.ts:308): a group's baseline is the access its members
 * hold, as the identity page calls it Active: policy grants on a target where the member's account
 * is SYNCED, and the entitlements of the member's ACTIVE access requests. An entitlement most peers
 * got by request is usual for the group, and the recommendations say how peers hold each one and
 * whether it can be requested.
 *
 * FOLLOWUPS 2026-11-24 (intelligence.service.ts:293 and :413): a build removes the groups it did
 * not write (below the minimum size, or gone), so a mover is found in the group they are in now.
 *
 * FOLLOWUPS 2026-11-25 (held-access.service.ts:117): a rule-given entitlement is named by the
 * catalog's native id, as the request form's check and request-granted access name it, so a group
 * most peers get from a rule that names it by display name is not CRITICAL to request.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { intelligenceConfig } from '@infrastructure/config/intelligence.config';
import { IntelligenceService } from './intelligence.service';
import { HeldAccessService } from './held-access.service';
import { PeerGroup, PeerGroupSchema, type PeerGroupDocument } from './schemas/peer-group.schema';
import {
  ReviewerQualityScore,
  ReviewerQualityScoreSchema,
} from './schemas/reviewer-quality-score.schema';
import { ReviewItem, ReviewItemSchema } from '../access-review/schemas/review-item.schema';
import {
  ReviewCampaign,
  ReviewCampaignSchema,
} from '../access-review/schemas/review-campaign.schema';
import {
  Identity,
  IdentitySchema,
  type IdentityDocument,
} from '../identity/schemas/identity.schema';
import {
  AccessRequest,
  AccessRequestSchema,
  type AccessRequestDocument,
  type AccessRequestStatus,
} from '../access-requests/schemas/access-request.schema';
import {
  EntitlementCatalog,
  EntitlementCatalogSchema,
  type EntitlementCatalogDocument,
} from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import { IdentityService } from '../identity/identity.service';
import { PolicyEngineService } from '../policy/policy-engine.service';

mongoose.plugin(tenantPlugin);

const T = 'tenant-intel';
const OTHER = 'tenant-other';

const config = {
  rubberStampThresholdMs: 30000,
  bulkApproveWindowCount: 10,
  peerGroupMinSize: 3,
  outlierHoldRate: 0.2,
  missingBaselineRate: 0.8,
  recommendationHoldRate: 0.7,
  unusualRequestThreshold: 0.05,
  recommendationMax: 10,
};

/** The role-based rules: Finance gets a license and a group in Entra ID. */
const rulesFor = (profile: { departmentName?: string }) =>
  profile.departmentName === 'Finance'
    ? [
        {
          action: 'add',
          type: 'license',
          target: 'entra-id',
          targetId: 'E3',
          sourcePolicy: 'Finance',
        },
        {
          action: 'add',
          type: 'group',
          target: 'entra-id',
          targetId: 'grp-finance',
          sourcePolicy: 'Finance',
        },
        { action: 'update', type: 'attribute', target: 'entra-id', targetId: 'department' },
      ]
    : profile.departmentName === 'Sales'
      ? SALES_RULES
      : [];

/**
 * Sales gets three Entra ID groups: one named by its display name, one by its native id, and one
 * by a display name two catalog entries have.
 */
const SALES_RULES = ['SG-Sales', 'guid-crm', 'SG-Shared'].map((targetId) => ({
  action: 'add',
  type: 'group',
  target: 'entra-id',
  targetId,
  sourcePolicy: 'Sales',
}));

describe('Peer groups from the access members hold (MongoDB)', () => {
  let moduleRef: TestingModule;
  let service: IntelligenceService;
  let identities: Model<IdentityDocument>;
  let requests: Model<AccessRequestDocument>;
  let catalog: Model<EntitlementCatalogDocument>;
  let groups: Model<PeerGroupDocument>;

  const policyEngine = {
    evaluateOperationsWithoutSod: jest.fn(async (profile: { departmentName?: string }) =>
      rulesFor(profile),
    ),
  };
  const identityService = {
    buildProfileWithContractsForPolicy: jest.fn(async (doc: { profile: object }) => ({
      ...doc.profile,
    })),
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: PeerGroup.name, schema: PeerGroupSchema },
          { name: ReviewerQualityScore.name, schema: ReviewerQualityScoreSchema },
          { name: ReviewItem.name, schema: ReviewItemSchema },
          { name: ReviewCampaign.name, schema: ReviewCampaignSchema },
          { name: Identity.name, schema: IdentitySchema },
          { name: AccessRequest.name, schema: AccessRequestSchema },
          { name: EntitlementCatalog.name, schema: EntitlementCatalogSchema },
        ]),
      ],
      providers: [
        IntelligenceService,
        HeldAccessService,
        { provide: PolicyEngineService, useValue: policyEngine },
        { provide: IdentityService, useValue: identityService },
        { provide: intelligenceConfig.KEY, useValue: config },
      ],
    }).compile();
    service = moduleRef.get(IntelligenceService);
    identities = moduleRef.get(getModelToken(Identity.name));
    requests = moduleRef.get(getModelToken(AccessRequest.name));
    catalog = moduleRef.get(getModelToken(EntitlementCatalog.name));
    groups = moduleRef.get(getModelToken(PeerGroup.name));
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    for (const model of [identities, requests, catalog, groups] as Model<unknown>[]) {
      await model.deleteMany({}).setOptions({ skipTenantScope: true });
    }
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const inTenant = <R>(fn: () => Promise<R>, tenantId = T) => withTenantContext(tenantId, fn);

  /** An identity whose Entra ID account is in this provisioning state. */
  const person = async (
    first: string,
    departmentName: string,
    entra: 'SYNCED' | 'PENDING' = 'SYNCED',
    tenantId = T,
  ): Promise<string> => {
    const doc = await inTenant(
      () =>
        identities.create({
          tenantId,
          profile: {
            firstName: first,
            lastName: 'Test',
            email: `${first.toLowerCase()}@corp.example`,
            departmentName,
            jobTitle: 'Specialist',
            status: 'ACTIVE',
          },
          provisioning: [{ targetSystem: 'entra-id', status: entra }],
        }),
      tenantId,
    );
    return String(doc._id);
  };

  let requestSeq = 0;
  /** An access request for the identity (its beneficiary) with one Entra ID entitlement. */
  const requested = (
    identityId: string,
    entitlementName: string,
    nativeId: string,
    status: AccessRequestStatus = 'ACTIVE',
  ) =>
    inTenant(() =>
      requests.create({
        tenantId: T,
        requestId: `req-${++requestSeq}`,
        requesterId: identityId,
        targetIdentityId: identityId,
        requesterEmail: 'someone@corp.example',
        entitlements: [
          {
            catalogEntryId: `cat-${nativeId}`,
            system: 'entra-id',
            entitlementName,
            nativeId,
            justification: 'needed for the job',
          },
        ],
        status,
        approvalSteps: [],
      }),
    );

  const build = (tenantId = T) => inTenant(() => service.buildPeerGroups(tenantId), tenantId);
  const baselineOf = async (identityId: string) =>
    (await inTenant(() => service.getGroupForIdentity(T, identityId)))?.entitlementBaseline ?? [];

  describe('the baseline is the access members hold', () => {
    let aino: string;
    let eero: string;
    let liisa: string;
    let mika: string;

    beforeEach(async () => {
      aino = await person('Aino', 'Finance');
      eero = await person('Eero', 'Finance');
      liisa = await person('Liisa', 'Finance');
      // A joiner whose Entra ID account is not synced yet: the rules' access is still pending.
      mika = await person('Mika', 'Finance', 'PENDING');
      for (const peer of [eero, liisa, mika]) {
        await requested(peer, 'VPN users', 'guid-vpn');
        await requested(peer, 'Wiki editors', 'guid-wiki');
      }
      await requested(aino, 'Payroll admins', 'guid-payroll', 'REVOKED');
    });

    it('counts policy grants on a synced account and ACTIVE requests, each with how it is held', async () => {
      await build();

      const baseline = (await baselineOf(aino))
        .map((b) => ({ ...b }))
        .sort((a, b) => a.entitlementId.localeCompare(b.entitlementId));
      expect(baseline).toEqual([
        {
          entitlementId: 'entra-id::E3',
          system: 'entra-id',
          name: 'E3',
          holdRate: 0.75, // Mika's license is pending
          grantedBy: ['policy'],
        },
        {
          entitlementId: 'entra-id::grp-finance',
          system: 'entra-id',
          name: 'grp-finance',
          holdRate: 0.75,
          grantedBy: ['policy'],
        },
        {
          entitlementId: 'entra-id::guid-vpn',
          system: 'entra-id',
          name: 'VPN users',
          holdRate: 0.75,
          grantedBy: ['request'],
        },
        {
          entitlementId: 'entra-id::guid-wiki',
          system: 'entra-id',
          name: 'Wiki editors',
          holdRate: 0.75,
          grantedBy: ['request'],
        },
      ]);
    });

    it('a request for an entitlement most peers got by request is not unusual', async () => {
      await build();

      expect(
        await inTenant(() => service.getUnusualRequestWarning(T, aino, 'entra-id::guid-vpn')),
      ).toBeNull();
      // What nobody in the group holds is still CRITICAL.
      expect(
        await inTenant(() => service.getUnusualRequestWarning(T, aino, 'entra-id::guid-payroll')),
      ).toEqual({ warning: 'No peers in your group have this access.', severity: 'CRITICAL' });
    });

    it('recommends what most peers hold, how they hold it and whether it can be requested', async () => {
      await inTenant(() =>
        catalog.create([
          {
            tenantId: T,
            system: 'entra-id',
            nativeId: 'guid-vpn',
            name: 'VPN users',
            type: 'Group',
            requestable: true,
            riskLevel: 'LOW',
          },
          {
            tenantId: T,
            system: 'entra-id',
            nativeId: 'guid-wiki',
            name: 'Wiki editors',
            type: 'Group',
            requestable: false,
            riskLevel: 'MEDIUM',
          },
        ]),
      );
      await build();

      const forAino = await inTenant(() => service.getRecommendations(T, aino));
      expect(forAino.sort((a, b) => a.entitlementId.localeCompare(b.entitlementId))).toEqual([
        {
          entitlementId: 'entra-id::guid-vpn',
          system: 'entra-id',
          name: 'VPN users',
          holdRate: 0.75,
          grantedBy: ['request'],
          requestable: true,
          riskLevel: 'LOW',
        },
        {
          entitlementId: 'entra-id::guid-wiki',
          system: 'entra-id',
          name: 'Wiki editors',
          holdRate: 0.75,
          grantedBy: ['request'],
          requestable: false,
          riskLevel: 'MEDIUM',
        },
      ]);

      // Mika's rule-given access is on its way (pending), so it is not recommended to him.
      expect(await inTenant(() => service.getRecommendations(T, mika))).toEqual([]);
    });

    it('recommends an entitlement the catalog does not have, as not requestable', async () => {
      await build();

      const forAino = await inTenant(() => service.getRecommendations(T, aino));
      expect(forAino.map((r) => [r.entitlementId, r.requestable, r.riskLevel])).toEqual(
        expect.arrayContaining([
          ['entra-id::guid-vpn', false, undefined],
          ['entra-id::guid-wiki', false, undefined],
        ]),
      );
    });
  });

  describe('a rule-given entitlement is named as the catalog names it', () => {
    let sales: string[];
    let joiner: string;

    beforeEach(async () => {
      const group = (nativeId: string, name: string) => ({
        tenantId: T,
        system: 'entra-id',
        nativeId,
        name,
        type: 'Group',
        requestable: true,
      });
      await inTenant(() =>
        catalog.create([
          group('guid-sg-sales', 'SG-Sales'),
          group('guid-crm', 'CRM users'),
          group('guid-shared-1', 'SG-Shared'),
          group('guid-shared-2', 'SG-Shared'),
        ]),
      );
      sales = await Promise.all(['Sami', 'Tiina', 'Ville'].map((n) => person(n, 'Sales')));
      // A joiner whose Entra ID account is not synced yet: the rules give them nothing yet.
      joiner = await person('Mika', 'Sales', 'PENDING');
    });

    const baselineById = async (identityId: string) =>
      Object.fromEntries(
        (await baselineOf(identityId)).map((b) => [
          b.entitlementId,
          { name: b.name, holdRate: b.holdRate, grantedBy: [...(b.grantedBy ?? [])] },
        ]),
      );

    it('by its native id: found by native id or by its one name on the system', async () => {
      await build();

      expect(await baselineById(sales[0])).toEqual({
        'entra-id::guid-sg-sales': { name: 'SG-Sales', holdRate: 0.75, grantedBy: ['policy'] },
        'entra-id::guid-crm': { name: 'CRM users', holdRate: 0.75, grantedBy: ['policy'] },
        // Two catalog entries have this name: which one the rule means is unknown
        'entra-id::SG-Shared': { name: 'SG-Shared', holdRate: 0.75, grantedBy: ['policy'] },
      });
    });

    it('a group most peers get from a rule that names it by display name is not unusual', async () => {
      await build();

      // The request form checks a catalog entry as `system::nativeId`
      expect(
        await inTenant(() =>
          service.getUnusualRequestWarning(T, joiner, 'entra-id::guid-sg-sales'),
        ),
      ).toBeNull();
    });

    it('one entitlement held by rule and by request counts once, held both ways', async () => {
      await requested(joiner, 'SG-Sales', 'guid-sg-sales');
      await build();

      expect(await baselineById(joiner)).toEqual({
        'entra-id::guid-sg-sales': {
          name: 'SG-Sales',
          holdRate: 1,
          grantedBy: ['policy', 'request'],
        },
        'entra-id::guid-crm': { name: 'CRM users', holdRate: 0.75, grantedBy: ['policy'] },
        'entra-id::SG-Shared': { name: 'SG-Shared', holdRate: 0.75, grantedBy: ['policy'] },
      });
    });
  });

  describe('a build keeps only the current groups', () => {
    it('removes a group that fell below the minimum size, so a mover is found in their new group', async () => {
      const finance = await Promise.all(['Aino', 'Eero', 'Liisa'].map((n) => person(n, 'Finance')));
      const sales = await Promise.all(['Sami', 'Tiina', 'Ville'].map((n) => person(n, 'Sales')));
      await build();
      expect(await inTenant(() => groups.countDocuments({ tenantId: T }).exec())).toBe(2);

      // Ville moves to Finance: Sales is left with two.
      await inTenant(() =>
        identities
          .updateOne({ _id: sales[2] }, { $set: { 'profile.departmentName': 'Finance' } })
          .exec(),
      );
      await build();

      const stored = await inTenant(() => groups.find({ tenantId: T }).lean().exec());
      expect(stored.map((g) => g.attributes.department)).toEqual(['Finance']);
      expect([...stored[0].memberIds].sort()).toEqual([...finance, sales[2]].sort());
      expect(
        (await inTenant(() => service.getGroupForIdentity(T, sales[2])))?.attributes.department,
      ).toBe('Finance');
      expect(await inTenant(() => service.getGroupForIdentity(T, sales[0]))).toBeNull();
      expect(await inTenant(() => service.getPeerDeviationScore(T, sales[0]))).toBe(0);
    });

    it("leaves another tenant's groups alone", async () => {
      await Promise.all(
        ['Aino', 'Eero', 'Liisa'].map((n) => person(n, 'Finance', 'SYNCED', OTHER)),
      );
      await build(OTHER);
      await build(T); // this tenant has no group at all

      expect(await inTenant(() => groups.countDocuments({ tenantId: OTHER }).exec(), OTHER)).toBe(
        1,
      );
    });

    it('finds the most recently computed group when two hold the identity', async () => {
      const stored = (department: string, calculatedAt: string) =>
        inTenant(() =>
          groups.create({
            tenantId: T,
            groupKey: `key-${department}`,
            attributes: { department },
            memberCount: 3,
            memberIds: ['id-1', 'id-2', 'id-3'],
            calculatedAt: new Date(calculatedAt),
          }),
        );
      await stored('Sales', '2026-11-20T04:00:00.000Z');
      await stored('Finance', '2026-11-21T04:00:00.000Z');

      expect(
        (await inTenant(() => service.getGroupForIdentity(T, 'id-1')))?.attributes.department,
      ).toBe('Finance');
    });
  });
});
