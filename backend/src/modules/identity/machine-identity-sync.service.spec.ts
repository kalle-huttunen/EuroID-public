import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { MachineIdentitySyncService } from './machine-identity-sync.service';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

describe('MachineIdentitySyncService', () => {
  let service: MachineIdentitySyncService;
  let mockIdentityModel: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockIdentityModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue({ _id: 'identity-1' }),
    };

    const module = await Test.createTestingModule({
      providers: [
        MachineIdentitySyncService,
        {
          provide: getModelToken('Identity'),
          useValue: mockIdentityModel,
        },
      ],
    }).compile();

    service = module.get(MachineIdentitySyncService);
  });

  describe('syncAdminToIdentity', () => {
    it('should upsert identity with correct profile', async () => {
      const admin = {
        _id: { toString: () => 'admin-1' },
        tenantId: 'test-tenant',
        name: 'Admin User',
        email: 'admin@example.com',
        isActive: true,
      };

      await service.syncAdminToIdentity(admin as any);

      expect(mockIdentityModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'test-tenant' }),
        expect.objectContaining({
          $set: expect.objectContaining({
            profile: expect.objectContaining({
              email: 'admin@example.com',
              firstName: 'Admin',
              lastName: 'User',
            }),
          }),
        }),
        expect.objectContaining({ upsert: true, new: true }),
      );
    });

    it('should skip when admin has no email', async () => {
      const admin = {
        _id: { toString: () => 'admin-2' },
        tenantId: 'test-tenant',
        name: 'No Email Admin',
        email: undefined,
        isActive: true,
      };

      await service.syncAdminToIdentity(admin as any);

      expect(mockIdentityModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should set SUSPENDED status when admin is not active', async () => {
      const admin = {
        _id: { toString: () => 'admin-3' },
        tenantId: 'test-tenant',
        name: 'Inactive Admin',
        email: 'inactive@example.com',
        isActive: false,
      };

      await service.syncAdminToIdentity(admin as any);

      expect(mockIdentityModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          $set: expect.objectContaining({
            profile: expect.objectContaining({
              status: 'SUSPENDED',
            }),
          }),
        }),
        expect.anything(),
      );
    });
  });

  describe('syncScimTokenToIdentity', () => {
    it('should upsert identity with service account profile', async () => {
      const token = {
        _id: { toString: () => 'token-1' },
        tenantId: 'test-tenant',
        name: 'SCIM Token',
        status: 'active' as const,
      };

      await service.syncScimTokenToIdentity(token as any);

      expect(mockIdentityModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'test-tenant' }),
        expect.objectContaining({
          $set: expect.objectContaining({
            profile: expect.objectContaining({
              displayName: 'SCIM Token',
            }),
          }),
        }),
        expect.objectContaining({ upsert: true, new: true }),
      );
    });

    it('should set SUSPENDED when token status is not active', async () => {
      const token = {
        _id: { toString: () => 'token-2' },
        tenantId: 'test-tenant',
        name: 'Revoked Token',
        status: 'revoked' as const,
      };

      await service.syncScimTokenToIdentity(token as any);

      expect(mockIdentityModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          $set: expect.objectContaining({
            profile: expect.objectContaining({
              status: 'SUSPENDED',
            }),
          }),
        }),
        expect.anything(),
      );
    });
  });
});
