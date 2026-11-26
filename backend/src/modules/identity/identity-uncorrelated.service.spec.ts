import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { createMockLoggerFactory, createMockEventEmitter } from '@testing/test-helpers';
import { CorrelationConfigUnavailableError } from '../correlation-config/correlation-config.errors';
import { IdentityUncorrelatedService } from './identity-uncorrelated.service';
import { ReconciliationService } from './reconciliation.service';
import { CandidateSuggestionService } from './correlation/candidate-suggestion.service';
import { IdentityCorrelationService } from './identity-correlation.service';
import { IdentityOnionService } from './identity-onion.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

jest.mock('@infrastructure/middleware/correlation.middleware', () => ({
  requestContext: { getStore: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }) },
}));

describe('IdentityUncorrelatedService', () => {
  let service: IdentityUncorrelatedService;
  let mockIdentityModel: Record<string, jest.Mock>;
  let mockReconciliationService: Record<string, jest.Mock>;
  let mockCandidateSuggestionService: Record<string, jest.Mock>;
  let mockIdentityCorrelationService: Record<string, jest.Mock>;
  let mockIdentityOnionService: Record<string, jest.Mock>;
  let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;

  const mockUncorrelatedIdentity = {
    _id: 'uncorrelated-1',
    tenantId: 'test-tenant',
    metadata: { correlationStatus: 'uncorrelated' },
    sources: [{ sourceName: 'workday', externalId: 'ext-1' }],
    profile: { displayName: 'John Doe', email: 'john.doe@corp.example' },
    save: jest.fn().mockResolvedValue(undefined),
    markModified: jest.fn(),
    deletedAt: null as Date | null,
    deletedBy: null as string | null,
  };

  const mockTargetIdentity = {
    _id: 'target-1',
    tenantId: 'test-tenant',
    metadata: { correlationStatus: 'correlated' },
    sources: [{ sourceName: 'entra-id', externalId: 'ext-2' }],
    profile: { displayName: 'John Doe' },
    save: jest.fn().mockResolvedValue(undefined),
    markModified: jest.fn(),
  };

  beforeEach(async () => {
    // Reset mutable fields on mock objects
    mockUncorrelatedIdentity.save = jest.fn().mockResolvedValue(undefined);
    mockUncorrelatedIdentity.markModified = jest.fn();
    mockUncorrelatedIdentity.deletedAt = null;
    mockUncorrelatedIdentity.deletedBy = null;
    mockUncorrelatedIdentity.metadata = { correlationStatus: 'uncorrelated' };
    mockUncorrelatedIdentity.profile = {
      displayName: 'John Doe',
      email: 'john.doe@corp.example',
    };
    mockTargetIdentity.save = jest.fn().mockResolvedValue(undefined);
    mockTargetIdentity.markModified = jest.fn();
    mockTargetIdentity.metadata = { correlationStatus: 'correlated' };
    mockTargetIdentity.sources = [{ sourceName: 'entra-id', externalId: 'ext-2' }];

    mockIdentityModel = {
      find: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([mockUncorrelatedIdentity]),
      }),
      countDocuments: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(5),
      }),
      updateOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ matchedCount: 1 }),
      }),
    };

    mockReconciliationService = {
      reconcile: jest.fn().mockResolvedValue(mockTargetIdentity),
    };

    mockCandidateSuggestionService = {
      suggestCandidates: jest.fn().mockResolvedValue([]),
    };

    mockIdentityCorrelationService = {
      getCorrelationConfig: jest.fn().mockResolvedValue({ fieldMasteryOverrides: {} }),
    };

    mockIdentityOnionService = {
      findIdentityById: jest.fn().mockImplementation((id: string) => {
        if (id === 'uncorrelated-1') return Promise.resolve(mockUncorrelatedIdentity);
        if (id === 'target-1') return Promise.resolve(mockTargetIdentity);
        return Promise.resolve(null);
      }),
      findIdentityByEmail: jest.fn().mockResolvedValue(null),
    };

    mockEventEmitter = createMockEventEmitter();

    const module = await Test.createTestingModule({
      providers: [
        IdentityUncorrelatedService,
        { provide: getModelToken('Identity'), useValue: mockIdentityModel },
        { provide: ReconciliationService, useValue: mockReconciliationService },
        { provide: CandidateSuggestionService, useValue: mockCandidateSuggestionService },
        { provide: IdentityCorrelationService, useValue: mockIdentityCorrelationService },
        { provide: IdentityOnionService, useValue: mockIdentityOnionService },
        { provide: LoggerFactoryService, useValue: createMockLoggerFactory().factory },
        { provide: DomainEventEmitterService, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get(IdentityUncorrelatedService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findUncorrelatedIdentities', () => {
    it('should return uncorrelated identities', async () => {
      const result = await service.findUncorrelatedIdentities('test-tenant');

      expect(result).toEqual([mockUncorrelatedIdentity]);
      expect(mockIdentityModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'test-tenant',
          'metadata.correlationStatus': { $in: ['uncorrelated', 'ambiguous'] },
        }),
      );
    });
  });

  describe('countUncorrelated', () => {
    it('should return count of uncorrelated identities', async () => {
      const result = await service.countUncorrelated('test-tenant');

      expect(result).toBe(5);
      expect(mockIdentityModel.countDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'test-tenant',
          'metadata.correlationStatus': { $in: ['uncorrelated', 'ambiguous'] },
        }),
      );
    });
  });

  describe('linkUncorrelatedToTarget', () => {
    it('should merge sources and soft-delete uncorrelated identity', async () => {
      await service.linkUncorrelatedToTarget('uncorrelated-1', 'target-1', 'admin-user');

      // Soft-deleted ones too: an identity offboarded before its link stays linkable
      expect(mockIdentityOnionService.findIdentityById).toHaveBeenCalledWith('uncorrelated-1', {
        includeDeleted: true,
      });
      expect(mockIdentityOnionService.findIdentityById).toHaveBeenCalledWith('target-1');
      // The uncorrelated identity is soft-deleted and releases its email before the target saves
      expect(mockIdentityModel.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'uncorrelated-1', deletedAt: null }),
        expect.objectContaining({
          $set: expect.objectContaining({
            deletedAt: expect.any(Date),
            deletedBy: 'admin-user',
            'profile.email': 'merged-uncorrelated-1@released.invalid',
          }),
        }),
      );
      // The target is saved once, by the reconcile, with both sources and its new status
      expect(mockReconciliationService.reconcile).toHaveBeenCalledTimes(1);
      const [kept] = mockReconciliationService.reconcile.mock.calls[0];
      expect(kept.sources.map((s: { sourceName: string }) => s.sourceName)).toEqual([
        'entra-id',
        'workday',
      ]);
      expect(kept.metadata.correlationStatus).toBe('correlated');
      expect(mockTargetIdentity.markModified).toHaveBeenCalledWith('metadata');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        DomainEventType.IDENTITY_DELETED,
        'uncorrelated-1',
        { identityId: 'uncorrelated-1', reason: 'merged-into-target' },
        { actor: 'admin-user' },
      );
    });

    // Hunt 2026-11-25 r2-02 N2: defaults would reconcile the merge without the mastery overrides
    it('writes nothing when the correlation settings cannot be read', async () => {
      mockIdentityCorrelationService.getCorrelationConfig.mockImplementation(
        async (_tenantId: string, options?: { strict?: boolean }) => {
          if (options?.strict) throw new CorrelationConfigUnavailableError();
          return { fieldMasteryOverrides: {} };
        },
      );

      await expect(
        service.linkUncorrelatedToTarget('uncorrelated-1', 'target-1', 'admin-user'),
      ).rejects.toBeInstanceOf(CorrelationConfigUnavailableError);
      expect(mockIdentityModel.updateOne).not.toHaveBeenCalled();
      expect(mockReconciliationService.reconcile).not.toHaveBeenCalled();
    });

    it('links an offboarded identity, keeping its deletion and reporting no second one', async () => {
      const offboardedAt = new Date('2026-11-20T10:00:00Z');
      mockUncorrelatedIdentity.deletedAt = offboardedAt;
      mockUncorrelatedIdentity.deletedBy = 'offboarding-workflow';

      const linked = await service.linkUncorrelatedToTarget(
        'uncorrelated-1',
        'target-1',
        'admin-user',
      );

      expect(linked).toBe(mockTargetIdentity);
      // Only its email is released: the deletion stays the one its offboarding made
      expect(mockIdentityModel.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'uncorrelated-1', deletedAt: offboardedAt }),
        {
          $set: { 'profile.email': 'merged-uncorrelated-1@released.invalid' },
          $inc: { __v: 1 },
        },
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        DomainEventType.IDENTITY_CORRELATED,
        'target-1',
        expect.objectContaining({ incomingIdentityId: 'uncorrelated-1' }),
        { actor: 'admin-user' },
      );
      // Its offboarding reported the deletion (identity.deleted) when it happened
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(
        DomainEventType.IDENTITY_DELETED,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('returns null for an identity that a merge already took', async () => {
      mockUncorrelatedIdentity.deletedAt = new Date('2026-11-20T10:00:00Z');
      mockUncorrelatedIdentity.profile.email = 'merged-uncorrelated-1@released.invalid';

      const result = await service.linkUncorrelatedToTarget(
        'uncorrelated-1',
        'target-1',
        'admin-user',
      );

      expect(result).toBeNull();
      expect(mockIdentityModel.updateOne).not.toHaveBeenCalled();
      expect(mockReconciliationService.reconcile).not.toHaveBeenCalled();
    });

    // A link merges the identity into the target and soft-deletes it: only one waiting in the
    // queue may be merged away, and never into itself
    it('refuses an identity that is not uncorrelated or ambiguous, writing nothing', async () => {
      mockUncorrelatedIdentity.metadata = { correlationStatus: 'correlated' };

      const result = await service.linkUncorrelatedToTarget(
        'uncorrelated-1',
        'target-1',
        'admin-user',
      );

      expect(result).toBeNull();
      expect(mockIdentityModel.updateOne).not.toHaveBeenCalled();
      expect(mockReconciliationService.reconcile).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('refuses to link an identity to itself, writing nothing', async () => {
      const result = await service.linkUncorrelatedToTarget(
        'uncorrelated-1',
        'uncorrelated-1',
        'admin-user',
      );

      expect(result).toBeNull();
      expect(mockIdentityModel.updateOne).not.toHaveBeenCalled();
      expect(mockReconciliationService.reconcile).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should return null when uncorrelated identity not found', async () => {
      const result = await service.linkUncorrelatedToTarget(
        'nonexistent',
        'target-1',
        'admin-user',
      );

      expect(result).toBeNull();
      expect(mockTargetIdentity.save).not.toHaveBeenCalled();
    });

    it('should return null when target identity not found', async () => {
      const result = await service.linkUncorrelatedToTarget(
        'uncorrelated-1',
        'nonexistent',
        'admin-user',
      );

      expect(result).toBeNull();
    });
  });

  describe('createStandalone', () => {
    it('should mark identity as correlated standalone', async () => {
      const result = await service.createStandalone('uncorrelated-1', 'admin-user');

      expect(result).toBeDefined();
      expect(mockUncorrelatedIdentity.metadata.correlationStatus).toBe('correlated');
      // metadata is a Mixed path: without markModified the change is never stored
      expect(mockUncorrelatedIdentity.markModified).toHaveBeenCalledWith('metadata');
      expect(mockUncorrelatedIdentity.save).toHaveBeenCalled();
    });

    it('should return null when identity not found', async () => {
      const result = await service.createStandalone('nonexistent', 'admin-user');

      expect(result).toBeNull();
    });
  });

  describe('findIdentitiesWithConflicts', () => {
    it('should return identities with conflict status', async () => {
      const mockConflictIdentity = {
        _id: 'conflict-1',
        tenantId: 'test-tenant',
        metadata: { requiresReview: true },
        profile: { displayName: 'Jane Smith' },
      };

      mockIdentityModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue([mockConflictIdentity]),
      });

      const result = await service.findIdentitiesWithConflicts('test-tenant');

      expect(result).toEqual([mockConflictIdentity]);
      expect(mockIdentityModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'test-tenant',
          $or: [{ 'metadata.requiresReview': true }, { 'metadata.correlationConflict': true }],
        }),
      );
    });
  });
});
