import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ScimTokenService } from './scim-token.service';
import { ScimToken } from './schemas/scim-token.schema';
import { MachineIdentitySyncService } from '../identity/machine-identity-sync.service';

describe('ScimTokenService', () => {
  let service: ScimTokenService;
  let tokenModel: {
    create: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    updateOne: jest.Mock;
    findByIdAndUpdate: jest.Mock;
  };

  const _mockExec = (value: unknown) => ({
    exec: jest.fn().mockResolvedValue(value),
  });

  const mockFindOneWithSetOptions = (value: unknown) => ({
    setOptions: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value),
  });

  const mockUpdateOneWithSetOptions = () => ({
    setOptions: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  });

  beforeEach(async () => {
    const chain = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn(),
    };
    const mockFindByIdAndUpdate = () => ({
      exec: jest.fn().mockResolvedValue({ _id: 'tok-123', status: 'revoked' }),
    });
    tokenModel = {
      create: jest.fn(),
      findOne: jest.fn().mockReturnValue(mockFindOneWithSetOptions(null)),
      find: jest.fn().mockReturnValue(chain),
      updateOne: jest.fn().mockReturnValue(mockUpdateOneWithSetOptions()),
      findByIdAndUpdate: jest.fn().mockReturnValue(mockFindByIdAndUpdate()),
      ...chain,
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScimTokenService,
        {
          provide: getModelToken(ScimToken.name),
          useValue: tokenModel,
        },
        {
          provide: MachineIdentitySyncService,
          useValue: { syncScimTokenToIdentity: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<ScimTokenService>(ScimTokenService);
    jest.clearAllMocks();
  });

  describe('generateToken', () => {
    it('should create token, return plaintext, store hash (hash ≠ plaintext)', async () => {
      const doc = {
        _id: { toString: () => 'tok-123' },
        name: 'Workday SCIM',
      };
      tokenModel.create.mockResolvedValue(doc);

      const result = await service.generateToken('Workday SCIM', 'admin-1');

      expect(result.token).toBeDefined();
      expect(result.id).toBe('tok-123');
      expect(result.name).toBe('Workday SCIM');

      expect(tokenModel.create).toHaveBeenCalled();
      const createArg = tokenModel.create.mock.calls[0][0];
      expect(createArg.tokenHash).toBeDefined();
      expect(createArg.tokenHash).not.toBe(result.token);
      expect(createArg.tokenHash).toHaveLength(64);
      expect(createArg.name).toBe('Workday SCIM');
      expect(createArg.createdBy).toBe('admin-1');
      expect(createArg.status).toBe('active');
    });

    it('should use custom scopes and expiresAt', async () => {
      const doc = { _id: { toString: () => 'tok-1' }, name: 'Okta' };
      tokenModel.create.mockResolvedValue(doc);

      await service.generateToken('Okta', 'admin', ['Users:read'], new Date('2026-12-31'));

      const createArg = tokenModel.create.mock.calls[0][0];
      expect(createArg.scopes).toEqual(['Users:read']);
      expect(createArg.expiresAt).toEqual(new Date('2026-12-31'));
    });
  });

  describe('validateToken', () => {
    it('should return metadata including tenantId for valid active token', async () => {
      const doc = {
        _id: { toString: () => 'tok-1' },
        name: 'Test',
        status: 'active',
        scopes: ['Users:read', 'Groups:write'],
        tenantId: 'tenant-acme',
      };
      tokenModel.findOne.mockReturnValue(mockFindOneWithSetOptions(doc));
      tokenModel.updateOne.mockReturnValue(mockUpdateOneWithSetOptions());

      const result = await service.validateToken('any-token-string');

      expect(result).toEqual({
        id: 'tok-1',
        name: 'Test',
        scopes: ['Users:read', 'Groups:write'],
        tenantId: 'tenant-acme',
      });
      expect(tokenModel.updateOne).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ $set: { lastUsedAt: expect.any(Date) } }),
      );
    });

    it('should return null for expired token', async () => {
      const doc = {
        _id: { toString: () => 'tok-1' },
        status: 'active',
        expiresAt: new Date('2020-01-01'),
      };
      tokenModel.findOne.mockReturnValue(mockFindOneWithSetOptions(doc));

      const result = await service.validateToken('token');

      expect(result).toBeNull();
      expect(tokenModel.updateOne).not.toHaveBeenCalled();
    });

    it('should return null for revoked token', async () => {
      const doc = { _id: 'tok-1', status: 'revoked' };
      tokenModel.findOne.mockReturnValue(mockFindOneWithSetOptions(doc));

      const result = await service.validateToken('token');

      expect(result).toBeNull();
    });

    it('should return null for non-existent token', async () => {
      tokenModel.findOne.mockReturnValue(mockFindOneWithSetOptions(null));

      const result = await service.validateToken('unknown-token');

      expect(result).toBeNull();
    });
  });

  describe('validateToken updates lastUsedAt', () => {
    it('should update lastUsedAt on successful validation', async () => {
      const doc = { _id: { toString: () => 'tok-1' }, name: 'T', status: 'active', tenantId: 't1' };
      tokenModel.findOne.mockReturnValue(mockFindOneWithSetOptions(doc));
      tokenModel.updateOne.mockReturnValue(mockUpdateOneWithSetOptions());

      await service.validateToken('valid-token');

      expect(tokenModel.updateOne).toHaveBeenCalledWith(
        { _id: doc._id },
        expect.objectContaining({ $set: { lastUsedAt: expect.any(Date) } }),
      );
    });
  });

  describe('revokeToken', () => {
    // Package HX-B's follow-up: an unknown id answered 204, though the route documents 404
    it('answers 404 for a token that is not there (another tenant, or none)', async () => {
      tokenModel.findByIdAndUpdate.mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(null) });

      await expect(service.revokeToken('tok-404')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should set status to revoked', async () => {
      await service.revokeToken('tok-123');

      expect(tokenModel.findByIdAndUpdate).toHaveBeenCalledWith(
        'tok-123',
        { $set: { status: 'revoked' } },
        { new: true },
      );
    });
  });

  describe('listTokens', () => {
    it('should return metadata only (no tokenHash)', async () => {
      const docs = [
        {
          _id: { toString: () => 'tok-1' },
          name: 'A',
          createdBy: 'admin',
          createdAt: new Date('2024-01-01'),
          lastUsedAt: new Date('2024-01-15'),
          status: 'active',
          scopes: ['Users:read'],
        },
      ];
      (tokenModel as any).exec.mockResolvedValue(docs);

      const result = await service.listTokens();

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('id', 'tok-1');
      expect(result[0]).toHaveProperty('name', 'A');
      expect(result[0]).not.toHaveProperty('tokenHash');
    });
  });
});
