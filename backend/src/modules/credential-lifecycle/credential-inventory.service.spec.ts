import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { CredentialInventoryService } from './credential-inventory.service';
import { CredentialInventory } from './schemas/credential-inventory.schema';

describe('CredentialInventoryService', () => {
  let service: CredentialInventoryService;

  const createExecChain = (result: unknown) => ({
    exec: jest.fn().mockResolvedValue(result),
  });

  const mockModel = {
    findOneAndUpdate: jest.fn().mockReturnValue(createExecChain({})),
    find: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue(createExecChain([])),
      limit: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue(createExecChain([])),
      }),
    }),
    findOne: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue(createExecChain(null)),
    }),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    aggregate: jest.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        CredentialInventoryService,
        { provide: getModelToken(CredentialInventory.name), useValue: mockModel },
      ],
    }).compile();

    service = module.get(CredentialInventoryService);
  });

  describe('upsert', () => {
    it('should call findOneAndUpdate with correct filter and upsert flag', async () => {
      const tenantId = 'test-tenant';
      const identityId = 'id-123';
      const targetSystem = 'entra-id';
      const externalId = 'ext-456';
      const update = { password: { status: 'COMPLIANT' as const } };

      mockModel.findOneAndUpdate.mockReturnValue(
        createExecChain({
          tenantId,
          identityId,
          targetSystem,
          externalId,
        }),
      );

      const result = await service.upsert(tenantId, identityId, targetSystem, externalId, update);

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId, identityId, targetSystem },
        expect.objectContaining({
          $set: expect.objectContaining({ externalId }),
          $setOnInsert: { tenantId, identityId, targetSystem },
        }),
        { upsert: true, new: true, lean: false },
      );
      expect(result).toBeDefined();
    });
  });

  describe('findByIdentity', () => {
    it('should query by tenantId and identityId', async () => {
      const mockLean = jest.fn().mockReturnValue(createExecChain([{ identityId: 'id-1' }]));
      mockModel.find.mockReturnValue({ lean: mockLean });

      const result = await service.findByIdentity('test-tenant', 'id-1');

      expect(mockModel.find).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
        identityId: 'id-1',
      });
      expect(result).toEqual([{ identityId: 'id-1' }]);
    });
  });

  describe('findExpiring', () => {
    it('should query credentials with nextRotation <= beforeDate, most overdue first', async () => {
      const beforeDate = new Date('2026-03-01');
      const mockLimit = jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue(createExecChain([{ identityId: 'id-1' }])),
      });
      const mockSort = jest.fn().mockReturnValue({ limit: mockLimit });
      mockModel.find.mockReturnValue({ sort: mockSort });

      const result = await service.findExpiring('test-tenant', beforeDate, 50);

      expect(mockModel.find).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
        'password.nextRotation': { $lte: beforeDate },
        'password.status': { $ne: 'UNKNOWN' },
      });
      expect(mockSort).toHaveBeenCalledWith({ 'password.nextRotation': 1, _id: 1 });
      expect(mockLimit).toHaveBeenCalledWith(50);
      expect(result).toEqual([{ identityId: 'id-1' }]);
    });
  });

  describe('findByStatus', () => {
    it('should query by password status, earliest due first', async () => {
      const mockLimit = jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue(createExecChain([])),
      });
      const mockSort = jest.fn().mockReturnValue({ limit: mockLimit });
      mockModel.find.mockReturnValue({ sort: mockSort });

      await service.findByStatus('test-tenant', 'EXPIRED', 100);

      expect(mockModel.find).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
        'password.status': 'EXPIRED',
      });
      expect(mockSort).toHaveBeenCalledWith({ 'password.nextRotation': 1, _id: 1 });
      expect(mockLimit).toHaveBeenCalledWith(100);
    });
  });

  describe('findObservations', () => {
    // The refresh counts the rows whose status a run changed (credential.inventory_updated)
    it('reads each row of the tenant with its key, when it was last read and its status', async () => {
      const mockLean = jest.fn().mockReturnValue(createExecChain([{ identityId: 'id-1' }]));
      mockModel.find.mockReturnValue({ lean: mockLean });

      const result = await service.findObservations('test-tenant');

      expect(mockModel.find).toHaveBeenCalledWith(
        { tenantId: 'test-tenant' },
        { identityId: 1, targetSystem: 1, observedAt: 1, 'password.status': 1 },
      );
      expect(result).toEqual([{ identityId: 'id-1' }]);
    });
  });

  describe('deleteByIds', () => {
    it('deletes the given rows of the tenant and answers how many', async () => {
      const deleteMany = jest.fn().mockResolvedValue({ deletedCount: 2 });
      (mockModel as Record<string, unknown>).deleteMany = deleteMany;

      const ids = [new Types.ObjectId(), new Types.ObjectId()];
      expect(await service.deleteByIds('test-tenant', ids)).toBe(2);
      expect(deleteMany).toHaveBeenCalledWith({ tenantId: 'test-tenant', _id: { $in: ids } });
    });

    it('sends nothing for no rows', async () => {
      const deleteMany = jest.fn();
      (mockModel as Record<string, unknown>).deleteMany = deleteMany;

      expect(await service.deleteByIds('test-tenant', [])).toBe(0);
      expect(deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('recalculateStatuses', () => {
    it('should mark expired and expiring-soon credentials', async () => {
      mockModel.updateMany
        .mockResolvedValueOnce({ modifiedCount: 3 }) // expired
        .mockResolvedValueOnce({ modifiedCount: 5 }); // expiring soon

      const now = new Date('2026-03-01T00:00:00Z');
      const result = await service.recalculateStatuses('test-tenant', now, 14);

      expect(result).toEqual({ updated: 8 });
      expect(mockModel.updateMany).toHaveBeenCalledTimes(2);
      // Due now or earlier: expired
      expect(mockModel.updateMany).toHaveBeenNthCalledWith(
        1,
        {
          tenantId: 'test-tenant',
          'password.nextRotation': { $lte: now },
          'password.status': { $in: ['COMPLIANT', 'EXPIRING_SOON'] },
        },
        { $set: { 'password.status': 'EXPIRED' } },
      );
      // Due within the 14 warning days: expiring soon
      expect(mockModel.updateMany).toHaveBeenNthCalledWith(
        2,
        {
          tenantId: 'test-tenant',
          'password.nextRotation': { $gt: now, $lte: new Date('2026-03-15T00:00:00Z') },
          'password.status': 'COMPLIANT',
        },
        { $set: { 'password.status': 'EXPIRING_SOON' } },
      );
    });

    it('should return zero when no credentials need updating', async () => {
      mockModel.updateMany
        .mockResolvedValueOnce({ modifiedCount: 0 })
        .mockResolvedValueOnce({ modifiedCount: 0 });

      const result = await service.recalculateStatuses('test-tenant', new Date('2026-03-01'), 14);

      expect(result).toEqual({ updated: 0 });
    });
  });

  describe('getComplianceSummary', () => {
    it('should aggregate counts by status', async () => {
      mockModel.aggregate.mockResolvedValue([
        { _id: 'COMPLIANT', count: 10 },
        { _id: 'EXPIRING_SOON', count: 3 },
        { _id: 'EXPIRED', count: 1 },
      ]);

      const result = await service.getComplianceSummary('test-tenant');

      expect(result).toEqual({
        compliant: 10,
        expiringSoon: 3,
        expired: 1,
        unknown: 0,
        total: 14,
      });
    });

    it('should return all zeros for empty collection', async () => {
      mockModel.aggregate.mockResolvedValue([]);

      const result = await service.getComplianceSummary('test-tenant');

      expect(result).toEqual({
        compliant: 0,
        expiringSoon: 0,
        expired: 0,
        unknown: 0,
        total: 0,
      });
    });
  });
});
