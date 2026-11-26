/**
 * FOLLOWUPS 2026-11-23 (infrastructure/events/handlers/mover.handler.ts:42 with the policy
 * engine): a review revoke of policy-granted access did not stick. A group revoked at campaign
 * close came back with the next mover run that made it new (a move back to the department that
 * grants it), and with onboarding.
 *
 * Here on in-memory MongoDB, with the real policy engine, the real exclusion lookup and the
 * mover's delta (evaluateMoverChange, which a re-evaluation runs too): the mover evaluates a
 * policy profile without the identity's id, so the engine finds the identity's exclusions by its
 * email. While the exclusion is active the move does not add the revoked group; once a
 * policy-admin lifts it, the same move adds it again. The re-evaluation a lift starts adds it
 * back although no attribute changed: the "before" side (the access baseline) still leaves out
 * what an exclusion lifted after the baseline took away; once a run advanced the baseline, it
 * no longer does.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { authConfig } from '@infrastructure/config/auth.config';
import { IDENTITY_QUERY_PORT } from '@shared/interfaces/identity-query.port';
import { ROLE_BUNDLE_RESOLVER_PORT } from '@shared/interfaces/role-bundle-resolver.port';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import {
  clearTestDb,
  closeTestDb,
  connectTestDb,
  createMockEventEmitter,
  createMockLoggerFactory,
  TEST_TENANT_ID,
} from '@testing';
import { createMockPolicy } from '@testing/mock-factories';
import {
  Identity,
  IdentityDocument,
  IdentitySchema,
} from '../modules/identity/schemas/identity.schema';
import { IdentityQueryService } from '../modules/identity/identity-query.service';
import type { IdentityService } from '../modules/identity/identity.service';
import { PolicyEngineService } from '../modules/policy/policy-engine.service';
import { PamFilterService } from '../modules/policy/pam-filter.service';
import { PolicyService } from '../modules/policy/policy.service';
import { SodService } from '../modules/policy/sod.service';
import { ReviewExclusionService } from '../modules/policy/review-exclusion.service';
import {
  ReviewExclusion,
  ReviewExclusionSchema,
} from '../modules/policy/schemas/review-exclusion.schema';
import { EntitlementCatalogService } from '../modules/entitlement-catalog/entitlement-catalog.service';
import { MoverActivities } from './mover.activities';
import {
  AccessRequest,
  AccessRequestSchema,
  type AccessRequestDocument,
} from '../modules/access-requests/schemas/access-request.schema';
import type { PolicyActivities } from './policy.activities';

mongoose.plugin(tenantPlugin);

/** One policy per department: its members get the department's Entra ID group. */
const departmentPolicy = (department: string) =>
  createMockPolicy({
    name: `${department} access`,
    conditionGroups: [
      {
        id: 'g1',
        join: 'AND',
        conditions: [{ id: 'c1', field: 'department', operator: 'equals', value: department }],
      },
    ],
    actions: [
      {
        id: 'a1',
        type: 'assign_group',
        target: 'entra-id',
        params: { groupName: `${department}-group` },
      },
    ],
  });
const POLICIES = ['Engineering', 'Sales'].map(departmentPolicy);

const group = (department: string, action: 'add' | 'remove') => ({
  type: 'group',
  action,
  target: 'entra-id',
  targetId: `${department}-group`,
  sourcePolicy: `${department} access`,
});

