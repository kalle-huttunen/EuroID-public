/**
 * The access change of a manual department edit, at the mover's delta (evaluateMoverChange), on
 * in-memory MongoDB with the real identity edit (PATCH /identity/:id's IdentityMutationService),
 * policy profile (IdentityOnionService) and policy engine.
 *
 * The policies evaluate the profile and one contract per HR source with that source's title and
 * department. After an edit of the department, the HR record still carried the old one, so the
 * identity matched both departments: the mover added the new department's access and removed
 * nothing. The owner's decision (plan 2.8): a manual edit overrides the HR contract's value until
 * HR changes it (modules/identity/manual-contract-overrides.ts).
 *
 * Since the owner decision of 2026-11-24 PATCH refuses an edit of a field an HR source masters
 * (409): the edit is only possible for a department EuroID keeps, here one whose Field Mastery
 * names Entra ID, which has sent none yet. With HR as the department's master the edit is refused
 * and nothing moves; the override of an HR-mastered department is the identity control
 * (modules/identity/identity-controls.integration.spec.ts).
 */
import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { authConfig } from '@infrastructure/config/auth.config';
import { IDENTITY_QUERY_PORT } from '@shared/interfaces/identity-query.port';
import { ROLE_BUNDLE_RESOLVER_PORT } from '@shared/interfaces/role-bundle-resolver.port';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import {
  createMockLoggerFactory,
  createMockEventEmitter,
  TEST_TENANT_ID,
  closeTestDb,
  testDbUri,
} from '@testing';
import { createMockPolicy } from '@testing/mock-factories';
import {
  Identity,
  IdentitySchema,
  IdentityDocument,
} from '../modules/identity/schemas/identity.schema';
import { IdentityOnionService } from '../modules/identity/identity-onion.service';
import { IdentityMutationService } from '../modules/identity/identity-mutation.service';
import { IdentityQueryService } from '../modules/identity/identity-query.service';
import { IdentityCorrelationService } from '../modules/identity/identity-correlation.service';
import { ReconciliationConfigService } from '../modules/identity/reconciliation-config.service';
import { ReconciliationService } from '../modules/identity/reconciliation.service';
import { CorrelationConfigService } from '../modules/correlation-config/correlation-config.service';
import { IdentityService } from '../modules/identity/identity.service';
import { PolicyEngineService } from '../modules/policy/policy-engine.service';
import { PamFilterService } from '../modules/policy/pam-filter.service';
import { PolicyService } from '../modules/policy/policy.service';
import { SodService } from '../modules/policy/sod.service';
import { ReviewExclusionService } from '../modules/policy/review-exclusion.service';
import { EntitlementCatalogService } from '../modules/entitlement-catalog/entitlement-catalog.service';
import { MoverActivities } from './mover.activities';
import {
  AccessRequest,
  AccessRequestSchema,
  type AccessRequestDocument,
} from '../modules/access-requests/schemas/access-request.schema';
import { PolicyActivities } from './policy.activities';

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
const POLICIES = ['Engineering', 'Sales', 'Marketing'].map(departmentPolicy);

const group = (department: string, action: 'add' | 'remove') => ({
  type: 'group',
  action,
  target: 'entra-id',
  targetId: `${department}-group`,
  sourcePolicy: `${department} access`,
});

