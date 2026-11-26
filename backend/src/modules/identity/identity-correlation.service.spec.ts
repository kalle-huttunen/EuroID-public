import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { IdentityCorrelationService } from './identity-correlation.service';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { CorrelationRuleEngine } from './correlation/correlation-rule.engine';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { IdentityOnionService } from './identity-onion.service';
import { IdentityDeletedMatchService } from './identity-deleted-match.service';
import { DeletedIdentityRowIgnored } from './deleted-identity-rows';
import {
  createMockLoggerFactory,
  createMockEventEmitter,
  TEST_TENANT_ID,
  withTestTenant,
} from '@testing/test-helpers';
import { createMockUser } from '@testing/mock-factories';
import { UserStatus } from '@shared/dtos/standard-user.dto';

function createHydratedDoc(data: Record<string, unknown> = {}) {
  const base = {
    _id: data._id ?? 'identity-id-001',
    tenantId: data.tenantId ?? TEST_TENANT_ID,
    profile: data.profile ?? { email: 'john.doe@example.com', firstName: 'John', lastName: 'Doe' },
    sources: data.sources ?? [],
    provisioning: data.provisioning ?? [],
    controls: data.controls ?? {},
    metadata: (data.metadata ?? {}) as Record<string, unknown>,
    deletedAt: undefined,
    deletedBy: undefined,
    ...data,
  };
  return {
    ...base,
    toObject: jest.fn().mockReturnValue(base),
    save: jest.fn().mockResolvedValue(base),
    set: jest.fn(),
    markModified: jest.fn(),
  };
}

const DEFAULT_CORRELATION_CONFIG = {
  rules: [{ strategy: 'email' as const }],
  conflictAction: 'review' as const,
  confidenceThreshold: 0.7,
};

