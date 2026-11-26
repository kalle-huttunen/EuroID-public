import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OpaEvaluatorService } from './opa-evaluator.service';
import { OpaClientService } from '@infrastructure/opa/opa-client.service';
import { RegoCompilerService } from './rego-compiler.service';
import { PolicyService } from '../policy.service';
import { PolicyStatus } from '../schemas/policy.schema';
import { UserStatus, EmploymentType, type StandardUserDto } from '@shared/dtos/standard-user.dto';

describe('OpaEvaluatorService', () => {
  let service: OpaEvaluatorService;
  let mockOpaClient: Record<string, jest.Mock>;
  let mockPolicyService: Record<string, jest.Mock>;

  const testUser: StandardUserDto = {
    email: 'alice@acme.com',
    firstName: 'Alice',
    lastName: 'Smith',
    departmentName: 'Engineering',
    employmentType: EmploymentType.FULL_TIME,
    status: UserStatus.ACTIVE,
    sourceSystem: 'hr-feed',
    sourceUserId: 'alice-1',
    tenantId: 'test-tenant',
  };

  beforeEach(async () => {
    mockOpaClient = {
      isAvailable: jest.fn().mockReturnValue(true),
      shouldFallback: jest.fn().mockReturnValue(true),
      query: jest.fn().mockResolvedValue(null),
      pushPolicy: jest.fn().mockResolvedValue(true),
    };

    mockPolicyService = {
      findActive: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpaEvaluatorService,
        RegoCompilerService,
        { provide: OpaClientService, useValue: mockOpaClient },
        { provide: PolicyService, useValue: mockPolicyService },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(2000) } },
      ],
    }).compile();

    service = module.get(OpaEvaluatorService);
  });

  describe('isAvailable', () => {
    it('delegates to OPA client', () => {
      expect(service.isAvailable()).toBe(true);
      mockOpaClient.isAvailable.mockReturnValue(false);
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('evaluate', () => {
    it('returns null when OPA is unavailable', async () => {
      mockOpaClient.isAvailable.mockReturnValue(false);
      const result = await service.evaluate(testUser, [], 'test-tenant');
      expect(result).toBeNull();
    });

    it('returns null when OPA query returns null', async () => {
      mockOpaClient.query.mockResolvedValue(null);
      const result = await service.evaluate(testUser, [], 'test-tenant');
      expect(result).toBeNull();
    });

    it('maps OPA result to ProvisioningOperations', async () => {
      mockOpaClient.query.mockResolvedValue({
        operations: [
          {
            type: 'group',
            action: 'add',
            target: 'entra-id',
            targetId: 'Eng-Team',
            sourcePolicy: 'policy-1',
          },
          {
            type: 'license',
            action: 'add',
            target: 'entra-id',
            targetId: 'E3',
            sourcePolicy: 'policy-1',
            timeConstraint: { durationDays: 90 },
          },
        ],
      });

      const result = await service.evaluate(testUser, [], 'test-tenant');

      expect(result).toHaveLength(2);
      expect(result![0]).toEqual(
        expect.objectContaining({
          type: 'group',
          action: 'add',
          target: 'entra-id',
          targetId: 'Eng-Team',
        }),
      );
      expect(result![1].timeConstraint?.durationDays).toBe(90);
    });

    it('returns null on query error when fallback enabled', async () => {
      mockOpaClient.query.mockRejectedValue(new Error('connection refused'));
      const result = await service.evaluate(testUser, [], 'test-tenant');
      expect(result).toBeNull();
    });

    it('maps user fields correctly to OPA input', async () => {
      await service.evaluate(testUser, [], 'test-tenant');

      const callArgs = mockOpaClient.query.mock.calls[0][0];
      expect(callArgs.user.email).toBe('alice@acme.com');
      expect(callArgs.user.department).toBe('Engineering');
      expect(callArgs.user.employmentType).toBe('FULL_TIME');
      expect(callArgs.tenantId).toBe('test-tenant');
    });
  });

  describe('syncPolicies', () => {
    it('returns false when OPA is unavailable', async () => {
      mockOpaClient.isAvailable.mockReturnValue(false);
      const result = await service.syncPolicies('test-tenant');
      expect(result).toBe(false);
    });

    it('compiles and pushes active policies to OPA', async () => {
      mockPolicyService.findActive.mockResolvedValue([
        {
          _id: 'p1',
          name: 'Policy A',
          status: PolicyStatus.ACTIVE,
          priority: 3,
          conditionGroups: [],
          actions: [{ id: 'a1', type: 'assign_group', target: 'entra-id', params: {} }],
        },
      ]);

      const result = await service.syncPolicies('test-tenant');

      expect(result).toBe(true);
      expect(mockOpaClient.pushPolicy).toHaveBeenCalledWith(
        'euroid-test-tenant',
        expect.stringContaining('package euroid.policy.evaluate'),
      );
    });

    it('skips push when Rego bundle is unchanged', async () => {
      mockPolicyService.findActive.mockResolvedValue([]);

      await service.syncPolicies('test-tenant');
      await service.syncPolicies('test-tenant');

      expect(mockOpaClient.pushPolicy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getCompiledRego', () => {
    it('returns compiled Rego source', async () => {
      mockPolicyService.findActive.mockResolvedValue([]);
      const rego = await service.getCompiledRego('test-tenant');
      expect(rego).toContain('package euroid.policy.evaluate');
    });
  });
});