describe('Mover delta of a manual department edit (MongoDB)', () => {
  let moduleRef: TestingModule;
  let identities: Model<IdentityDocument>;
  let onion: IdentityOnionService;
  let mutation: IdentityMutationService;
  let mover: MoverActivities;
  let accessRequests: Model<AccessRequestDocument>;
  const events = createMockEventEmitter();
  /** An edit through PATCH /identity/:id, which refuses an HR-mastered field. */
  const PATCH = { refuseHrMastered: true };
  /** The Brain's Field Mastery: the department's master is Entra ID (no value yet) by default. */
  let fieldMasteryOverrides: Record<string, string[]> = {};
  const correlationConfig = {
    getCorrelationConfig: async () => ({ rules: [{ strategy: 'email' }], fieldMasteryOverrides }),
    getHrConnectorsWithPriorityFromBlueprint: async () => [],
    getInstalledHrConnectorsWithPriority: async () => [],
  };

  const asTenant = <T>(fn: () => Promise<T>) => withTenantContext(TEST_TENANT_ID, fn);

  beforeAll(async () => {
    const { factory: loggerFactory } = createMockLoggerFactory();
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: AccessRequest.name, schema: AccessRequestSchema },
        ]),
      ],
      providers: [
        IdentityOnionService,
        IdentityMutationService,
        IdentityQueryService,
        PolicyEngineService,
        PamFilterService,
        ReconciliationService,
        { provide: IdentityCorrelationService, useValue: {} },
        {
          provide: ReconciliationConfigService,
          useValue: { getConfig: async () => null, getHrSourceTags: async () => [] },
        },
        { provide: CorrelationConfigService, useValue: correlationConfig },
        { provide: PolicyService, useValue: { findActive: async () => POLICIES } },
        { provide: SodService, useValue: { validate: async () => [] } },
        { provide: ReviewExclusionService, useValue: { activeForProfile: async () => [] } },
        {
          provide: ROLE_BUNDLE_RESOLVER_PORT,
          useValue: { resolveWithInheritance: async () => [] },
        },
        { provide: IDENTITY_QUERY_PORT, useValue: {} },
        {
          provide: EntitlementCatalogService,
          useValue: { findForAdminRedirect: async () => null },
        },
        { provide: authConfig.KEY, useValue: { DEFAULT_TENANT_ID: TEST_TENANT_ID } },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: events },
      ],
    }).compile();
    identities = moduleRef.get(getModelToken(Identity.name));
    onion = moduleRef.get(IdentityOnionService);
    mutation = moduleRef.get(IdentityMutationService);
    const engine = moduleRef.get(PolicyEngineService);
    // The identity reads of the mover activity, and the policy evaluation it runs (as onboarding)
    const identityService = {
      findIdentityById: (id: string) => onion.findIdentityById(id),
      buildProfileWithContractsForPolicy: (identity: IdentityDocument) =>
        onion.buildProfileWithContractsForPolicy(identity),
    } as unknown as IdentityService;
    const policyActivities = {
      evaluateUser: (user: StandardUserDto, tenantId: string) => engine.evaluate(user, tenantId),
    } as unknown as PolicyActivities;
    accessRequests = moduleRef.get(getModelToken(AccessRequest.name));
    mover = new MoverActivities(
      createMockEventEmitter() as unknown as DomainEventEmitterService,
      identityService,
      policyActivities,
      accessRequests,
    );
  }, 60_000);

  afterAll(async () => {
    await moduleRef?.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await identities.collection.deleteMany({});
    await accessRequests.collection.deleteMany({});
    events.emit.mockClear();
    fieldMasteryOverrides = { departmentName: ['entra-id'] };
  });

  /** An Engineering engineer from the HR feed, provisioned to Entra ID with its baseline. */
  async function provisionedEngineer(): Promise<string> {
    const id = await asTenant(async () => {
      const doc = await identities.create({
        tenantId: TEST_TENANT_ID,
        profile: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@acme.test',
          status: 'ACTIVE',
          departmentName: 'Engineering',
          jobTitle: 'Engineer',
        },
        sources: [
          {
            sourceName: 'csv-hr',
            externalId: 'E-1',
            sourceRole: 'primary-hr',
            rawData: { departmentName: 'Engineering', jobTitle: 'Engineer' },
          },
        ],
        provisioning: [{ targetSystem: 'entra-id', status: 'SYNCED' }],
      });
      return String(doc._id);
    });
    await asTenant(() => onion.recordInitialAccessBaseline(id));
    return id;
  }

  /** The edit's identity.updated previousAttributes: the mover's "before" profile. */
  function editedFrom(): Record<string, unknown> {
    const [, , payload] = events.emit.mock.calls.find(
      ([type]) => type === DomainEventType.IDENTITY_UPDATED,
    )!;
    return (payload as { previousAttributes: Record<string, unknown> }).previousAttributes;
  }

  it('removes the old department access when the department is edited by hand', async () => {
    const id = await provisionedEngineer();

    await asTenant(() => mutation.update(id, { departmentName: 'Sales' }, 'op@acme.test', PATCH));
    const delta = await mover.evaluateMoverChange(
      id,
      ['departmentName'],
      editedFrom(),
      TEST_TENANT_ID,
    );

    expect(editedFrom()).toEqual({ departmentName: 'Engineering' });
    expect(delta?.toAdd).toEqual([group('Sales', 'add')]);
    expect(delta?.toRemove).toEqual([group('Engineering', 'remove')]);
    // The run advances the baseline to the profile it applied, contracts included
    expect(delta?.applied).toEqual({
      departmentName: 'Sales',
      contracts: [expect.objectContaining({ department: 'Sales', title: 'Engineer' })],
    });
  });

  it('keeps the old department access an approved access request also granted', async () => {
    const id = await provisionedEngineer();
    // Ada asked for the Engineering group herself, approved and provisioned (hunt 03 F9)
    await accessRequests.collection.insertOne({
      requestId: 'req-1',
      tenantId: TEST_TENANT_ID,
      requesterId: id,
      requesterEmail: 'ada@acme.test',
      status: 'ACTIVE',
      entitlements: [
        {
          catalogEntryId: 'cat-eng',
          system: 'entra-id',
          entitlementName: 'Engineering-group',
          nativeId: 'Engineering-group',
          entitlementType: 'Group',
          justification: 'project work',
        },
      ],
    });

    await asTenant(() => mutation.update(id, { departmentName: 'Sales' }, 'op@acme.test', PATCH));
    const delta = await mover.evaluateMoverChange(
      id,
      ['departmentName'],
      editedFrom(),
      TEST_TENANT_ID,
    );

    expect(delta?.toAdd).toEqual([group('Sales', 'add')]);
    expect(delta?.toRemove).toEqual([]);
  });

  it('lets HR win again: a new department from HR replaces the edited one in the contract', async () => {
    const id = await provisionedEngineer();
    await asTenant(() => mutation.update(id, { departmentName: 'Sales' }, 'op@acme.test', PATCH));
    const edit = await mover.evaluateMoverChange(
      id,
      ['departmentName'],
      editedFrom(),
      TEST_TENANT_ID,
    );
    await asTenant(() => onion.advanceAccessBaseline(id, edit!.applied));

    // HR moves the person to Marketing: the next sync writes the record and the profile
    await identities.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      {
        $set: {
          'sources.0.rawData.departmentName': 'Marketing',
          'profile.departmentName': 'Marketing',
        },
      },
    );
    const hrMove = await mover.evaluateMoverChange(
      id,
      ['departmentName'],
      { departmentName: 'Sales' },
      TEST_TENANT_ID,
    );

    expect(hrMove?.toAdd).toEqual([group('Marketing', 'add')]);
    expect(hrMove?.toRemove).toEqual([group('Sales', 'remove')]);
  });

  it('refuses the edit when the HR source masters the department, and moves nothing', async () => {
    fieldMasteryOverrides = {};
    const id = await provisionedEngineer();

    await expect(
      asTenant(() => mutation.update(id, { departmentName: 'Sales' }, 'op@acme.test', PATCH)),
    ).rejects.toThrow(
      new ConflictException(
        'departmentName is mastered by csv-hr: change it in HR, or set an override.',
      ),
    );

    const stored = await identities.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(stored?.profile.departmentName).toBe('Engineering');
    expect(stored?.metadata?.manualOverrides).toBeUndefined();
    expect(events.emit).not.toHaveBeenCalled();
  });
});
