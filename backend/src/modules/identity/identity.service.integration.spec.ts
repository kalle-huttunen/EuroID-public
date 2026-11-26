import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import { getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';

// Register tenant scoping plugin (normally done by TenantModule at import time)
mongoose.plugin(tenantPlugin);
import { IdentityService } from './identity.service';
import { IdentityQueryService } from './identity-query.service';
import { IdentityMutationService } from './identity-mutation.service';
import { IdentityCorrelationService } from './identity-correlation.service';
import { IdentityUncorrelatedService } from './identity-uncorrelated.service';
import { IdentityProvisioningService } from './identity-provisioning.service';
import { IdentityOnionService } from './identity-onion.service';
import { IdentityDeletedMatchService } from './identity-deleted-match.service';
import { LeaverPolicy, LeaverPolicySchema } from '../leavers/schemas/leaver-policy.schema';
import { Identity, IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { ReconciliationService } from './reconciliation.service';
import { IdentityControlsService } from './identity-controls.service';
import { ContractCriticalMasteryService } from './contract-critical-mastery.service';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { CorrelationRuleEngine } from './correlation/correlation-rule.engine';
import { CandidateSuggestionService } from './correlation/candidate-suggestion.service';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import {
  createMockUser,
  createMockLoggerFactory,
  createMockEventEmitter,
  withTestTenant,
  TEST_TENANT_ID,
} from '@testing';
import { ConflictException, BadRequestException } from '@nestjs/common';

/** DTO for saveOrUpdate: omits _id so MongoDB can generate a valid ObjectId on upsert. */
function createSaveDto(overrides: Partial<StandardUserDto> = {}): StandardUserDto {
  const full = createMockUser(overrides);
  const { _id: _idOmitted, ...rest } = full;
  return rest as StandardUserDto;
}

/**
 * Integration tests for IdentityService with real MongoDB (in-memory).
 * Tests the full CRUD flow including Mongoose upsert semantics.
 */
describe('IdentityService (Integration)', () => {
  let module: TestingModule;
  let service: IdentityService;
  let identityModel: Model<IdentityDocument>;

  beforeAll(async () => {
    const uri = testDbUri();

    const { factory: loggerFactory } = createMockLoggerFactory();

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: LeaverPolicy.name, schema: LeaverPolicySchema },
        ]),
      ],
      providers: [
        IdentityQueryService,
        IdentityMutationService,
        IdentityCorrelationService,
        IdentityUncorrelatedService,
        IdentityProvisioningService,
        IdentityOnionService,
        IdentityDeletedMatchService,
        IdentityService,
        {
          provide: ReconciliationService,
          useValue: {
            reconcile: jest.fn().mockImplementation((identity) => Promise.resolve(identity)),
            // No field HR-mastered here: the update tests are about retries
            hrOwnersOf: jest.fn().mockResolvedValue({}),
          },
        },
        // Facade dependencies these tests do not use
        { provide: IdentityControlsService, useValue: {} },
        { provide: ContractCriticalMasteryService, useValue: {} },
        {
          provide: ReconciliationConfigService,
          useValue: {
            getConfig: jest.fn().mockResolvedValue(null),
            getHrSourceTags: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: CorrelationConfigService,
          useValue: {
            getCorrelationConfig: jest.fn().mockResolvedValue({
              rules: [{ strategy: 'email' }],
              conflictAction: 'review',
              confidenceThreshold: 0.7,
            }),
            getPrimaryHrSourceName: jest.fn().mockResolvedValue(null),
            getHrPriorityConfig: jest.fn().mockResolvedValue(null),
            getHrPriorityFromBlueprint: jest.fn().mockResolvedValue(null),
            // The built-in HR connectors (manifest capability `ingest`)
            isHrSourceName: jest.fn(async (name: string) =>
              ['csv-hr', 'json-api-hr'].includes(name),
            ),
            getHrConnectorsWithPriorityFromBlueprint: jest.fn().mockResolvedValue([]),
            getInstalledHrConnectorsWithPriority: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: CorrelationRuleEngine,
          useValue: {
            findCorrelatedIdentity: jest
              .fn()
              .mockResolvedValue({ identity: null, matchedBy: null, confidence: 0 }),
          },
        },
        {
          provide: CandidateSuggestionService,
          useValue: { suggestCandidates: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: CorrelationHashService,
          useValue: { hash: jest.fn().mockImplementation((v: string) => `hash-${v}`) },
        },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: createMockEventEmitter() },
      ],
    }).compile();

    service = module.get(IdentityService);
    identityModel = module.get(getModelToken(Identity.name));
  });

  afterEach(async () => {
    await identityModel.deleteMany({}, { skipTenantScope: true });
  });

  afterAll(async () => {
    await module.close();
    await closeTestDb();
  });

  // ── saveOrUpdate ──────────────────────────────────────────

  describe('saveOrUpdate', () => {
    it('should create a new user when email does not exist', async () => {
      return withTestTenant(async () => {
        const dto = createSaveDto({ email: 'new@example.com' });
        const result = await service.saveOrUpdate(dto);

        expect(result).toBeDefined();
        expect((result as any).email).toBe('new@example.com');
        expect((result as any).firstName).toBe('John');

        const identity = await identityModel.findOne({ 'profile.email': 'new@example.com' });
        expect(identity).not.toBeNull();
        expect(identity!.profile.firstName).toBe('John');
        expect(identity!.profile.lastName).toBe('Doe');
      });
    });

    it('should update existing user on second call with same source key', async () => {
      return withTestTenant(async () => {
        const dto1 = createSaveDto({
          email: 'update@example.com',
          jobTitle: 'Junior',
          sourceUserId: 'EMP-UPDATE',
        });
        await service.saveOrUpdate(dto1);

        const dto2 = createSaveDto({
          email: 'update@example.com',
          jobTitle: 'Senior',
          sourceUserId: 'EMP-UPDATE',
        });
        await service.saveOrUpdate(dto2);

        const identities = await identityModel.find({ 'sources.externalId': 'EMP-UPDATE' });
        expect(identities).toHaveLength(1);
        // Profile is set on first save; subsequent updates go through reconciliation (mocked).
        // Verify source rawData was updated with new values.
        const source = identities[0].sources.find((s) => s.externalId === 'EMP-UPDATE');
        expect(source).toBeDefined();
        expect((source!.rawData as any)?.jobTitle).toBe('Senior');
        expect(identities[0].profile.email).toBe('update@example.com');
      });
    });

    it('should set sourceSystem from DTO', async () => {
      return withTestTenant(async () => {
        const dto = createSaveDto({ email: 'source@example.com', sourceSystem: 'WORKDAY' });
        const result = await service.saveOrUpdate(dto);
        expect((result as any).sourceSystem).toBe('WORKDAY');
      });
    });

    it('should default sourceSystem to hr-feed when not provided', async () => {
      return withTestTenant(async () => {
        const dto = createSaveDto({ email: 'default@example.com', sourceSystem: undefined });
        const result = await service.saveOrUpdate(dto);
        expect((result as any).sourceSystem).toBe('hr-feed');
      });
    });

    it('should compute primary contract fields', async () => {
      return withTestTenant(async () => {
        const dto = createSaveDto({
          email: 'contracts@example.com',
          contracts: [
            { id: 'c1', title: 'Junior', department: 'HR', isPrimary: false },
            { id: 'c2', title: 'Manager', department: 'Engineering', isPrimary: true },
          ] as any,
        });
        const result = await service.saveOrUpdate(dto);
        expect((result as any).jobTitle).toBe('Manager');
        expect((result as any).departmentCode).toBe('Engineering');
      });
    });

    it('should update same identity when email changes in HR (source-key match)', async () => {
      return withTestTenant(async () => {
        const dto1 = createSaveDto({
          email: 'old.email@example.com',
          sourceUserId: 'EMP-12345',
          jobTitle: 'Junior',
        });
        const first = await service.saveOrUpdate(dto1);

        const dto2 = createSaveDto({
          email: 'new.email@example.com',
          sourceUserId: 'EMP-12345',
          jobTitle: 'Senior',
        });
        const second = await service.saveOrUpdate(dto2);

        expect((first as any)._id.toString()).toBe((second as any)._id.toString());
        // Profile email is set on first save; source rawData gets updated email on second save.
        // Verify source rawData reflects the new email.
        const identities = await identityModel.find({ 'sources.externalId': 'EMP-12345' });
        expect(identities).toHaveLength(1);
        const source = identities[0].sources.find((s) => s.externalId === 'EMP-12345');
        expect((source!.rawData as any)?.email).toBe('new.email@example.com');
      });
    });
  });

  // ── findAll ────────────────────────────────────────────────

  describe('findAll', () => {
    it('should return all users', async () => {
      return withTestTenant(async () => {
        await service.saveOrUpdate(createSaveDto({ email: 'a@test.com', sourceUserId: 'A-001' }));
        await service.saveOrUpdate(createSaveDto({ email: 'b@test.com', sourceUserId: 'B-001' }));
        // A soft-deleted identity is not a user the list returns
        await identityModel.create({
          tenantId: TEST_TENANT_ID,
          profile: { firstName: 'Gone', lastName: 'User', email: 'gone@test.com' },
          deletedAt: new Date(),
        });

        const all = await service.findAll();
        expect(all).toHaveLength(2);
        expect(all.map((u) => u.email).sort()).toEqual(['a@test.com', 'b@test.com']);
      });
    });

    it('should return empty array when no users exist', async () => {
      return withTestTenant(async () => {
        const all = await service.findAll();
        expect(all).toEqual([]);
      });
    });
  });

  describe('findOne', () => {
    it('should find a user by ID', async () => {
      return withTestTenant(async () => {
        const dto = createSaveDto({ email: 'findme@test.com' });
        const created = await service.saveOrUpdate(dto);

        const found = await service.findOne((created as any)._id.toString());
        expect(found).toBeDefined();
        expect((found as any).email).toBe('findme@test.com');
      });
    });
  });

  // ── findOne ────────────────────────────────────────────────

  // ── pushSourceAndReconcile (sources hardening) ────────────────

  describe('pushSourceAndReconcile', () => {
    it('should not add duplicate source when same (sourceName, externalId) is pushed', async () => {
      return withTestTenant(async () => {
        const dto = createSaveDto({ email: 'dedup@test.com', sourceUserId: 'EMP-DEDUP' });
        const created = await service.saveOrUpdate(dto);
        const identityId = (created as any)._id.toString();

        await service.pushSourceAndReconcile(identityId, 'workday-prod', 'EMP-DEDUP', {
          jobTitle: 'Engineer',
        });
        await service.pushSourceAndReconcile(identityId, 'workday-prod', 'EMP-DEDUP', {
          jobTitle: 'Senior Engineer',
        });

        const identity = await identityModel.findById(identityId);
        expect(identity).not.toBeNull();
        const workdaySources = identity!.sources.filter((s) => s.sourceName === 'workday-prod');
        expect(workdaySources).toHaveLength(1);
        expect(workdaySources[0].rawData).toMatchObject({ jobTitle: 'Senior Engineer' });
      });
    });

    it('should throw BadRequestException when sources would exceed 50', async () => {
      return withTestTenant(async () => {
        const sources = Array.from({ length: 50 }, (_, i) => ({
          sourceName: `connector-${i}`,
          externalId: `ext-${i}`,
          lastSync: new Date(),
          rawData: {},
        }));
        const identity = await identityModel.create({
          tenantId: TEST_TENANT_ID,
          profile: {
            firstName: 'Test',
            lastName: 'User',
            email: 'sources-limit@test.com',
            status: 'ACTIVE',
          },
          sources,
          controls: {},
          provisioning: [],
        });

        await expect(
          service.pushSourceAndReconcile(identity._id.toString(), 'connector-50', 'ext-50', {}),
        ).rejects.toThrow(BadRequestException);
        await expect(
          service.pushSourceAndReconcile(identity._id.toString(), 'connector-50', 'ext-50', {}),
        ).rejects.toThrow('Identity sources array exceeds maximum of 50 entries');
      });
    });
  });

  // ── Optimistic concurrency retry ────────────────────────────

  describe('updateIdentityProfile (VersionError retry)', () => {
    it('should retry on VersionError and succeed', async () => {
      return withTestTenant(async () => {
        const dto = createSaveDto({
          email: 'retry@test.com',
          sourceUserId: 'EMP-RETRY',
          jobTitle: 'Junior',
        });
        const created = await service.saveOrUpdate(dto);
        const id = (created as any)._id.toString();

        let saveCallCount = 0;
        const originalFindOne = identityModel.findOne.bind(identityModel);
        jest.spyOn(identityModel, 'findOne').mockImplementation((...args: any[]) => {
          const query = originalFindOne(...args);
          const originalExec = query.exec.bind(query);
          query.exec = async () => {
            const doc = await originalExec();
            if (doc && typeof doc.save === 'function') {
              const originalSave = doc.save.bind(doc);
              (doc as any).save = async () => {
                saveCallCount++;
                if (saveCallCount === 1) {
                  const err = new Error('Version conflict');
                  (err as any).name = 'VersionError';
                  throw err;
                }
                return originalSave();
              };
            }
            return doc;
          };
          return query;
        });

        const updated = await service.update(id, { jobTitle: 'Senior' });
        expect(updated).toBeDefined();
        expect((updated as any).jobTitle).toBe('Senior');
        expect(saveCallCount).toBe(2);

        jest.restoreAllMocks();
      });
    });

    it('should throw ConflictException after max retries', async () => {
      return withTestTenant(async () => {
        const dto = createSaveDto({ email: 'maxretry@test.com', sourceUserId: 'EMP-MAXRETRY' });
        const created = await service.saveOrUpdate(dto);
        const id = (created as any)._id.toString();

        const versionError = new Error('Version conflict');
        (versionError as any).name = 'VersionError';

        const originalFindOne = identityModel.findOne.bind(identityModel);
        jest.spyOn(identityModel, 'findOne').mockImplementation((...args: any[]) => {
          const query = originalFindOne(...args);
          const originalExec = query.exec.bind(query);
          query.exec = async () => {
            const doc = await originalExec();
            if (doc && typeof doc.save === 'function') {
              (doc as any).save = jest.fn().mockRejectedValue(versionError);
            }
            return doc;
          };
          return query;
        });

        await expect(service.update(id, { jobTitle: 'Senior' })).rejects.toThrow(ConflictException);

        jest.restoreAllMocks();
      });
    });
  });
});
