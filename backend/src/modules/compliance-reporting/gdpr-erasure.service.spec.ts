import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { NotFoundException } from '@nestjs/common';
import { GdprErasureService } from './gdpr-erasure.service';
import { AuditService } from '../audit/audit.service';
import { GdprExternalStores } from './gdpr-erasure-external-stores';
import { NhiOwnershipService } from '../nhi/nhi-ownership.service';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

describe('GdprErasureService', () => {
  let service: GdprErasureService;
  let auditService: jest.Mocked<Partial<AuditService>>;

  const mockIdentity = { _id: 'id-1', tenantId: 'test-tenant' };

  const mockIdentityModel = {
    findById: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockIdentity),
      }),
    }),
    countDocuments: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(1),
    }),
    deleteOne: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    }),
    // The person's linked admin identities: none here (gdpr-erasure-reach.integration.spec.ts)
    find: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
      }),
    }),
  };

  const createCountAndDeleteModel = (count = 3) => ({
    countDocuments: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(count),
    }),
    deleteMany: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({ deletedCount: count }),
    }),
  });

  const mockUserEventModel = createCountAndDeleteModel(5);
  // The identity's audit entries the erasure reads before deleting them: two chained, one older
  const erasedEntries = [
    { _id: 'a1', integrityHash: 'h-old' },
    { _id: 'a2', seq: 7, integrityHash: 'h7' },
    { _id: 'a3', seq: 9, integrityHash: 'h9' },
  ];
  const mockAuditEventModel = {
    ...createCountAndDeleteModel(10),
    find: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(erasedEntries) }),
      }),
    }),
  };
  const mockReviewItemModel = createCountAndDeleteModel(2);
  const mockReviewExclusionModel = createCountAndDeleteModel(1);
  const mockOutboxEventModel = createCountAndDeleteModel(4);
  // The other collections of gdpr-erasure-scope.ts and the graph and index hold nothing here
  // (gdpr-erasure-reach.integration.spec.ts covers them on MongoDB)
  const emptyTargetModel = {
    ...createCountAndDeleteModel(0),
    updateMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
  };
  const mockConnection = { models: new Proxy({}, { get: () => emptyTargetModel }) };
  const nothingOutside = async () => ({
    counts: { access_graph: 0, elasticsearch_audit_events: 0 },
    notReached: [],
  });

  beforeEach(async () => {
    auditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        GdprErasureService,
        { provide: getModelToken('Identity'), useValue: mockIdentityModel },
        { provide: getModelToken('UserEvent'), useValue: mockUserEventModel },
        { provide: getModelToken('AuditEvent'), useValue: mockAuditEventModel },
        { provide: getModelToken('ReviewItem'), useValue: mockReviewItemModel },
        { provide: getModelToken('ReviewExclusion'), useValue: mockReviewExclusionModel },
        { provide: getModelToken('OutboxEvent'), useValue: mockOutboxEventModel },
        { provide: AuditService, useValue: auditService },
        { provide: getConnectionToken(), useValue: mockConnection },
        { provide: GdprExternalStores, useValue: { count: nothingOutside, erase: nothingOutside } },
        {
          provide: NhiOwnershipService,
          useValue: { markOwnerless: jest.fn().mockResolvedValue(0) },
        },
      ],
    }).compile();

    service = module.get<GdprErasureService>(GdprErasureService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('eraseIdentity', () => {
    it('should throw NotFoundException when identity not found', async () => {
      mockIdentityModel.findById.mockReturnValueOnce({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(null),
        }),
      });

      await expect(service.eraseIdentity('nonexistent', 'admin-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return attestation without deleting on dry run', async () => {
      const result = await service.eraseIdentity('id-1', 'admin-1', true);

      expect(result.dryRun).toBe(true);
      expect(result.collectionsAffected).toEqual([
        'identities',
        'user_events',
        'audit_events',
        'review_items',
        'review_exclusions',
        'outbox_events',
      ]);
      expect(result.documentCounts.review_exclusions).toBe(1);
      expect(mockIdentityModel.deleteOne).not.toHaveBeenCalled();
      expect(mockUserEventModel.deleteMany).not.toHaveBeenCalled();
      expect(mockAuditEventModel.deleteMany).not.toHaveBeenCalled();
      expect(mockReviewItemModel.deleteMany).not.toHaveBeenCalled();
      expect(mockReviewExclusionModel.deleteMany).not.toHaveBeenCalled();
      expect(mockOutboxEventModel.deleteMany).not.toHaveBeenCalled();
    });

    it('should delete from all collections on real erasure', async () => {
      const result = await service.eraseIdentity('id-1', 'admin-1', false);

      expect(result.dryRun).toBe(false);
      // Each delete names the subject: none may reach another person's documents
      expect(mockIdentityModel.deleteOne).toHaveBeenCalledWith({ _id: 'id-1' });
      expect(mockUserEventModel.deleteMany).toHaveBeenCalledWith({ userId: 'id-1' });
      expect(mockAuditEventModel.deleteMany).toHaveBeenCalledWith({
        _id: { $in: ['a1', 'a2', 'a3'] },
      });
      expect(mockAuditEventModel.find).toHaveBeenCalledWith({
        resourceId: 'id-1',
        action: { $ne: 'GDPR_ERASURE_EXECUTED' },
      });
      expect(mockReviewItemModel.deleteMany).toHaveBeenCalledWith({ identityId: 'id-1' });
      // The subject's access review exclusions (reviewer and justification with them)
      expect(mockReviewExclusionModel.deleteMany).toHaveBeenCalledWith({ identityId: 'id-1' });
      expect(mockOutboxEventModel.deleteMany).toHaveBeenCalledWith({
        aggregateId: 'id-1',
        status: 'published',
      });
    });

    it('should call auditService.log with GDPR_ERASURE_EXECUTED', async () => {
      await service.eraseIdentity('id-1', 'admin-1', false);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'GDPR_ERASURE_EXECUTED',
        }),
      );
    });

    // The chain check reports the gap the erased entries leave as this erasure, not as tampering
    it('records the chain positions (and older hashes) of the audit entries it deletes', async () => {
      const result = await service.eraseIdentity('id-1', 'admin-1', false);

      const entry = (auditService.log as jest.Mock).mock.calls[0][0];
      expect(entry.payload.metadata).toMatchObject({
        removedSeqs: [7, 9],
        removedLegacyHashes: ['h-old'],
      });
      expect(mockAuditEventModel.deleteMany).toHaveBeenCalledWith({
        _id: { $in: ['a1', 'a2', 'a3'] },
      });
      expect(result.documentCounts.audit_events).toBe(3);
    });

    it('a dry run records no removed entries', async () => {
      await service.eraseIdentity('id-1', 'admin-1', true);

      const entry = (auditService.log as jest.Mock).mock.calls[0][0];
      expect(entry.payload.metadata.removedSeqs).toBeUndefined();
      expect(mockAuditEventModel.find).not.toHaveBeenCalled();
    });
  });
});
