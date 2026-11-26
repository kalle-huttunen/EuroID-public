import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken, getConnectionToken } from '@nestjs/mongoose';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TenantService } from './tenant.service';
import { Tenant } from './schemas/tenant.schema';
import { TenantStatusService } from './tenant-status.service';

describe('TenantService', () => {
  let service: TenantService;
  let tenantModel: any;
  const tenantStatus = { forget: jest.fn() };

  const mockTenant = {
    tenantId: 'test-tenant',
    name: 'Test Tenant',
    status: 'active',
    createdBy: 'admin',
    toObject: () => ({}),
  };

  const execMock = (result: unknown) => () => Promise.resolve(result);

  beforeEach(async () => {
    tenantStatus.forget.mockClear();
    const mockModel = {
      findOne: jest.fn().mockReturnValue({
        exec: execMock(null),
      }),
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([mockTenant]),
        }),
      }),
      create: jest.fn().mockResolvedValue(mockTenant),
      findOneAndUpdate: jest.fn().mockReturnValue({
        exec: execMock(mockTenant),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantService,
        {
          provide: getModelToken(Tenant.name),
          useValue: mockModel,
        },
        {
          provide: getConnectionToken(),
          useValue: { db: { collections: jest.fn().mockResolvedValue([]) } },
        },
        { provide: TenantStatusService, useValue: tenantStatus },
      ],
    }).compile();

    service = module.get<TenantService>(TenantService);
    tenantModel = module.get(getModelToken(Tenant.name));
  });

  it('should create a tenant', async () => {
    const result = await service.create({
      tenantId: 'test-tenant',
      name: 'Test Tenant',
      createdBy: 'admin',
    });

    expect(result).toEqual(mockTenant);
    expect(tenantModel.create).toHaveBeenCalledWith({
      tenantId: 'test-tenant',
      name: 'Test Tenant',
      createdBy: 'admin',
      status: 'active',
    });
  });

  it('should throw ConflictException when tenant already exists', async () => {
    (tenantModel.findOne as jest.Mock).mockImplementation(() => ({
      exec: jest.fn().mockResolvedValue(mockTenant),
    }));

    await expect(
      service.create({
        tenantId: 'test-tenant',
        name: 'Test Tenant',
        createdBy: 'admin',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('should findAll tenants', async () => {
    const result = await service.findAll();
    expect(result).toEqual([mockTenant]);
    // Every tenant, ordered by tenantId.
    expect(tenantModel.find).toHaveBeenCalledWith();
    expect(tenantModel.find.mock.results[0].value.sort).toHaveBeenCalledWith({ tenantId: 1 });
  });

  it('should findById return tenant', async () => {
    (tenantModel.findOne as jest.Mock).mockImplementation(() => ({
      exec: jest.fn().mockResolvedValue(mockTenant),
    }));

    const result = await service.findById('test-tenant');
    expect(result).toEqual(mockTenant);
  });

  it('should findById throw NotFoundException when not found', async () => {
    (tenantModel.findOne as jest.Mock).mockImplementation(() => ({
      exec: jest.fn().mockResolvedValue(null),
    }));

    await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
  });

  it('should suspend tenant', async () => {
    // The stored tenant answers as MongoDB does: after the update only with { new: true }.
    (tenantModel.findOneAndUpdate as jest.Mock).mockImplementation(
      (_filter: unknown, update: { $set: object }, options?: { new?: boolean }) => ({
        exec: jest
          .fn()
          .mockResolvedValue(options?.new ? { ...mockTenant, ...update.$set } : mockTenant),
      }),
    );

    const result = await service.suspend('test-tenant');
    expect(tenantModel.findOneAndUpdate).toHaveBeenCalledWith(
      { tenantId: 'test-tenant' },
      { $set: { status: 'suspended' } },
      { new: true },
    );
    expect(result.status).toBe('suspended');
    // The suspension applies on this instance from the next request, not after the cache time.
    expect(tenantStatus.forget).toHaveBeenCalledWith('test-tenant');
  });
});
