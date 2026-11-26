/**
 * Unit tests for IdentityQueryService filter validation (NoSQL injection fix).
 */
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException } from '@nestjs/common';
import { IdentityQueryService } from './identity-query.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { createMockLoggerFactory, withTestTenant } from '@testing';

const chainable = {
  skip: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  lean: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue([]),
};

const mockIdentityModel = {
  find: jest.fn().mockReturnValue(chainable),
  countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(0) }),
};

describe('IdentityQueryService', () => {
  let service: IdentityQueryService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const { factory: loggerFactory } = createMockLoggerFactory();

    const module = await Test.createTestingModule({
      providers: [
        IdentityQueryService,
        { provide: getModelToken('Identity'), useValue: mockIdentityModel },
        { provide: LoggerFactoryService, useValue: loggerFactory },
      ],
    }).compile();

    service = module.get(IdentityQueryService);
  });

  describe('findAll', () => {
    const doc = {
      _id: '1',
      profile: { email: 'a@b.com' },
      sources: [{ sourceName: 'github', externalId: 'g-1', sourceRole: 'target' }],
      provisioning: [{ targetSystem: 'github', status: 'SYNCED' }],
    };

    it('adds the provisioning entries only when asked (access review: account items)', async () => {
      await withTestTenant(async () => {
        chainable.exec.mockResolvedValueOnce([doc]).mockResolvedValueOnce([doc]);
        const [plain] = await service.findAll({ includeSources: true });
        const [withProvisioning] = await service.findAll({ includeProvisioning: true });
        expect(plain.provisioning).toBeUndefined();
        expect(plain.sources).toEqual(doc.sources);
        expect(withProvisioning.provisioning).toEqual(doc.provisioning);
        expect(withProvisioning.sources).toBeUndefined();
      });
    });
  });

  describe('findAllPaginated filter validation', () => {
    it('allows whitelisted filter keys and merges correctly', async () => {
      await withTestTenant(async () => {
        mockIdentityModel.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(1) });
        chainable.exec.mockResolvedValueOnce([{ _id: '1', profile: { email: 'a@b.com' } }]);

        const [data, total] = await service.findAllPaginated(0, 10, {
          filter: { 'profile.email': 'a@b.com' },
        });

        expect(mockIdentityModel.find).toHaveBeenCalledWith(
          expect.objectContaining({ 'profile.email': 'a@b.com' }),
        );
        expect(data).toHaveLength(1);
        expect(total).toBe(1);
      });
    });

    it('rejects $ne as top-level filter key with 400', async () => {
      await withTestTenant(async () => {
        await expect(
          service.findAllPaginated(0, 10, { filter: { $ne: 'other-tenant' } as any }),
        ).rejects.toThrow(BadRequestException);
        await expect(
          service.findAllPaginated(0, 10, { filter: { $ne: 'other-tenant' } as any }),
        ).rejects.toThrow(/Invalid filter key: \$ne/);
        expect(mockIdentityModel.find).not.toHaveBeenCalled();
      });
    });

    it('rejects $regex as top-level filter key with 400', async () => {
      await withTestTenant(async () => {
        await expect(
          service.findAllPaginated(0, 10, { filter: { $regex: '.*' } as any }),
        ).rejects.toThrow(BadRequestException);
        await expect(
          service.findAllPaginated(0, 10, { filter: { $regex: '.*' } as any }),
        ).rejects.toThrow(/Invalid filter key: \$regex/);
        expect(mockIdentityModel.find).not.toHaveBeenCalled();
      });
    });

    it('rejects $where as top-level filter key with 400', async () => {
      await withTestTenant(async () => {
        await expect(
          service.findAllPaginated(0, 10, { filter: { $where: '1==1' } as any }),
        ).rejects.toThrow(BadRequestException);
        await expect(
          service.findAllPaginated(0, 10, { filter: { $where: '1==1' } as any }),
        ).rejects.toThrow(/Invalid filter key: \$where/);
        expect(mockIdentityModel.find).not.toHaveBeenCalled();
      });
    });

    it('rejects tenantId in filter (not in whitelist) with 400', async () => {
      await withTestTenant(async () => {
        await expect(
          service.findAllPaginated(0, 10, {
            filter: { tenantId: { $ne: 'other-tenant' } },
          }),
        ).rejects.toThrow(BadRequestException);
        await expect(
          service.findAllPaginated(0, 10, {
            filter: { tenantId: 'override-tenant' },
          }),
        ).rejects.toThrow(/Invalid filter key: tenantId/);
        expect(mockIdentityModel.find).not.toHaveBeenCalled();
      });
    });

    it('rejects nested $ operators in filter values with 400', async () => {
      await withTestTenant(async () => {
        await expect(
          service.findAllPaginated(0, 10, {
            filter: { email: { $regex: '.*' } },
          }),
        ).rejects.toThrow(BadRequestException);
        await expect(
          service.findAllPaginated(0, 10, {
            filter: { email: { $regex: '.*' } },
          }),
        ).rejects.toThrow(/Filter value for "email" must be a primitive or array of primitives/);
        expect(mockIdentityModel.find).not.toHaveBeenCalled();
      });
    });

    it('skips validation when trustedFilter is true and merges filter including $ operators', async () => {
      await withTestTenant(async () => {
        mockIdentityModel.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });
        chainable.exec.mockResolvedValueOnce([]);

        await service.findAllPaginated(0, 50, {
          filter: {
            $or: [{ 'profile.departmentName': 'Eng' }, { 'profile.departmentCode': 'Eng' }],
            'profile.jobTitle': 'Engineer',
            _id: { $ne: 'exclude-id' },
          },
          trustedFilter: true,
        });

        expect(mockIdentityModel.find).toHaveBeenCalledWith(
          expect.objectContaining({
            $or: expect.any(Array),
            'profile.jobTitle': 'Engineer',
            _id: { $ne: 'exclude-id' },
          }),
        );
      });
    });
  });
});
