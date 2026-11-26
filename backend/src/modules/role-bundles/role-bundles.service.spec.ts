import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { RoleBundlesService } from './role-bundles.service';
import { RoleBundle } from './schemas/role-bundle.schema';
import { Policy } from '../policy/schemas/policy.schema';
import { TEST_TENANT_ID } from '@testing/test-helpers';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';

describe('RoleBundlesService', () => {
  let service: RoleBundlesService;
  let mockModel: any;
  let mockPolicyModel: any;

  beforeEach(async () => {
    mockModel = {
      findOne: jest.fn(),
      find: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn(),
    };
    mockPolicyModel = {
      countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(0) }),
    };

    const module = await Test.createTestingModule({
      providers: [
        RoleBundlesService,
        {
          provide: getModelToken(RoleBundle.name),
          useValue: mockModel,
        },
        {
          provide: getModelToken(Policy.name),
          useValue: mockPolicyModel,
        },
        { provide: DomainEventEmitterService, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get(RoleBundlesService);
  });

  describe('resolveWithInheritance', () => {
    it('should return bundle actions when no inheritance', async () => {
      mockModel.findOne.mockReturnValue({
        lean: () => ({
          exec: () =>
            Promise.resolve({
              _id: 'bundle-1',
              tenantId: TEST_TENANT_ID,
              actions: [
                { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'G1' } },
                {
                  id: 'a2',
                  type: 'assign_license',
                  target: 'entra-id',
                  params: { licenseSku: 'E3' },
                },
              ],
              inheritance: [],
            }),
        }),
      });

      const result = await service.resolveWithInheritance('bundle-1', TEST_TENANT_ID);
      expect(result).toHaveLength(2);
      expect(result[0].params.groupName).toBe('G1');
      expect(result[1].params.licenseSku).toBe('E3');
    });

    it('should merge parent bundle actions with child', async () => {
      const parentActions = [
        { id: 'p1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Parent' } },
        { id: 'p2', type: 'assign_license', target: 'entra-id', params: { licenseSku: 'E3' } },
      ];
      const childActions = [
        { id: 'c1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Child' } },
      ];

      mockModel.findOne
        .mockReturnValueOnce({
          lean: () => ({
            exec: () =>
              Promise.resolve({
                _id: 'child',
                tenantId: TEST_TENANT_ID,
                actions: childActions,
                inheritance: ['parent'],
              }),
          }),
        })
        .mockReturnValueOnce({
          lean: () => ({
            exec: () =>
              Promise.resolve({
                _id: 'parent',
                tenantId: TEST_TENANT_ID,
                actions: parentActions,
                inheritance: [],
              }),
          }),
        });

      const result = await service.resolveWithInheritance('child', TEST_TENANT_ID);
      expect(result.length).toBeGreaterThanOrEqual(3);
      const groupNames = result
        .filter((a) => a.type === 'assign_group')
        .map((a) => a.params.groupName);
      expect(groupNames).toContain('Parent');
      expect(groupNames).toContain('Child');
    });

    it('should deduplicate actions by type+target+params', async () => {
      mockModel.findOne.mockReturnValue({
        lean: () => ({
          exec: () =>
            Promise.resolve({
              _id: 'bundle-1',
              tenantId: TEST_TENANT_ID,
              actions: [
                { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'G1' } },
                { id: 'a2', type: 'assign_group', target: 'entra-id', params: { groupName: 'G1' } },
              ],
              inheritance: [],
            }),
        }),
      });

      const result = await service.resolveWithInheritance('bundle-1', TEST_TENANT_ID);
      expect(result).toHaveLength(1);
      expect(result[0].params.groupName).toBe('G1');
    });

    it('should not recurse beyond maxDepth', async () => {
      let callCount = 0;
      mockModel.findOne.mockImplementation(() => ({
        lean: () => ({
          exec: () => {
            callCount++;
            return Promise.resolve({
              _id: `bundle-${callCount}`,
              tenantId: TEST_TENANT_ID,
              actions: [
                {
                  id: `a${callCount}`,
                  type: 'assign_group',
                  target: 'entra-id',
                  params: { groupName: `G${callCount}` },
                },
              ],
              inheritance: callCount < 10 ? [`bundle-${callCount + 1}`] : [],
            });
          },
        }),
      }));

      const result = await service.resolveWithInheritance('bundle-1', TEST_TENANT_ID, 5);
      expect(callCount).toBeLessThanOrEqual(6);
      expect(result.length).toBeLessThanOrEqual(6);
    });

    it('should handle cycle in inheritance without infinite loop', async () => {
      mockModel.findOne
        .mockReturnValueOnce({
          lean: () => ({
            exec: () =>
              Promise.resolve({
                _id: 'a',
                tenantId: TEST_TENANT_ID,
                actions: [
                  {
                    id: 'a1',
                    type: 'assign_group',
                    target: 'entra-id',
                    params: { groupName: 'A' },
                  },
                ],
                inheritance: ['b'],
              }),
          }),
        })
        .mockReturnValueOnce({
          lean: () => ({
            exec: () =>
              Promise.resolve({
                _id: 'b',
                tenantId: TEST_TENANT_ID,
                actions: [
                  {
                    id: 'b1',
                    type: 'assign_group',
                    target: 'entra-id',
                    params: { groupName: 'B' },
                  },
                ],
                inheritance: ['a'],
              }),
          }),
        });

      const result = await service.resolveWithInheritance('a', TEST_TENANT_ID);
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result.length).toBeLessThanOrEqual(2);
    });
  });
});
