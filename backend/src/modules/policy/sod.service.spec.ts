import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { SodService } from './sod.service';
import { SodPolicy } from './schemas/sod-policy.schema';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { TEST_TENANT_ID, createMockEventEmitter } from '@testing/test-helpers';

describe('SodService', () => {
  let sodService: SodService;
  let sodPolicyModel: any;

  beforeEach(async () => {
    sodPolicyModel = {
      find: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };

    const module = await Test.createTestingModule({
      providers: [
        SodService,
        {
          provide: getModelToken(SodPolicy.name),
          useValue: sodPolicyModel,
        },
        {
          provide: DomainEventEmitterService,
          useValue: createMockEventEmitter(),
        },
      ],
    }).compile();

    sodService = module.get(SodService);
  });

  describe('validate', () => {
    it('should return empty when no active SoD policies', async () => {
      sodPolicyModel.find.mockReturnValue({ exec: jest.fn().mockResolvedValue([]) });

      const ops = [
        { target: 'entra-id', type: 'group', targetId: 'G1', action: 'add' as const },
        { target: 'entra-id', type: 'group', targetId: 'G2', action: 'add' as const },
      ];
      const result = await sodService.validate(TEST_TENANT_ID, ops);
      expect(result).toEqual([]);
    });

    it('should return violation when ops match conflicting pair (BLOCK)', async () => {
      const policy = {
        name: 'No Pay & Vendor',
        severity: 'HIGH',
        action: 'BLOCK',
        conflictingEntitlements: [
          { system: 'entra-id', type: 'group', targetId: 'Payables' },
          { system: 'entra-id', type: 'group', targetId: 'Receivables' },
        ],
      };
      sodPolicyModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue([policy]),
      });

      const ops = [
        { target: 'entra-id', type: 'group', targetId: 'Payables', action: 'add' as const },
        { target: 'entra-id', type: 'group', targetId: 'Receivables', action: 'add' as const },
      ];
      const result = await sodService.validate(TEST_TENANT_ID, ops);
      expect(result).toHaveLength(1);
      expect(result[0].policyName).toBe('No Pay & Vendor');
      expect(result[0].action).toBe('BLOCK');
    });

    it('should NOT match when only one of the pair is present', async () => {
      const policy = {
        name: 'No Pay & Vendor',
        severity: 'HIGH',
        action: 'BLOCK',
        conflictingEntitlements: [
          { system: 'entra-id', type: 'group', targetId: 'Payables' },
          { system: 'entra-id', type: 'group', targetId: 'Receivables' },
        ],
      };
      sodPolicyModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue([policy]),
      });

      const ops = [
        { target: 'entra-id', type: 'group', targetId: 'Payables', action: 'add' as const },
      ];
      const result = await sodService.validate(TEST_TENANT_ID, ops);
      expect(result).toEqual([]);
    });

    it('should ignore remove operations (only add triggers SoD)', async () => {
      const policy = {
        name: 'No Pay & Vendor',
        severity: 'HIGH',
        action: 'BLOCK',
        conflictingEntitlements: [
          { system: 'entra-id', type: 'group', targetId: 'Payables' },
          { system: 'entra-id', type: 'group', targetId: 'Receivables' },
        ],
      };
      sodPolicyModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue([policy]),
      });

      const ops = [
        { target: 'entra-id', type: 'group', targetId: 'Payables', action: 'remove' as const },
        { target: 'entra-id', type: 'group', targetId: 'Receivables', action: 'remove' as const },
      ];
      const result = await sodService.validate(TEST_TENANT_ID, ops);
      expect(result).toEqual([]);
    });

    it('should match case-insensitively for type (Group vs group)', async () => {
      const policy = {
        name: 'No Dual Role',
        severity: 'HIGH',
        action: 'BLOCK',
        conflictingEntitlements: [
          { system: 'entra-id', type: 'Group', targetId: 'Admins' },
          { system: 'entra-id', type: 'Group', targetId: 'Auditors' },
        ],
      };
      sodPolicyModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue([policy]),
      });

      const ops = [
        { target: 'entra-id', type: 'group', targetId: 'Admins', action: 'add' as const },
        { target: 'entra-id', type: 'group', targetId: 'Auditors', action: 'add' as const },
      ];
      const result = await sodService.validate(TEST_TENANT_ID, ops);
      expect(result).toHaveLength(1);
    });

    it('should support N-way conflict (3+ entitlements, ALL must be present)', async () => {
      const policy = {
        name: 'Triple Conflict',
        severity: 'CRITICAL',
        action: 'BLOCK',
        conflictingEntitlements: [
          { system: 'entra-id', type: 'group', targetId: 'A' },
          { system: 'entra-id', type: 'group', targetId: 'B' },
          { system: 'entra-id', type: 'group', targetId: 'C' },
        ],
      };
      sodPolicyModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue([policy]),
      });

      const opsAll = [
        { target: 'entra-id', type: 'group', targetId: 'A', action: 'add' as const },
        { target: 'entra-id', type: 'group', targetId: 'B', action: 'add' as const },
        { target: 'entra-id', type: 'group', targetId: 'C', action: 'add' as const },
      ];
      const resultAll = await sodService.validate(TEST_TENANT_ID, opsAll);
      expect(resultAll).toHaveLength(1);

      const opsPartial = [
        { target: 'entra-id', type: 'group', targetId: 'A', action: 'add' as const },
        { target: 'entra-id', type: 'group', targetId: 'B', action: 'add' as const },
      ];
      sodPolicyModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue([policy]),
      });
      const resultPartial = await sodService.validate(TEST_TENANT_ID, opsPartial);
      expect(resultPartial).toEqual([]);
    });

    describe('directory roles: one type for requests, policies and the policy engine', () => {
      const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
      const policyWithRoleType = (type: string) => ({
        name: 'No admin approving payments',
        severity: 'HIGH',
        action: 'BLOCK',
        conflictingEntitlements: [
          { system: 'entra-id', type, targetId: GLOBAL_ADMIN },
          { system: 'entra-id', type: 'group', targetId: 'Payables' },
        ],
      });
      const payables = {
        target: 'entra-id',
        type: 'group',
        targetId: 'Payables',
        action: 'add' as const,
      };

      it.each([
        ['role', 'role'],
        ['role', 'directoryrole'],
        ['directoryrole', 'role'],
        ['DirectoryRole', 'role'],
      ])(
        'a policy storing `%s` matches a role operation named `%s`',
        async (storedType, opType) => {
          sodPolicyModel.find.mockReturnValue({
            exec: jest.fn().mockResolvedValue([policyWithRoleType(storedType)]),
          });

          const result = await sodService.validate(TEST_TENANT_ID, [
            { target: 'entra-id', type: opType, targetId: GLOBAL_ADMIN, action: 'add' as const },
            payables,
          ]);

          expect(result.map((v) => v.policyName)).toEqual(['No admin approving payments']);
        },
      );

      it('a role does not match a group with the same id', async () => {
        sodPolicyModel.find.mockReturnValue({
          exec: jest.fn().mockResolvedValue([policyWithRoleType('role')]),
        });

        const result = await sodService.validate(TEST_TENANT_ID, [
          { target: 'entra-id', type: 'group', targetId: GLOBAL_ADMIN, action: 'add' as const },
          payables,
        ]);

        expect(result).toEqual([]);
      });
    });

    describe('systems: named as the policy engine names them', () => {
      const policyOn = (system: string) => ({
        name: 'No pay and approve',
        severity: 'HIGH',
        action: 'BLOCK',
        conflictingEntitlements: [
          { system, type: 'group', targetId: 'Payables' },
          { system, type: 'group', targetId: 'Approvers' },
        ],
      });
      const opsOn = (target: string) => [
        { target, type: 'group', targetId: 'Payables', action: 'add' as const },
        { target, type: 'group', targetId: 'Approvers', action: 'add' as const },
      ];
      const matches = async (policySystem: string, opTarget: string) => {
        sodPolicyModel.find.mockReturnValue({
          exec: jest.fn().mockResolvedValue([policyOn(policySystem)]),
        });
        const result = await sodService.validate(TEST_TENANT_ID, opsOn(opTarget));
        return result.length > 0;
      };

      it.each([
        ['entra-id', 'entra'],
        ['entra', 'entra-id'],
        ['ad', 'active-directory'],
        ['active-directory', 'ad'],
        ['AD', 'Active-Directory'],
        ['GitHub', 'github'],
      ])('a policy on `%s` matches operations on `%s`', async (policySystem, opTarget) => {
        expect(await matches(policySystem, opTarget)).toBe(true);
      });

      it.each(['entra-id', 'ad', 'github'])(
        'operations on target `all` match a policy on `%s`',
        async (policySystem) => {
          expect(await matches(policySystem, 'all')).toBe(true);
        },
      );

      it.each([
        ['entra-id', 'ad'],
        ['ad', 'entra-id'],
        ['github', 'gitlab'],
      ])('a policy on `%s` does not match operations on `%s`', async (policySystem, opTarget) => {
        expect(await matches(policySystem, opTarget)).toBe(false);
      });

      it('one side on `all` and the other on Entra ID together match a policy on entra-id', async () => {
        sodPolicyModel.find.mockReturnValue({
          exec: jest.fn().mockResolvedValue([policyOn('entra-id')]),
        });
        const result = await sodService.validate(TEST_TENANT_ID, [
          { target: 'all', type: 'group', targetId: 'Payables', action: 'add' as const },
          { target: 'entra', type: 'group', targetId: 'Approvers', action: 'add' as const },
        ]);
        expect(result).toHaveLength(1);
      });
    });
  });
});
