/**
 * Policy Simulation Fixture Tests
 *
 * Runs policy simulation against fixture dataset. Asserts expected entitlements per user
 * and no unexpected grants. If simulation output changes (e.g., new policy operator),
 * test fails — prevents regression.
 *
 * @see docs/tasks/CURRENT_TASK_23.md
 */
import { Test } from '@nestjs/testing';
import { PolicyEngineService } from './policy-engine.service';
import { ReviewExclusionService } from './review-exclusion.service';
import { PamFilterService } from './pam-filter.service';
import { PolicyService } from './policy.service';
import { Policy } from './schemas/policy.schema';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { SodService } from './sod.service';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { IDENTITY_QUERY_PORT } from '@shared/interfaces/identity-query.port';
import { ROLE_BUNDLE_RESOLVER_PORT } from '@shared/interfaces/role-bundle-resolver.port';
import { createMockLoggerFactory, createMockEventEmitter } from '@testing/test-helpers';
import { authConfig } from '@infrastructure/config/auth.config';
import {
  fixtureUsers,
  fixturePolicies,
  expectedOperationsPerUser,
} from '../../../test/fixtures/simulation-fixture';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';

describe('Policy Simulation Fixture', () => {
  let engine: PolicyEngineService;

  beforeEach(async () => {
    const { factory: loggerFactory } = createMockLoggerFactory();

    const module = await Test.createTestingModule({
      providers: [
        PolicyEngineService,
        PamFilterService,
        { provide: PolicyService, useValue: { findActive: jest.fn(), findOne: jest.fn() } },
        {
          provide: IDENTITY_QUERY_PORT,
          useValue: { findAllPaginated: jest.fn().mockResolvedValue([[], 0]) },
        },
        { provide: SodService, useValue: { validateOperations: jest.fn().mockReturnValue([]) } },
        {
          provide: ReviewExclusionService,
          useValue: { activeForProfile: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: ROLE_BUNDLE_RESOLVER_PORT,
          useValue: { resolveWithInheritance: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: EntitlementCatalogService,
          useValue: { findForAdminRedirect: jest.fn().mockResolvedValue(null) },
        },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: createMockEventEmitter() },
        { provide: authConfig.KEY, useValue: { DEFAULT_TENANT_ID: 'test-tenant' } },
      ],
    }).compile();

    engine = module.get(PolicyEngineService);
  });

  it('runs simulation against fixture and asserts expected entitlements per user', async () => {
    for (const user of fixtureUsers) {
      const standardUser = user as StandardUserDto;
      const result = await engine.evaluateWithPolicies(
        standardUser,
        fixturePolicies as unknown as Policy[],
      );

      const expected = expectedOperationsPerUser[user.email] || [];
      const actual = result.operations.map(
        (op: { type: string; targetId: string; sourcePolicy: string }) => ({
          type: op.type,
          targetId: op.targetId,
          sourcePolicy: op.sourcePolicy,
        }),
      );

      expect(actual).toEqual(expected);
    }
  });

  it('fixture covers multiple policies and condition types', () => {
    expect(fixtureUsers.length).toBeGreaterThanOrEqual(5);
    expect(fixturePolicies.length).toBeGreaterThanOrEqual(2);
  });
});
