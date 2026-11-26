import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CredentialPolicyService } from './credential-policy.service';
import { CredentialPolicy } from './schemas/credential-policy.schema';
import type { CreateCredentialPolicyDto } from './dtos/credential-lifecycle.dto';

describe('CredentialPolicyService', () => {
  let service: CredentialPolicyService;

  const createExecChain = (result: unknown) => ({
    exec: jest.fn().mockResolvedValue(result),
  });

  const mockModel = {
    create: jest.fn(),
    find: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue(createExecChain([])),
    }),
    findOne: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue(createExecChain(null)),
    }),
    findOneAndUpdate: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue(createExecChain(null)),
    }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 0 }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        CredentialPolicyService,
        { provide: getModelToken(CredentialPolicy.name), useValue: mockModel },
      ],
    }).compile();

    service = module.get(CredentialPolicyService);
  });

  describe('create', () => {
    it('should create a policy with tenantId', async () => {
      const dto = { name: 'Default Policy', passwordPolicy: { minLength: 16 } };
      mockModel.create.mockResolvedValue({ _id: 'policy-1', tenantId: 'test-tenant', ...dto });

      const result = await service.create('test-tenant', dto as any);

      expect(mockModel.create).toHaveBeenCalledWith({ tenantId: 'test-tenant', ...dto });
      expect(result._id).toBe('policy-1');
    });

    // The unique { tenantId, name } index: a name taken is a 409 the admin can act on, not a 500.
    it('answers 409 with the name when the tenant already has a policy of that name', async () => {
      mockModel.create.mockRejectedValue(
        Object.assign(new Error('E11000 duplicate key'), { code: 11000 }),
      );

      await expect(
        service.create('test-tenant', { name: 'Default' } as CreateCredentialPolicyDto),
      ).rejects.toThrow(
        new ConflictException(
          'A credential policy named "Default" already exists. Choose another name.',
        ),
      );
    });
  });

  describe('findAll', () => {
    it('should return all policies for tenant', async () => {
      const policies = [{ _id: 'p1', name: 'Policy A' }];
      mockModel.find.mockReturnValue({
        lean: jest.fn().mockReturnValue(createExecChain(policies)),
      });

      const result = await service.findAll('test-tenant');

      expect(mockModel.find).toHaveBeenCalledWith({ tenantId: 'test-tenant' });
      expect(result).toEqual(policies);
    });
  });

  describe('findOne', () => {
    it('should return the policy when found', async () => {
      const policy = { _id: 'p1', name: 'Policy A' };
      mockModel.findOne.mockReturnValue({
        lean: jest.fn().mockReturnValue(createExecChain(policy)),
      });

      const result = await service.findOne('test-tenant', 'p1');

      expect(mockModel.findOne).toHaveBeenCalledWith({ _id: 'p1', tenantId: 'test-tenant' });
      expect(result).toEqual(policy);
    });

    it('should throw NotFoundException when not found', async () => {
      mockModel.findOne.mockReturnValue({
        lean: jest.fn().mockReturnValue(createExecChain(null)),
      });

      await expect(service.findOne('test-tenant', 'nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('should update and return the policy', async () => {
      const updated = { _id: 'p1', name: 'Updated Policy' };
      mockModel.findOneAndUpdate.mockReturnValue({
        lean: jest.fn().mockReturnValue(createExecChain(updated)),
      });

      const result = await service.update('test-tenant', 'p1', { name: 'Updated Policy' } as any);

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'p1', tenantId: 'test-tenant' },
        { $set: { name: 'Updated Policy' } },
        { new: true },
      );
      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException when policy does not exist', async () => {
      mockModel.findOneAndUpdate.mockReturnValue({
        lean: jest.fn().mockReturnValue(createExecChain(null)),
      });

      await expect(
        service.update('test-tenant', 'nonexistent', { name: 'test' } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('answers 409 when the new name is taken by another policy', async () => {
      mockModel.findOneAndUpdate.mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest
            .fn()
            .mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 })),
        }),
      });

      await expect(service.update('test-tenant', 'p1', { name: 'Taken' })).rejects.toThrow(
        new ConflictException(
          'A credential policy named "Taken" already exists. Choose another name.',
        ),
      );
    });
  });

  describe('delete', () => {
    it('should delete the policy', async () => {
      mockModel.deleteOne.mockResolvedValue({ deletedCount: 1 });

      await expect(service.delete('test-tenant', 'p1')).resolves.toBeUndefined();
      expect(mockModel.deleteOne).toHaveBeenCalledWith({ _id: 'p1', tenantId: 'test-tenant' });
    });

    it('should throw NotFoundException when not found', async () => {
      mockModel.deleteOne.mockResolvedValue({ deletedCount: 0 });

      await expect(service.delete('test-tenant', 'nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('resolvePolicy', () => {
    it('should return the most specific policy matching connector type', async () => {
      const policies = [
        {
          _id: 'general',
          isActive: true,
          targetScope: {},
          rotationPolicy: { enabled: true },
        },
        {
          _id: 'entra-specific',
          isActive: true,
          targetScope: { connectorTypes: ['entra-id'] },
          rotationPolicy: { enabled: true },
        },
      ];
      mockModel.find.mockReturnValue({
        lean: jest.fn().mockReturnValue(createExecChain(policies)),
      });

      const result = await service.resolvePolicy('test-tenant', 'entra-id');

      expect(result?._id).toBe('entra-specific');
    });

    it('should return wildcard policy when no specific match', async () => {
      const policies = [
        {
          _id: 'general',
          isActive: true,
          targetScope: {},
          rotationPolicy: { enabled: true },
        },
      ];
      mockModel.find.mockReturnValue({
        lean: jest.fn().mockReturnValue(createExecChain(policies)),
      });

      const result = await service.resolvePolicy('test-tenant', 'ad');

      expect(result?._id).toBe('general');
    });

    it('should return null when no policies match', async () => {
      const policies = [
        {
          _id: 'entra-only',
          isActive: true,
          targetScope: { connectorTypes: ['entra-id'] },
          rotationPolicy: { enabled: true },
        },
      ];
      mockModel.find.mockReturnValue({
        lean: jest.fn().mockReturnValue(createExecChain(policies)),
      });

      const result = await service.resolvePolicy('test-tenant', 'ad');

      expect(result).toBeNull();
    });

    it('should prefer connector+employment match over connector-only', async () => {
      const policies = [
        {
          _id: 'connector-only',
          isActive: true,
          targetScope: { connectorTypes: ['entra-id'] },
        },
        {
          _id: 'connector-and-emp',
          isActive: true,
          targetScope: { connectorTypes: ['entra-id'], employmentTypes: ['FULL_TIME'] },
        },
      ];
      mockModel.find.mockReturnValue({
        lean: jest.fn().mockReturnValue(createExecChain(policies)),
      });

      const result = await service.resolvePolicy('test-tenant', 'entra-id', 'FULL_TIME');

      expect(result?._id).toBe('connector-and-emp');
    });

    // Hunt 06 F10 (a): a contractor-only policy applied to every identity without a type
    it('does not apply a policy scoped to employment types to an identity without one', async () => {
      const policies = [
        {
          _id: '000000000000000000000001',
          isActive: true,
          targetScope: { employmentTypes: ['CONTRACTOR'] },
        },
        { _id: '000000000000000000000002', isActive: true, targetScope: {} },
      ];
      mockModel.find.mockReturnValue({
        lean: jest.fn().mockReturnValue(createExecChain(policies)),
      });

      expect((await service.resolvePolicy('test-tenant', 'ad'))?._id).toBe(
        '000000000000000000000002',
      );

      mockModel.find.mockReturnValue({
        lean: jest.fn().mockReturnValue(createExecChain([policies[0]])),
      });
      expect(await service.resolvePolicy('test-tenant', 'ad')).toBeNull();
    });

    it('picks the oldest of two equally specific policies, whatever order MongoDB returns', async () => {
      const older = { _id: '000000000000000000000001', isActive: true, targetScope: {} };
      const newer = { _id: '000000000000000000000002', isActive: true, targetScope: {} };
      for (const order of [
        [older, newer],
        [newer, older],
      ]) {
        mockModel.find.mockReturnValue({
          lean: jest.fn().mockReturnValue(createExecChain(order)),
        });
        expect((await service.resolvePolicy('test-tenant', 'ad'))?._id).toBe(older._id);
      }
    });
  });
});
