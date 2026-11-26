import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { EntitlementCatalogService } from './entitlement-catalog.service';
import { EntitlementCatalog } from './schemas/entitlement-catalog.schema';
import { withTestTenant } from '@testing/test-helpers';
import type { Entitlement } from '@shared/interfaces/provisioning.interface';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';

describe('EntitlementCatalogService', () => {
  let service: EntitlementCatalogService;
  let mockCatalogModel: {
    find: jest.Mock;
    findOne: jest.Mock;
    findByIdAndUpdate: jest.Mock;
    bulkWrite: jest.Mock;
    deleteMany: jest.Mock;
  };
  const events = { emit: jest.fn() };

  beforeEach(async () => {
    const findChain = {
      lean: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    mockCatalogModel = {
      find: jest.fn().mockReturnValue(findChain),
      findOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      findByIdAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      bulkWrite: jest.fn().mockResolvedValue({ modifiedCount: 0, upsertedCount: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntitlementCatalogService,
        { provide: getModelToken(EntitlementCatalog.name), useValue: mockCatalogModel },
        { provide: DomainEventEmitterService, useValue: events },
      ],
    }).compile();

    service = module.get<EntitlementCatalogService>(EntitlementCatalogService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('absorbDiscovered', () => {
    it('performs at most 3 DB operations for 100 entitlements (find, bulkWrite, deleteMany)', async () => {
      const entitlements: Entitlement[] = Array.from({ length: 100 }, (_, i) => ({
        nativeId: `id-${i}`,
        name: `Group ${i}`,
        type: 'Group' as const,
      }));

      await withTestTenant(async () => {
        await service.absorbDiscovered('entra-id', entitlements);
      });

      expect(mockCatalogModel.find).toHaveBeenCalledTimes(1);
      expect(mockCatalogModel.bulkWrite).toHaveBeenCalledTimes(1);
      expect(mockCatalogModel.deleteMany).toHaveBeenCalledTimes(1);
    });

    // The access graph's event sync names entitlements and their applications from it
    it('emits discovery.completed with the system and counts once the catalog is written', async () => {
      mockCatalogModel.deleteMany.mockResolvedValue({ deletedCount: 2 });
      const entitlements: Entitlement[] = [
        { nativeId: 'grp-1', name: 'Engineers', type: 'Group' },
        { nativeId: 'lic-1', name: 'Office E5', type: 'License' },
      ];

      await withTestTenant(async () => {
        await service.absorbDiscovered('entra-id', entitlements);
      });

      expect(events.emit).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledWith(
        DomainEventType.DISCOVERY_COMPLETED,
        'entra-id',
        { system: 'entra-id', discovered: 2, removed: 2 },
        expect.objectContaining({ tenantId: expect.any(String) }),
      );
      const emittedAt = events.emit.mock.invocationCallOrder[0];
      expect(mockCatalogModel.bulkWrite.mock.invocationCallOrder[0]).toBeLessThan(emittedAt);
      expect(mockCatalogModel.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(emittedAt);
    });

    it('chunks large payloads and performs multiple bulkWrite calls', async () => {
      const entitlements: Entitlement[] = Array.from({ length: 12_000 }, (_, i) => ({
        nativeId: `id-${i}`,
        name: `Group ${i}`,
        type: 'Group' as const,
      }));

      await withTestTenant(async () => {
        await service.absorbDiscovered('entra-id', entitlements);
      });

      expect(mockCatalogModel.find).toHaveBeenCalledTimes(1);
      expect(mockCatalogModel.bulkWrite).toHaveBeenCalledTimes(3);
      expect(mockCatalogModel.bulkWrite).toHaveBeenCalledWith(expect.any(Array), {
        ordered: false,
      });
    });

    it('preserves POLICY origin when existing doc has POLICY', async () => {
      const existing = {
        _id: 'existing-id',
        nativeId: 'guid-123',
        name: 'All Staff',
        type: 'Group',
        origin: 'POLICY',
        governanceLevel: 'STRICT',
      };
      (mockCatalogModel.find as jest.Mock).mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([existing]),
      });

      const entitlements: Entitlement[] = [
        { nativeId: 'guid-123', name: 'All Staff', type: 'Group' },
      ];

      await withTestTenant(async () => {
        await service.absorbDiscovered('entra-id', entitlements);
      });

      const bulkOps = mockCatalogModel.bulkWrite.mock.calls[0][0];
      expect(bulkOps).toHaveLength(1);
      expect(bulkOps[0].updateOne.update.$set.origin).toBe('POLICY');
      expect(bulkOps[0].updateOne.update.$set.governanceLevel).toBe('STRICT');
    });

    it('tags well-known groups as PROTECTED during absorb', async () => {
      const entitlements: Entitlement[] = [
        { nativeId: 'id-1', name: 'All Users', type: 'Group' },
        { nativeId: 'id-2', name: 'Everyone', type: 'Group' },
        { nativeId: 'id-3', name: 'Custom Group', type: 'Group' },
      ];
      (mockCatalogModel.find as jest.Mock).mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      });

      await withTestTenant(async () => {
        await service.absorbDiscovered('entra-id', entitlements);
      });

      const bulkOps = mockCatalogModel.bulkWrite.mock.calls[0][0];
      const allUsersOp = bulkOps.find(
        (op: any) => op.updateOne?.update?.$set?.name === 'All Users',
      );
      const everyoneOp = bulkOps.find((op: any) => op.updateOne?.update?.$set?.name === 'Everyone');
      const customOp = bulkOps.find(
        (op: any) => op.updateOne?.update?.$set?.name === 'Custom Group',
      );
      expect(allUsersOp.updateOne.update.$set.governanceTags).toContain('PROTECTED');
      expect(everyoneOp.updateOne.update.$set.governanceTags).toContain('PROTECTED');
      expect(customOp.updateOne.update.$set.governanceTags || []).not.toContain('PROTECTED');
    });

    it('persists PAM fields (adminTier, requiresAdminAccount, riskLevel) for DirectoryRole', async () => {
      const entitlements: Entitlement[] = [
        {
          nativeId: '62e90394-69f5-4237-9190-012177145e10',
          name: 'Global Administrator',
          type: 'DirectoryRole',
          adminTier: 'TIER_0',
          requiresAdminAccount: true,
          riskLevel: 'CRITICAL',
        },
      ];
      (mockCatalogModel.find as jest.Mock).mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      });

      await withTestTenant(async () => {
        await service.absorbDiscovered('entra-id', entitlements);
      });

      const bulkOps = mockCatalogModel.bulkWrite.mock.calls[0][0];
      expect(bulkOps).toHaveLength(1);
      const op = bulkOps[0];
      expect(op.updateOne.update.$set.adminTier).toBe('TIER_0');
      expect(op.updateOne.update.$set.requiresAdminAccount).toBe(true);
      expect(op.updateOne.update.$set.riskLevel).toBe('CRITICAL');
    });

    // The license forecast starts from the units in use (HX-F report follow-up)
    it("stores a license's units in use and enabled with when discovery read them", async () => {
      const entitlements: Entitlement[] = [
        {
          nativeId: 'ENTERPRISEPACK',
          name: 'ENTERPRISEPACK',
          type: 'License',
          licenseUnits: { consumed: 95, enabled: 100 },
        },
        { nativeId: 'grp-1', name: 'Engineers', type: 'Group' },
      ];

      await withTestTenant(async () => {
        await service.absorbDiscovered('entra-id', entitlements);
      });

      const [license, group] = mockCatalogModel.bulkWrite.mock.calls[0][0];
      expect(license.updateOne.update.$set.licenseUnits).toEqual({
        consumed: 95,
        enabled: 100,
        observedAt: expect.any(Date),
      });
      expect(group.updateOne.update.$set).not.toHaveProperty('licenseUnits');
    });
  });

  describe('isProtected', () => {
    it('returns true when entry has PROTECTED tag', async () => {
      (mockCatalogModel.findOne as jest.Mock).mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          governanceTags: ['PROTECTED'],
        }),
      });
      const result = await service.isProtected('entra-id', 'group-123');
      expect(result).toBe(true);
    });

    it('returns false when entry has no PROTECTED tag', async () => {
      (mockCatalogModel.findOne as jest.Mock).mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          governanceTags: ['MANDATORY'],
        }),
      });
      const result = await service.isProtected('entra-id', 'group-123');
      expect(result).toBe(false);
    });

    it('returns false when entry not found', async () => {
      (mockCatalogModel.findOne as jest.Mock).mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });
      const result = await service.isProtected('entra-id', 'unknown-id');
      expect(result).toBe(false);
    });
  });

  describe('getProtectedNativeIds', () => {
    it('returns Set of nativeIds that have PROTECTED tag', async () => {
      (mockCatalogModel.find as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([{ nativeId: 'id-1' }, { nativeId: 'id-3' }]),
      });
      const result = await service.getProtectedNativeIds('entra-id', ['id-1', 'id-2', 'id-3']);
      expect(result).toEqual(new Set(['id-1', 'id-3']));
      // Only entries of that system, among the ids asked for, tagged PROTECTED
      expect(mockCatalogModel.find).toHaveBeenCalledWith({
        system: 'entra-id',
        nativeId: { $in: ['id-1', 'id-2', 'id-3'] },
        governanceTags: 'PROTECTED',
      });
    });

    it('returns empty Set when no nativeIds provided', async () => {
      const result = await service.getProtectedNativeIds('entra-id', []);
      expect(result).toEqual(new Set());
    });
  });

  describe('setTags', () => {
    it('updates governanceTags and returns document', async () => {
      const updated = {
        _id: 'cat-1',
        nativeId: 'g-1',
        name: 'All Users',
        governanceTags: ['PROTECTED'],
      };
      (mockCatalogModel.findByIdAndUpdate as jest.Mock).mockReturnValue({
        exec: jest.fn().mockResolvedValue(updated),
      });
      const result = await service.setTags('cat-1', ['PROTECTED']);
      expect(result).toEqual(updated);
      expect(mockCatalogModel.findByIdAndUpdate).toHaveBeenCalledWith(
        'cat-1',
        { $set: { governanceTags: ['PROTECTED'] } },
        { new: true },
      );
    });

    it('returns null when document not found', async () => {
      (mockCatalogModel.findByIdAndUpdate as jest.Mock).mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });
      const result = await service.setTags('nonexistent', ['PROTECTED']);
      expect(result).toBeNull();
    });
  });
});