describe('IdentityCorrelationService', () => {
  let service: IdentityCorrelationService;
  let mockIdentityModel: any;
  let mockReconciliationService: { reconcile: jest.Mock };
  let mockReconConfigService: { getHrSourceTags: jest.Mock };
  let mockCorrelationConfigService: {
    getCorrelationConfig: jest.Mock;
    getPrimaryHrSourceName: jest.Mock;
    getHrPriorityFromBlueprint: jest.Mock;
    getHrPriorityConfig: jest.Mock;
  };
  let mockCorrelationEngine: { findCorrelatedIdentity: jest.Mock };
  let mockCorrelationHashService: { hash: jest.Mock };
  let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;
  let mockOnionService: {
    findIdentityBySourceKey: jest.Mock;
    findIdentityByEmail: jest.Mock;
    findIdentityById: jest.Mock;
  };
  let mockDeletedMatch: {
    findBySourceKey: jest.Mock;
    findByCorrelation: jest.Mock;
    admit: jest.Mock;
    revive: jest.Mock;
    recordRehire: jest.Mock;
  };
  const { factory: loggerFactory } = createMockLoggerFactory();

  beforeEach(async () => {
    mockIdentityModel = jest.fn().mockImplementation((data) => {
      const doc = createHydratedDoc(data);
      doc._id = 'new-identity-id';
      return doc;
    });
    mockIdentityModel.findById = jest.fn();
    // No identity has the incoming email: a low-confidence match mints (identity-correlation-
    // conflict.integration.spec.ts covers a record whose email is taken)
    const noIdentity = { session: jest.fn(), exec: jest.fn().mockResolvedValue(null) };
    noIdentity.session.mockReturnValue(noIdentity);
    mockIdentityModel.exists = jest.fn().mockReturnValue(noIdentity);
    // ... and no live identity has it, so a record no rule matches mints too
    mockIdentityModel.findOne = jest.fn().mockReturnValue(noIdentity);
    // The tenant has no tenants document, so no identity limit (identity-limit.integration.spec.ts)
    mockIdentityModel.db = { collection: () => ({ findOne: async () => null }) };

    mockReconciliationService = {
      reconcile: jest.fn().mockImplementation((identity) => Promise.resolve(identity)),
    };
    mockReconConfigService = {
      getHrSourceTags: jest.fn().mockResolvedValue(['hr', 'workday']),
    };
    mockCorrelationConfigService = {
      getCorrelationConfig: jest.fn().mockResolvedValue(DEFAULT_CORRELATION_CONFIG),
      getPrimaryHrSourceName: jest.fn().mockResolvedValue('workday'),
      getHrPriorityFromBlueprint: jest.fn().mockResolvedValue(null),
      getHrPriorityConfig: jest.fn().mockResolvedValue(null),
    };
    mockCorrelationEngine = {
      findCorrelatedIdentity: jest.fn().mockResolvedValue({
        identity: null,
        matchedBy: null,
        confidence: 0,
      }),
    };
    mockCorrelationHashService = {
      hash: jest.fn().mockImplementation((value) => `hash-${value}`),
    };
    mockEventEmitter = createMockEventEmitter();
    mockOnionService = {
      findIdentityBySourceKey: jest.fn().mockResolvedValue(null),
      findIdentityByEmail: jest.fn().mockResolvedValue(null),
      findIdentityById: jest.fn().mockResolvedValue(null),
    };
    mockDeletedMatch = {
      findBySourceKey: jest.fn().mockResolvedValue(null),
      findByCorrelation: jest.fn().mockResolvedValue(null),
      admit: jest.fn().mockResolvedValue(undefined),
      revive: jest.fn(),
      recordRehire: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        IdentityCorrelationService,
        { provide: getModelToken('Identity'), useValue: mockIdentityModel },
        { provide: ReconciliationService, useValue: mockReconciliationService },
        { provide: ReconciliationConfigService, useValue: mockReconConfigService },
        { provide: CorrelationConfigService, useValue: mockCorrelationConfigService },
        { provide: CorrelationRuleEngine, useValue: mockCorrelationEngine },
        { provide: CorrelationHashService, useValue: mockCorrelationHashService },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: mockEventEmitter },
        { provide: IdentityOnionService, useValue: mockOnionService },
        { provide: IdentityDeletedMatchService, useValue: mockDeletedMatch },
      ],
    }).compile();

    service = module.get(IdentityCorrelationService);
    jest.clearAllMocks();
    // Re-set defaults after clearAllMocks
    mockReconConfigService.getHrSourceTags.mockResolvedValue(['hr', 'workday']);
    mockCorrelationConfigService.getCorrelationConfig.mockResolvedValue(DEFAULT_CORRELATION_CONFIG);
    mockCorrelationConfigService.getPrimaryHrSourceName.mockResolvedValue('workday');
    mockCorrelationConfigService.getHrPriorityFromBlueprint.mockResolvedValue(null);
    mockCorrelationConfigService.getHrPriorityConfig.mockResolvedValue(null);
    mockReconciliationService.reconcile.mockImplementation((identity) => Promise.resolve(identity));
    mockCorrelationEngine.findCorrelatedIdentity.mockResolvedValue({
      identity: null,
      matchedBy: null,
      confidence: 0,
    });
    mockCorrelationHashService.hash.mockImplementation((value: string) => `hash-${value}`);
    mockDeletedMatch.findBySourceKey.mockResolvedValue(null);
    mockDeletedMatch.findByCorrelation.mockResolvedValue(null);
    mockDeletedMatch.admit.mockResolvedValue(undefined);
  });

  // ── getCorrelationConfig ──────────────────────────────────────

  describe('getCorrelationConfig', () => {
    it('should delegate to correlationConfigService', async () => {
      await withTestTenant(() => service.getCorrelationConfig(TEST_TENANT_ID));
      expect(mockCorrelationConfigService.getCorrelationConfig).toHaveBeenCalledWith(
        TEST_TENANT_ID,
        {},
      );
    });
  });

  describe('isHrSource', () => {
    it('is true for a source the HR source tags name, in any case and spelling', async () => {
      await withTestTenant(async () => {
        expect(await service.isHrSource('Workday')).toBe(true);
        expect(await service.isHrSource('csv-hr')).toBe(true);
        expect(await service.isHrSource('Manual-Test')).toBe(false);
      });
    });
  });

  // ── ensureIdentityFromUser ────────────────────────────────────

  describe('ensureIdentityFromUser', () => {
    it('should find existing identity by source key and skip correlation', async () => {
      const existingIdentity = createHydratedDoc({
        sources: [{ sourceName: 'testhr', externalId: 'EMP-001' }],
      });
      mockOnionService.findIdentityBySourceKey.mockResolvedValue(existingIdentity);

      const dto = createMockUser();
      const result = await withTestTenant(() => service.ensureIdentityFromUser(dto));

      expect(result).toBeDefined();
      expect(mockCorrelationEngine.findCorrelatedIdentity).not.toHaveBeenCalled();
      expect(existingIdentity.save).toHaveBeenCalled();
      expect(mockReconciliationService.reconcile).toHaveBeenCalled();
    });

    it('should emit IDENTITY_CORRELATED on high-confidence match', async () => {
      const matchedIdentity = createHydratedDoc({ _id: 'matched-id' });
      mockCorrelationEngine.findCorrelatedIdentity.mockResolvedValue({
        identity: matchedIdentity,
        matchedBy: 'email',
        confidence: 0.9,
        reviewRequired: false,
      });

      const dto = createMockUser();
      await withTestTenant(() => service.ensureIdentityFromUser(dto));

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        DomainEventType.IDENTITY_CORRELATED,
        expect.any(String),
        expect.objectContaining({
          correlationRule: 'email',
          confidence: 0.9,
        }),
        expect.anything(),
      );
      expect(matchedIdentity.metadata.correlationStatus).toBe('correlated');
    });

    it('should emit CORRELATION_CONFLICT on low-confidence match', async () => {
      const ambiguousIdentity = createHydratedDoc({
        _id: 'ambiguous-id',
        profile: {
          email: 'existing@example.com',
          firstName: 'Jane',
          lastName: 'Smith',
          sourceSystem: 'other-hr',
        },
      });
      mockCorrelationEngine.findCorrelatedIdentity.mockResolvedValue({
        identity: ambiguousIdentity,
        matchedBy: 'employeeNumber',
        confidence: 0.5,
        reviewRequired: true,
      });

      const dto = createMockUser();
      await withTestTenant(() => service.ensureIdentityFromUser(dto));

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        DomainEventType.CORRELATION_CONFLICT,
        expect.any(String),
        expect.objectContaining({
          correlationRule: 'employeeNumber',
          confidence: 0.5,
          reviewRequired: true,
        }),
        expect.anything(),
      );
      expect(ambiguousIdentity.metadata.correlationConflict).toBe(true);
      expect(ambiguousIdentity.metadata.requiresReview).toBe(true);
      // metadata is Mixed: without markModified the flags never reach the database
      expect(ambiguousIdentity.markModified).toHaveBeenCalledWith('metadata');
      expect(ambiguousIdentity.markModified.mock.invocationCallOrder[0]).toBeLessThan(
        ambiguousIdentity.save.mock.invocationCallOrder[0],
      );
    });

    it('should mint new identity when no match found', async () => {
      mockCorrelationEngine.findCorrelatedIdentity.mockResolvedValue({
        identity: null,
        matchedBy: null,
        confidence: 0,
      });

      const dto = createMockUser({ email: 'new@example.com' });
      const result = await withTestTenant(() => service.ensureIdentityFromUser(dto));

      expect(result).toBeDefined();
      expect(mockIdentityModel).toHaveBeenCalled();
      expect(mockReconciliationService.reconcile).toHaveBeenCalled();
    });

    it('should hash national ID when hashedNationalId rule is configured', async () => {
      const configWithNatId = {
        ...DEFAULT_CORRELATION_CONFIG,
        rules: [
          { strategy: 'hashedNationalId' as const, nationalIdSourceField: 'nationalId' },
          { strategy: 'email' as const },
        ],
      };
      mockCorrelationConfigService.getCorrelationConfig.mockResolvedValue(configWithNatId);

      const dto = createMockUser();
      (dto as any).nationalId = '123456-789A';

      await withTestTenant(() => service.ensureIdentityFromUser(dto));

      expect(mockCorrelationHashService.hash).toHaveBeenCalledWith('123456-789A', TEST_TENANT_ID);
    });

    it('revives the deleted identity a record belongs to when it is a rehire', async () => {
      const deleted = createHydratedDoc({
        _id: 'deleted-1',
        deletedAt: new Date('2026-06-01'),
        sources: [{ sourceName: 'testhr', externalId: 'EMP-001' }],
      });
      mockDeletedMatch.findBySourceKey.mockResolvedValue(deleted);
      const dto = createMockUser({ status: UserStatus.ACTIVE });

      const result = await withTestTenant(() => service.ensureIdentityFromUser(dto));

      expect(result).toBe(deleted);
      expect(mockDeletedMatch.admit).toHaveBeenCalledWith(deleted, dto, expect.any(String));
      // Revived as a rehire of the syncing source (HR joiner detection reads it), with the
      // record's email: the old one may belong to a new hire now
      expect(mockDeletedMatch.revive).toHaveBeenCalledWith(deleted, 'testhr', dto.email);
      const order = (m: jest.Mock) => m.mock.invocationCallOrder[0];
      expect(order(mockDeletedMatch.revive)).toBeLessThan(order(deleted.save));
      expect(mockDeletedMatch.recordRehire).toHaveBeenCalledWith(
        deleted,
        expect.any(String),
        TEST_TENANT_ID,
      );
      expect(mockCorrelationEngine.findCorrelatedIdentity).not.toHaveBeenCalled();
      expect(mockIdentityModel).not.toHaveBeenCalled();
    });

    it('writes nothing for a record of a deleted identity that is not a rehire', async () => {
      const deleted = createHydratedDoc({ _id: 'deleted-1', deletedAt: new Date('2026-06-01') });
      mockDeletedMatch.findBySourceKey.mockResolvedValue(deleted);
      mockDeletedMatch.admit.mockRejectedValue(new DeletedIdentityRowIgnored('deleted-1', 'ended'));

      await expect(
        withTestTenant(() => service.ensureIdentityFromUser(createMockUser())),
      ).rejects.toBeInstanceOf(DeletedIdentityRowIgnored);

      expect(deleted.save).not.toHaveBeenCalled();
      expect(mockDeletedMatch.revive).not.toHaveBeenCalled();
      expect(mockIdentityModel).not.toHaveBeenCalled();
      expect(mockReconciliationService.reconcile).not.toHaveBeenCalled();
    });

    it('looks for a deleted identity by correlation only when no live identity correlates', async () => {
      await withTestTenant(() => service.ensureIdentityFromUser(createMockUser()));
      expect(mockDeletedMatch.findByCorrelation).toHaveBeenCalledTimes(1);

      mockDeletedMatch.findByCorrelation.mockClear();
      mockCorrelationEngine.findCorrelatedIdentity.mockResolvedValue({
        identity: createHydratedDoc({ _id: 'live-1' }),
        matchedBy: 'email',
        confidence: 0.5,
        reviewRequired: true,
      });
      await withTestTenant(() => service.ensureIdentityFromUser(createMockUser()));
      expect(mockDeletedMatch.findByCorrelation).not.toHaveBeenCalled();
    });

    it('leaves a live identity found by its source key alone', async () => {
      mockOnionService.findIdentityBySourceKey.mockResolvedValue(createHydratedDoc());

      await withTestTenant(() => service.ensureIdentityFromUser(createMockUser()));

      expect(mockDeletedMatch.findBySourceKey).not.toHaveBeenCalled();
      expect(mockDeletedMatch.admit).not.toHaveBeenCalled();
    });
  });

  // ── ensureIdentityFromUser: beforeWrite (bulk rollback snapshot) ──

  describe('ensureIdentityFromUser beforeWrite', () => {
    const firstCall = (mock: jest.Mock) => mock.mock.invocationCallOrder[0];

    it('gets the source-key match before anything is written to it', async () => {
      const existing = createHydratedDoc({
        _id: 'identity-1',
        profile: { email: 'ada@example.com', jobTitle: 'Analyst' },
        sources: [{ sourceName: 'testhr', externalId: 'EMP-001' }],
        metadata: { version: 2 },
      });
      mockOnionService.findIdentityBySourceKey.mockResolvedValue(existing);
      const beforeWrite = jest.fn().mockResolvedValue(undefined);

      await withTestTenant(() =>
        service.ensureIdentityFromUser(createMockUser(), undefined, beforeWrite),
      );

      expect(beforeWrite).toHaveBeenCalledTimes(1);
      expect(beforeWrite).toHaveBeenCalledWith({
        id: 'identity-1',
        profile: { email: 'ada@example.com', jobTitle: 'Analyst' },
        sources: [{ sourceName: 'testhr', externalId: 'EMP-001' }],
        metadata: { version: 2 },
        deletedAt: null,
        deletedBy: null,
        // HX-E4: the Entra ID entries too, which a bulk rollback puts back
        entraProvisioning: [],
      });
      expect(firstCall(beforeWrite)).toBeLessThan(firstCall(existing.save));
    });

    it('gets a high-confidence correlation match before it is marked and saved', async () => {
      const matched = createHydratedDoc({ _id: 'matched-id' });
      mockCorrelationEngine.findCorrelatedIdentity.mockResolvedValue({
        identity: matched,
        matchedBy: 'email',
        confidence: 0.9,
        reviewRequired: false,
      });
      const beforeWrite = jest.fn().mockResolvedValue(undefined);

      await withTestTenant(() =>
        service.ensureIdentityFromUser(createMockUser(), undefined, beforeWrite),
      );

      expect(beforeWrite).toHaveBeenCalledTimes(1);
      expect(beforeWrite).toHaveBeenCalledWith(expect.objectContaining({ id: 'matched-id' }));
      expect(firstCall(beforeWrite)).toBeLessThan(firstCall(matched.save));
    });

    it('gets null before a new identity is minted', async () => {
      const beforeWrite = jest.fn().mockResolvedValue(undefined);

      await withTestTenant(() =>
        service.ensureIdentityFromUser(createMockUser(), undefined, beforeWrite),
      );

      expect(beforeWrite).toHaveBeenCalledWith(null);
      expect(firstCall(beforeWrite)).toBeLessThan(firstCall(mockIdentityModel));
    });

    it('stops the write when it fails', async () => {
      const existing = createHydratedDoc({ sources: [] });
      mockOnionService.findIdentityBySourceKey.mockResolvedValue(existing);

      await expect(
        withTestTenant(() =>
          service.ensureIdentityFromUser(
            createMockUser(),
            undefined,
            jest.fn().mockRejectedValue(new Error('snapshot store down')),
          ),
        ),
      ).rejects.toThrow('snapshot store down');
      expect(existing.save).not.toHaveBeenCalled();
      expect(mockReconciliationService.reconcile).not.toHaveBeenCalled();
    });
  });

  // ── ensureIdentityFromUser: beforeConflictFlag (bulk rollback snapshot) ──

  describe('ensureIdentityFromUser beforeConflictFlag', () => {
    const firstCall = (mock: jest.Mock) => mock.mock.invocationCallOrder[0];
    const lowConfidenceMatch = (metadata: Record<string, unknown>) => {
      const flagged = createHydratedDoc({
        _id: 'existing-id',
        profile: { email: 'existing@example.com', firstName: 'Jane', lastName: 'Smith' },
        metadata,
      });
      mockCorrelationEngine.findCorrelatedIdentity.mockResolvedValue({
        identity: flagged,
        matchedBy: 'employeeNumber',
        confidence: 0.5,
        reviewRequired: true,
      });
      return flagged;
    };

    it('gets the matched identity flags as they were, before the conflict is set and saved', async () => {
      const flagged = lowConfidenceMatch({ version: 3, requiresReview: false });
      const beforeConflictFlag = jest.fn().mockResolvedValue(undefined);
      const beforeWrite = jest.fn().mockResolvedValue(undefined);

      await withTestTenant(() =>
        service.ensureIdentityFromUser(
          createMockUser(),
          undefined,
          beforeWrite,
          beforeConflictFlag,
        ),
      );

      expect(beforeConflictFlag).toHaveBeenCalledTimes(1);
      expect(beforeConflictFlag).toHaveBeenCalledWith({ id: 'existing-id', requiresReview: false });
      expect(firstCall(beforeConflictFlag)).toBeLessThan(firstCall(flagged.save));
      // Then the identity for the incoming record is minted, after its own hook.
      expect(firstCall(beforeConflictFlag)).toBeLessThan(firstCall(beforeWrite));
      expect(beforeWrite).toHaveBeenCalledWith(null);
      expect(flagged.metadata.correlationConflict).toBe(true);
    });

    it('stops before flagging when it fails', async () => {
      const flagged = lowConfidenceMatch({});

      await expect(
        withTestTenant(() =>
          service.ensureIdentityFromUser(
            createMockUser(),
            undefined,
            undefined,
            jest.fn().mockRejectedValue(new Error('snapshot store down')),
          ),
        ),
      ).rejects.toThrow('snapshot store down');
      expect(flagged.save).not.toHaveBeenCalled();
      expect(flagged.metadata.correlationConflict).toBeUndefined();
    });

    it('is not called without a low-confidence match', async () => {
      const beforeConflictFlag = jest.fn();

      await withTestTenant(() =>
        service.ensureIdentityFromUser(createMockUser(), undefined, undefined, beforeConflictFlag),
      );

      expect(beforeConflictFlag).not.toHaveBeenCalled();
    });
  });

  // ── pushSourceAndReconcile ────────────────────────────────────

  describe('pushSourceAndReconcile', () => {
    it('should add new source and emit IDENTITY_SOURCES_CHANGED', async () => {
      const existingIdentity = createHydratedDoc({
        _id: 'existing-id',
        tenantId: TEST_TENANT_ID,
        sources: [{ sourceName: 'hr-feed', externalId: 'E1' }],
      });
      // After save, sources array is updated
      existingIdentity.save.mockImplementation(async function (this: any) {
        this.sources = [
          { sourceName: 'hr-feed', externalId: 'E1' },
          { sourceName: 'entra-id', externalId: 'obj-123' },
        ];
        return this;
      });
      mockOnionService.findIdentityBySourceKey.mockResolvedValue(existingIdentity);

      const result = await withTestTenant(() =>
        service.pushSourceAndReconcile('existing-id', 'entra-id', 'obj-123', {
          mail: 'test@example.com',
        }),
      );

      expect(result).toBeDefined();
      expect(existingIdentity.save).toHaveBeenCalled();
      expect(mockReconciliationService.reconcile).toHaveBeenCalled();
    });

    it.each([
      ['a new HR source', undefined, 0],
      ["onboarding's write-back of a target account", { writeback: true }, 1],
    ])('emits identity.sources_changed for %s at depth %s', async (_case, flags, depth) => {
      const identity = createHydratedDoc({
        _id: 'existing-id',
        tenantId: TEST_TENANT_ID,
        sources: [{ sourceName: 'csv-hr', externalId: 'E1' }],
      });
      mockOnionService.findIdentityBySourceKey.mockResolvedValue(identity);

      await withTestTenant(() =>
        service.pushSourceAndReconcile(
          'existing-id',
          'servicenow',
          'snow-abc',
          {},
          {
            sourceRole: 'target',
            ...flags,
          },
        ),
      );

      // SourcesChangedHandler starts onboarding only at depth 0
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        DomainEventType.IDENTITY_SOURCES_CHANGED,
        'existing-id',
        expect.objectContaining({ newSourceName: 'servicenow' }),
        { tenantId: TEST_TENANT_ID, depth },
      );
    });

    it('should update existing source without emitting event', async () => {
      const existingIdentity = createHydratedDoc({
        _id: 'existing-id',
        sources: [{ sourceName: 'entra-id', externalId: 'obj-123' }],
      });
      mockOnionService.findIdentityBySourceKey.mockResolvedValue(existingIdentity);

      await withTestTenant(() =>
        service.pushSourceAndReconcile('existing-id', 'entra-id', 'obj-123', {
          mail: 'updated@example.com',
        }),
      );

      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(
        DomainEventType.IDENTITY_SOURCES_CHANGED,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('should return null when identity not found', async () => {
      mockOnionService.findIdentityById.mockResolvedValue(null);
      mockOnionService.findIdentityBySourceKey.mockResolvedValue(null);
      mockOnionService.findIdentityByEmail.mockResolvedValue(null);

      const result = await withTestTenant(() =>
        service.pushSourceAndReconcile('nonexistent@example.com', 'hr-feed', 'E999', {}),
      );

      expect(result).toBeNull();
      expect(mockReconciliationService.reconcile).not.toHaveBeenCalled();
    });

    it('should find identity by email when source key lookup fails', async () => {
      const existingIdentity = createHydratedDoc({
        _id: 'found-by-email',
        sources: [],
      });
      mockOnionService.findIdentityBySourceKey.mockResolvedValue(null);
      mockOnionService.findIdentityByEmail.mockResolvedValue(existingIdentity);

      await withTestTenant(() =>
        service.pushSourceAndReconcile('user@example.com', 'new-source', 'NS-1', {}),
      );

      expect(mockOnionService.findIdentityByEmail).toHaveBeenCalledWith('user@example.com');
      expect(existingIdentity.save).toHaveBeenCalled();
    });
  });

  // updateControls moved to IdentityControlsService (identity-controls.integration.spec.ts)
});