describe('Mover delta with an access review exclusion (MongoDB)', () => {
  let moduleRef: TestingModule;
  let identities: Model<IdentityDocument>;
  let exclusions: ReviewExclusionService;
  let mover: MoverActivities;

  const asTenant = <T>(fn: () => Promise<T>) => withTenantContext(TEST_TENANT_ID, fn);

  beforeAll(async () => {
    await connectTestDb();
    identities = mongoose.model(
      Identity.name,
      IdentitySchema,
    ) as unknown as Model<IdentityDocument>;
    const exclusionModel = mongoose.model(ReviewExclusion.name, ReviewExclusionSchema);
    await exclusionModel.init();
    moduleRef = await Test.createTestingModule({
      providers: [
        PolicyEngineService,
        PamFilterService,
        ReviewExclusionService,
        IdentityQueryService,
        { provide: getModelToken(Identity.name), useValue: identities },
        { provide: getModelToken(ReviewExclusion.name), useValue: exclusionModel },
        { provide: IDENTITY_QUERY_PORT, useExisting: IdentityQueryService },
        { provide: PolicyService, useValue: { findActive: async () => POLICIES } },
        { provide: SodService, useValue: { validate: async () => [] } },
        {
          provide: ROLE_BUNDLE_RESOLVER_PORT,
          useValue: { resolveWithInheritance: async () => [] },
        },
        {
          provide: EntitlementCatalogService,
          useValue: { findForAdminRedirect: async () => null },
        },
        { provide: authConfig.KEY, useValue: { DEFAULT_TENANT_ID: TEST_TENANT_ID } },
        { provide: LoggerFactoryService, useValue: createMockLoggerFactory().factory },
        { provide: DomainEventEmitterService, useValue: createMockEventEmitter() },
      ],
    }).compile();
    exclusions = moduleRef.get(ReviewExclusionService);
    const engine = moduleRef.get(PolicyEngineService);
    // The mover's identity reads: the policy profile carries no identity id, as the real one
    const identityService = {
      findIdentityById: (id: string) => identities.findById(id),
      buildProfileWithContractsForPolicy: async (identity: IdentityDocument) => ({
        ...identity.toObject().profile,
      }),
    } as unknown as IdentityService;
    // As PolicyActivities.evaluateUser: the options (before side: lifted-since) reach the engine
    const policyActivities = {
      evaluateUser: (
        user: StandardUserDto,
        tenantId: string,
        _correlationId?: string,
        options?: { reviewExclusionsLiftedSince?: Date },
      ) => engine.evaluate(user, tenantId, options),
    } as unknown as PolicyActivities;
    mover = new MoverActivities(
      createMockEventEmitter() as unknown as DomainEventEmitterService,
      identityService,
      policyActivities,
      // No access requests in these tests
      mongoose.model(
        AccessRequest.name,
        AccessRequestSchema,
      ) as unknown as Model<AccessRequestDocument>,
    );
  }, 60_000);

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await moduleRef?.close();
    await closeTestDb();
  });

  /** A salesperson provisioned to Entra ID whose Sales-group a review revoked. */
  async function salespersonWithRevokedGroup(baselineAt?: Date): Promise<string> {
    const id = await asTenant(async () => {
      const doc = await identities.create({
        ...(baselineAt
          ? {
              accessBaseline: {
                attributes: { departmentName: 'Sales', jobTitle: 'Account manager' },
                recordedAt: baselineAt,
                recordedBy: 'provisioning',
              },
            }
          : {}),
        tenantId: TEST_TENANT_ID,
        profile: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@acme.test',
          status: 'ACTIVE',
          departmentName: 'Sales',
          jobTitle: 'Account manager',
        },
        provisioning: [{ targetSystem: 'entra-id', status: 'SYNCED' }],
      });
      return String(doc._id);
    });
    await asTenant(() =>
      exclusions.record(
        {
          identityId: id,
          targetSystem: 'entra-id',
          scope: 'entitlement',
          entitlementType: 'group',
          entitlementName: 'Sales-group',
          entitlementId: '1c2d3e4f-0000-4000-8000-000000000005',
          campaignId: 'camp-1',
          campaignName: 'Q4 review',
          itemId: 'item-1',
          decision: 'revoked',
          reviewer: 'manager@acme.test',
          justification: 'Not needed in the new role',
          grantingPolicies: [],
        },
        TEST_TENANT_ID,
      ),
    );
    return id;
  }

  /** The delta of a move from Engineering to Sales (the current department). */
  const moveBackToSales = (id: string) =>
    asTenant(() =>
      mover.evaluateMoverChange(
        id,
        ['departmentName'],
        { departmentName: 'Engineering' },
        TEST_TENANT_ID,
      ),
    );

  it('does not add a group a review revoked when a move makes it new', async () => {
    const id = await salespersonWithRevokedGroup();

    const delta = await moveBackToSales(id);

    expect(delta?.toAdd).toEqual([]);
    expect(delta?.toRemove).toEqual([group('Engineering', 'remove')]);
  });

  it('adds it again once a policy-admin lifts the exclusion', async () => {
    const id = await salespersonWithRevokedGroup();
    const { exclusions: active } = await asTenant(() => exclusions.listActive(id));
    await asTenant(() => exclusions.lift(id, active[0]._id, 'policy.admin@acme.test'));

    const delta = await moveBackToSales(id);

    expect(delta?.toAdd).toEqual([group('Sales', 'add')]);
  });

  /** The delta of a re-evaluation with no attribute changed since the access baseline. */
  const reevaluate = (id: string) =>
    asTenant(() => mover.evaluateMoverChange(id, [], {}, TEST_TENANT_ID));

  it('the re-evaluation a lift starts gives the access back, then nothing more', async () => {
    const id = await salespersonWithRevokedGroup(new Date('2026-11-01T08:00:00.000Z'));
    expect((await reevaluate(id))?.toAdd).toEqual([]);

    const { exclusions: active } = await asTenant(() => exclusions.listActive(id));
    await asTenant(() => exclusions.lift(id, active[0]._id, 'policy.admin@acme.test'));
    const afterLift = await reevaluate(id);

    expect(afterLift?.toAdd).toEqual([group('Sales', 'add')]);
    expect(afterLift?.toRemove).toEqual([]);

    // The completed run advances the baseline: the lifted exclusion no longer counts there
    await asTenant(() =>
      identities
        .updateOne({ _id: id }, { $set: { 'accessBaseline.recordedAt': new Date() } })
        .exec(),
    );
    expect((await reevaluate(id))?.toAdd).toEqual([]);
  });
});
