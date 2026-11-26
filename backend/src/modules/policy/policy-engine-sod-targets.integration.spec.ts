/**
 * SoD in the policy engine's evaluation (onboarding, the mover, risk scoring), with the real
 * SodService on an in-memory MongoDB: a role-based rule names a group by its display name
 * (params.groupName) and an SoD policy may name it by its catalog native id (a GUID), so the two
 * are compared through the entitlement catalog (EntitlementCatalogService.loadTargetLookup), as
 * the access request check already did (HX-E r2-04 N1). Without that, a joiner whose rules give
 * both sides of a Block policy was provisioned with both.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { authConfig } from '@infrastructure/config/auth.config';
import { IDENTITY_QUERY_PORT } from '@shared/interfaces/identity-query.port';
import { ROLE_BUNDLE_RESOLVER_PORT } from '@shared/interfaces/role-bundle-resolver.port';
import { createMockLoggerFactory } from '@testing/test-helpers';
import { createMockPolicy, createMockUser } from '@testing/mock-factories';
import { PolicyEngineService } from './policy-engine.service';
import { PolicyService } from './policy.service';
import { PamFilterService } from './pam-filter.service';
import { ReviewExclusionService } from './review-exclusion.service';
import { SodService } from './sod.service';
import { SodPolicy, SodPolicySchema, SodPolicyDocument } from './schemas/sod-policy.schema';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { catalogTargetLookup } from '../entitlement-catalog/catalog-target-lookup';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const PAYABLES_ID = '0b5e7c1a-0000-0000-0000-000000000001';
const APPROVERS_ID = '6d2f9e4b-0000-0000-0000-000000000002';

/** Discovered Entra groups: the GUID is the native id, the display name the name. */
const CATALOG = [
  { system: 'entra-id', nativeId: PAYABLES_ID, name: 'Payables' },
  { system: 'entra-id', nativeId: APPROVERS_ID, name: 'Approvers' },
];

/** A Finance rule giving both groups by display name, as the policy studio stores it. */
const financeRule = createMockPolicy({
  name: 'Finance access',
  conditionGroups: [
    {
      id: 'g1',
      join: 'AND',
      conditions: [{ id: 'c1', field: 'department', operator: 'equals', value: 'Finance' }],
    },
  ],
  actions: [
    { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Payables' } },
    { id: 'a2', type: 'assign_group', target: 'entra-id', params: { groupName: 'Approvers' } },
  ],
});

describe('PolicyEngineService: SoD compares rule and policy targets by catalog id (MongoDB)', () => {
  let moduleRef: TestingModule;
  let engine: PolicyEngineService;
  let policies: Model<SodPolicyDocument>;
  const loadTargetLookup = jest.fn(async () => catalogTargetLookup(CATALOG));

  beforeAll(async () => {
    const { factory: loggerFactory } = createMockLoggerFactory();
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([{ name: SodPolicy.name, schema: SodPolicySchema }]),
      ],
      providers: [
        PolicyEngineService,
        PamFilterService,
        SodService,
        { provide: PolicyService, useValue: { findActive: async () => [financeRule] } },
        { provide: ReviewExclusionService, useValue: { activeForProfile: async () => [] } },
        {
          provide: ROLE_BUNDLE_RESOLVER_PORT,
          useValue: { resolveWithInheritance: async () => [] },
        },
        { provide: IDENTITY_QUERY_PORT, useValue: {} },
        {
          provide: EntitlementCatalogService,
          useValue: { loadTargetLookup, findForAdminRedirect: async () => null },
        },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: { emit: jest.fn() } },
        { provide: authConfig.KEY, useValue: { DEFAULT_TENANT_ID: 'default' } },
      ],
    }).compile();
    engine = moduleRef.get(PolicyEngineService);
    policies = moduleRef.get(getModelToken(SodPolicy.name));
  });

  beforeEach(async () => {
    loadTargetLookup.mockClear();
    await policies.deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const blockPolicyByNativeId = () =>
    withTenantContext(A, () =>
      policies.create({
        tenantId: A,
        name: 'Payables vs Approvers',
        severity: 'HIGH',
        action: 'BLOCK',
        isActive: true,
        conflictingEntitlements: [
          { system: 'entra-id', type: 'group', targetId: PAYABLES_ID },
          { system: 'entra-id', type: 'group', targetId: APPROVERS_ID },
        ],
      }),
    );

  const joiner = createMockUser({ departmentName: 'Finance' });

  it('blocks a joiner whose rules give both sides of a policy that names their native ids', async () => {
    await blockPolicyByNativeId();

    const intent = await withTenantContext(A, () => engine.evaluate(joiner, A));

    expect(intent.sodValidation?.blockers.map((v) => v.policyName)).toEqual([
      'Payables vs Approvers',
    ]);
    expect(loadTargetLookup).toHaveBeenCalledWith(A, expect.any(Array));
  });

  it('counts the same violation for risk scoring', async () => {
    await blockPolicyByNativeId();

    const { sodViolationCount } = await withTenantContext(A, () =>
      engine.evaluateForRiskScoring(joiner, A),
    );

    expect(sodViolationCount).toBe(1);
  });

  it('still finds no conflict for a person the rule does not match', async () => {
    await blockPolicyByNativeId();

    const intent = await withTenantContext(A, () =>
      engine.evaluate(createMockUser({ departmentName: 'Sales' }), A),
    );

    expect(intent.sodValidation?.blockers).toEqual([]);
  });
});
