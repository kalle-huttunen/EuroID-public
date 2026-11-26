/**
 * Unit tests for IdentityMutationService.
 *
 * Covers: saveOrUpdate (create + update paths), create (with event emission),
 * idempotent create, update (profile patch; an HR-mastered field refused, an unchanged body
 * written and recorded nowhere), markAsDeleted (soft delete).
 */
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { IdentityMutationService } from './identity-mutation.service';
import { IdentityCorrelationService } from './identity-correlation.service';
import { IdentityQueryService } from './identity-query.service';
import { ReconciliationService } from './reconciliation.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EVENT_SCHEMAS } from '@infrastructure/events/event-payload-schemas';
import {
  createMockLoggerFactory,
  createMockEventEmitter,
  TEST_TENANT_ID,
  withTestTenant,
} from '@testing';
import { createMockUser, createMockIdentityDocument } from '@testing';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';

// ---------------------------------------------------------------------------
// Helpers to build chainable Mongoose mock
// ---------------------------------------------------------------------------

function createChainable(resolvedValue: unknown = null) {
  return {
    lean: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(resolvedValue),
  };
}

/**
 * Build a mock IdentityDocument that behaves like a Mongoose HydratedDocument.
 * Supports `.toObject()`, `.save()`, `.set()`, and `.profile` access.
 */
function createHydratedMock(data: Record<string, unknown> = {}) {
  const base = createMockIdentityDocument(data);
  const doc: Record<string, unknown> = {
    ...base,
    toObject: jest.fn().mockReturnValue(base),
    save: jest.fn().mockResolvedValue(base),
    set: jest.fn((path: string, value: unknown) => {
      if (path === 'profile') {
        (doc as any).profile = value;
        (base as any).profile = value;
      }
    }),
  };
  return doc;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('IdentityMutationService', () => {
  let service: IdentityMutationService;
  let mockIdentityModel: Record<string, jest.Mock>;
  let mockCorrelationService: Record<string, jest.Mock>;
  let mockQueryService: Record<string, jest.Mock>;
  /** Who masters which field (PATCH refuses an HR-mastered one): none unless a test says so. */
  let mockReconciliation: { hrOwnersOf: jest.Mock };
  let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;
  let mockLogger: ReturnType<typeof createMockLoggerFactory>['logger'];

  beforeEach(async () => {
    jest.clearAllMocks();

    const { factory: loggerFactory, logger } = createMockLoggerFactory();
    mockLogger = logger;
    mockEventEmitter = createMockEventEmitter();
    // Add emitWithTransaction for transactional create path
    (mockEventEmitter as any).emitWithTransaction = jest.fn().mockResolvedValue(undefined);

    // --- Mongoose Model mock ---
    mockIdentityModel = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      create: jest.fn(),
      db: {
        startSession: jest.fn(),
      } as any,
    };

    // --- IdentityCorrelationService mock ---
    mockCorrelationService = {
      ensureIdentityFromUser: jest.fn(),
    };

    // --- IdentityQueryService mock ---
    mockQueryService = {
      findById: jest.fn(),
    };

    mockReconciliation = { hrOwnersOf: jest.fn().mockResolvedValue({}) };

    const module = await Test.createTestingModule({
      providers: [
        IdentityMutationService,
        { provide: getModelToken('Identity'), useValue: mockIdentityModel },
        { provide: IdentityCorrelationService, useValue: mockCorrelationService },
        { provide: IdentityQueryService, useValue: mockQueryService },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: mockEventEmitter },
        { provide: ReconciliationService, useValue: mockReconciliation },
      ],
    }).compile();

    service = module.get(IdentityMutationService);
  });

  // -----------------------------------------------------------------------
  // saveOrUpdate
  // -----------------------------------------------------------------------
  describe('saveOrUpdate', () => {
    it('creates new identity when ensureIdentityFromUser returns a new doc', async () => {
      const dto = createMockUser({
        email: 'new@example.com',
        sourceSystem: 'TestHR',
        sourceUserId: 'EMP-NEW',
      });
      const hydratedDoc = createHydratedMock({
        _id: 'new-identity-id',
        profile: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'new@example.com',
          status: 'ACTIVE',
          sourceSystem: 'TestHR',
          sourceUserId: 'EMP-NEW',
        },
        sources: [{ sourceName: 'testhr', externalId: 'EMP-NEW' }],
      });

      mockCorrelationService.ensureIdentityFromUser.mockResolvedValue(hydratedDoc);

      const result = await service.saveOrUpdate(dto);

      expect(mockCorrelationService.ensureIdentityFromUser).toHaveBeenCalledWith(
        dto,
        undefined,
        undefined,
        undefined,
        undefined, // no options (the bulk national ID hash)
      );
      expect(result).toBeDefined();
      expect(result._id).toBe('new-identity-id');
      expect(result.sourceSystem).toBe('TestHR');
    });

    it('updates existing identity when ensureIdentityFromUser finds a match', async () => {
      const dto = createMockUser({
        email: 'existing@example.com',
        sourceSystem: 'TestHR',
        sourceUserId: 'EMP-001',
      });
      const existingDoc = createHydratedMock({
        _id: 'existing-identity-id',
        profile: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'existing@example.com',
          status: 'ACTIVE',
          sourceSystem: 'TestHR',
          sourceUserId: 'EMP-001',
        },
        sources: [{ sourceName: 'testhr', externalId: 'EMP-001' }],
      });

      mockCorrelationService.ensureIdentityFromUser.mockResolvedValue(existingDoc);

      const beforeWrite = jest.fn();
      const beforeConflictFlag = jest.fn();
      const result = await service.saveOrUpdate(dto, undefined, beforeWrite, beforeConflictFlag);

      // The bulk rollback hooks reach the place that knows which identities are written.
      expect(mockCorrelationService.ensureIdentityFromUser).toHaveBeenCalledWith(
        dto,
        undefined,
        beforeWrite,
        beforeConflictFlag,
        undefined, // no options (the bulk national ID hash)
      );
      expect(result).toBeDefined();
      expect(result._id).toBe('existing-identity-id');
    });

    it('throws IdentityException when ensureIdentityFromUser returns null', async () => {
      const dto = createMockUser();
      mockCorrelationService.ensureIdentityFromUser.mockResolvedValue(null);

      await expect(service.saveOrUpdate(dto)).rejects.toThrow(
        'Failed to create or update Identity',
      );
    });
  });

  // -----------------------------------------------------------------------
  // saveOrUpdateReportingCreated (onboarding and bulk Hub writes, test seeding)
  // -----------------------------------------------------------------------
  describe('saveOrUpdateReportingCreated', () => {
    const dto = createMockUser({
      email: 'new@example.com',
      sourceSystem: 'TestHR',
      sourceUserId: 'EMP-NEW',
    });
    const saved = () =>
      createHydratedMock({
        _id: 'new-identity-id',
        tenantId: TEST_TENANT_ID,
        profile: { firstName: 'John', lastName: 'Doe', email: 'new@example.com', status: 'ACTIVE' },
        sources: [{ sourceName: 'testhr', externalId: 'EMP-NEW' }],
      });
    /** Correlation as it reports the write: null before it mints, the prior state otherwise. */
    const writes = (before: unknown) =>
      mockCorrelationService.ensureIdentityFromUser.mockImplementation(
        async (_dto: unknown, session: unknown, beforeWrite?: (state: unknown) => unknown) => {
          expect(session).toBeUndefined(); // the event is emitted at once: no transaction
          await beforeWrite?.(before);
          return saved();
        },
      );

    it('emits identity.created for an identity the write minted, ids and the source only', async () => {
      writes(null);
      const beforeWrite = jest.fn();

      await withTestTenant(() => service.saveOrUpdateReportingCreated(dto, beforeWrite));

      expect(beforeWrite).toHaveBeenCalledWith(null); // the bulk rollback snapshot still runs
      const created = mockEventEmitter.emit.mock.calls.filter(
        (call) => call[0] === DomainEventType.IDENTITY_CREATED,
      );
      expect(created).toEqual([
        [
          DomainEventType.IDENTITY_CREATED,
          'new-identity-id',
          { identityId: 'new-identity-id', sourceSystem: 'TestHR', status: 'ACTIVE' },
          { tenantId: TEST_TENANT_ID },
        ],
      ]);
      EVENT_SCHEMAS[DomainEventType.IDENTITY_CREATED]!.parse(created[0][2]);
      expect(JSON.stringify(created[0][2])).not.toContain('new@example.com');
    });

    it('emits nothing when the write updated an identity that existed', async () => {
      writes({ id: 'new-identity-id' });

      await withTestTenant(() => service.saveOrUpdateReportingCreated(dto));

      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // create
  // -----------------------------------------------------------------------
  describe('create', () => {
    it('creates identity with proper onion structure and emits IDENTITY_CREATED event', async () => {
      const dto = createMockUser({
        email: 'new.user@example.com',
        sourceSystem: 'TestHR',
        sourceUserId: 'EMP-CREATE',
      });

      const hydratedDoc = createHydratedMock({
        _id: 'created-identity-id',
        profile: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'new.user@example.com',
          status: 'ACTIVE',
          sourceSystem: 'TestHR',
          sourceUserId: 'EMP-CREATE',
        },
        sources: [{ sourceName: 'testhr', externalId: 'EMP-CREATE' }],
      });

      mockCorrelationService.ensureIdentityFromUser.mockResolvedValue(hydratedDoc);

      // Simulate MongoDB standalone (no replica set) — triggers the non-transactional fallback
      const sessionError = new Error(
        'Transaction numbers are only allowed on a replica set member',
      );
      const mockSession = {
        withTransaction: jest.fn().mockRejectedValue(sessionError),
        endSession: jest.fn(),
      };
      (mockIdentityModel.db as any).startSession.mockResolvedValue(mockSession);

      const result = await service.create(dto, 'test-actor');

      expect(result).toBeDefined();
      expect(result._id).toBe('created-identity-id');

      // Event emitted via non-transactional path, without the email (audit log, websocket)
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        DomainEventType.IDENTITY_CREATED,
        'created-identity-id',
        {
          identityId: 'created-identity-id',
          sourceSystem: 'TestHR',
          sourceUserId: 'EMP-CREATE',
          status: 'ACTIVE',
          triggerWorkflow: undefined,
        },
        expect.objectContaining({ actor: 'test-actor' }),
      );
    });

    it('puts no email in the event, nor in the source user id, when the caller gave none', async () => {
      const dto = createMockUser({ email: 'no.id@example.com', sourceUserId: undefined });
      mockCorrelationService.ensureIdentityFromUser.mockResolvedValue(
        createHydratedMock({
          _id: 'created-identity-id',
          profile: { email: 'no.id@example.com', status: 'ACTIVE' },
          sources: [{ sourceName: 'testhr', externalId: 'no.id@example.com' }],
        }),
      );
      (mockIdentityModel.db as any).startSession.mockResolvedValue({
        withTransaction: jest.fn().mockRejectedValue(new Error('replica set required')),
        endSession: jest.fn(),
      });

      await service.create(dto, 'test-actor', { triggerWorkflow: true });

      const [, aggregateId, payload] = (mockEventEmitter.emit as jest.Mock).mock.calls.find(
        ([type]) => type === DomainEventType.IDENTITY_CREATED,
      );
      expect(aggregateId).toBe('created-identity-id');
      expect(payload).not.toHaveProperty('sourceUserId');
      expect(JSON.stringify(payload)).not.toContain('no.id@example.com');
      expect(payload).toMatchObject({ triggerWorkflow: true });
      expect(EVENT_SCHEMAS[DomainEventType.IDENTITY_CREATED]!.parse(payload)).toEqual(payload);
    });

    it('creates via transactional path and emits IDENTITY_CREATED via emitWithTransaction', async () => {
      const dto = createMockUser({
        email: 'txn.user@example.com',
        sourceSystem: 'TestHR',
        sourceUserId: 'EMP-TXN',
      });

      const hydratedDoc = createHydratedMock({
        _id: 'txn-identity-id',
        profile: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'txn.user@example.com',
          status: 'ACTIVE',
          sourceSystem: 'TestHR',
          sourceUserId: 'EMP-TXN',
        },
        sources: [{ sourceName: 'testhr', externalId: 'EMP-TXN' }],
      });

      mockCorrelationService.ensureIdentityFromUser.mockResolvedValue(hydratedDoc);

      // Simulate replica set (transactional path succeeds)
      const mockSession = {
        withTransaction: jest.fn().mockImplementation(async (fn: () => Promise<void>) => {
          await fn();
        }),
        endSession: jest.fn(),
      };
      (mockIdentityModel.db as any).startSession.mockResolvedValue(mockSession);

      const result = await service.create(dto, 'txn-actor');

      expect(result).toBeDefined();
      expect(result._id).toBe('txn-identity-id');

      // Event emitted via transactional path
      expect((mockEventEmitter as any).emitWithTransaction).toHaveBeenCalledWith(
        DomainEventType.IDENTITY_CREATED,
        'txn-identity-id',
        expect.objectContaining({
          identityId: 'txn-identity-id',
          sourceSystem: 'TestHR',
          sourceUserId: 'EMP-TXN',
        }),
        mockSession,
        expect.objectContaining({ actor: 'txn-actor' }),
      );
    });

    it('ends the session it started, after a transaction and after falling back', async () => {
      const dto = createMockUser({ email: 'session@example.com', sourceUserId: 'EMP-SES' });
      mockCorrelationService.ensureIdentityFromUser.mockResolvedValue(
        createHydratedMock({
          _id: 'session-identity-id',
          profile: { email: 'session@example.com', status: 'ACTIVE' },
          sources: [{ sourceName: 'testhr', externalId: 'EMP-SES' }],
        }),
      );
      const transactional = {
        withTransaction: jest.fn(async (fn: () => Promise<void>) => fn()),
        endSession: jest.fn(),
      };
      const standalone = {
        withTransaction: jest.fn().mockRejectedValue(new Error('replica set required')),
        endSession: jest.fn(),
      };
      (mockIdentityModel.db as any).startSession
        .mockResolvedValueOnce(transactional)
        .mockResolvedValueOnce(standalone);

      await service.create(dto, 'actor');
      await service.create(dto, 'actor');

      expect(transactional.endSession).toHaveBeenCalledTimes(1);
      expect(standalone.endSession).toHaveBeenCalledTimes(1);
    });

    it('idempotent: duplicate email with same sourceSystem/sourceUserId reuses existing identity', async () => {
      const dto = createMockUser({
        email: 'dup@example.com',
        sourceSystem: 'TestHR',
        sourceUserId: 'EMP-DUP',
      });

      // ensureIdentityFromUser returns the same doc on both calls (correlation finds existing)
      const existingDoc = createHydratedMock({
        _id: 'existing-dup-id',
        profile: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'dup@example.com',
          status: 'ACTIVE',
          sourceSystem: 'TestHR',
          sourceUserId: 'EMP-DUP',
        },
        sources: [{ sourceName: 'testhr', externalId: 'EMP-DUP' }],
      });

      mockCorrelationService.ensureIdentityFromUser.mockResolvedValue(existingDoc);

      // Standalone fallback path
      const sessionError = new Error(
        'Transaction numbers are only allowed on a replica set member',
      );
      const mockSession = {
        withTransaction: jest.fn().mockRejectedValue(sessionError),
        endSession: jest.fn(),
      };
      (mockIdentityModel.db as any).startSession.mockResolvedValue(mockSession);

      const result1 = await service.create(dto, 'actor-1');
      const result2 = await service.create(dto, 'actor-2');

      // Both calls returned the same identity
      expect(result1._id).toBe('existing-dup-id');
      expect(result2._id).toBe('existing-dup-id');

      // ensureIdentityFromUser was called twice (idempotent upsert)
      expect(mockCorrelationService.ensureIdentityFromUser).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // update
  // -----------------------------------------------------------------------
  describe('update', () => {
    it('applies profile updates for owned fields and emits IDENTITY_UPDATED', async () => {
      await withTestTenant(async () => {
        const identityId = 'update-id-001';
        const updateDto = { jobTitle: 'Senior Engineer', departmentName: 'Platform' };

        // saveWithRetry calls findOne then modify+save
        const existingDoc = createHydratedMock({
          _id: identityId,
          profile: {
            firstName: 'John',
            lastName: 'Doe',
            email: 'john@example.com',
            jobTitle: 'Software Engineer',
            departmentName: 'Engineering',
            status: 'ACTIVE',
          },
        });

        const findOneChainable = createChainable(existingDoc);
        mockIdentityModel.findOne.mockReturnValue(findOneChainable);

        // findById returns the updated result
        const updatedResult = {
          _id: identityId,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          jobTitle: 'Senior Engineer',
          departmentName: 'Platform',
          status: 'ACTIVE',
        };
        mockQueryService.findById.mockResolvedValue(updatedResult);

        const result = await service.update(identityId, updateDto, 'admin-user');

        expect(result).toEqual(updatedResult);
        expect(mockIdentityModel.findOne).toHaveBeenCalledWith(
          expect.objectContaining({ _id: identityId }),
        );

        // Verify IDENTITY_UPDATED event emitted
        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          DomainEventType.IDENTITY_UPDATED,
          identityId,
          expect.objectContaining({
            identityId,
            changedFields: expect.arrayContaining(['jobTitle', 'departmentName']),
            source: 'admin-user',
          }),
          expect.objectContaining({ actor: 'admin-user' }),
        );
      });
    });

    it('leaves PII out of IDENTITY_UPDATED previousAttributes and keeps access attributes', async () => {
      await withTestTenant(async () => {
        const identityId = 'pii-prev-001';
        const existingDoc = createHydratedMock({
          _id: identityId,
          profile: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@corp.example',
            personalEmail: 'ada.lovelace@home.example',
            mobilePhone: '+358 40 123 4567',
            departmentName: 'Engineering',
            status: 'ACTIVE',
          },
        });
        mockIdentityModel.findOne.mockReturnValue(createChainable(existingDoc));
        mockQueryService.findById.mockResolvedValue({ _id: identityId });

        await service.update(
          identityId,
          {
            personalEmail: 'ada@new-home.example',
            mobilePhone: '+358 50 765 4321',
            departmentName: 'Research',
          },
          'editor',
        );

        const call = mockEventEmitter.emit.mock.calls.find(
          (c: unknown[]) => c[0] === DomainEventType.IDENTITY_UPDATED,
        );
        const payload = call?.[2] as { changedFields: string[]; previousAttributes: unknown };
        // The timeline still sees which PII fields changed, never their old values: the event
        // reaches the audit log, the analytics index and the tenant websocket.
        expect(payload.changedFields).toEqual(['personalEmail', 'mobilePhone', 'departmentName']);
        expect(payload.previousAttributes).toEqual({ departmentName: 'Engineering' });
        expect(JSON.stringify(payload)).not.toContain('ada.lovelace@home.example');
        expect(JSON.stringify(payload)).not.toContain('123 4567');
        expect(JSON.stringify(payload)).not.toContain('4567');
      });
    });

    // The identity page sends every profile field on save: a trigger attribute it sent unchanged
    // must not start the mover, and names and identifiers no policy reads stay out of the event.
    it('puts in previousAttributes only the access attributes whose value the edit changed', async () => {
      await withTestTenant(async () => {
        const identityId = 'prev-changed-001';
        const existingDoc = createHydratedMock({
          _id: identityId,
          profile: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@corp.example',
            employeeId: 'E1',
            departmentName: 'Engineering',
            jobTitle: 'Analyst',
            managerEmail: 'old.boss@corp.example',
            status: 'ACTIVE',
          },
        });
        mockIdentityModel.findOne.mockReturnValue(createChainable(existingDoc));
        mockQueryService.findById.mockResolvedValue({ _id: identityId });

        await service.update(
          identityId,
          {
            firstName: 'Augusta',
            lastName: 'Lovelace',
            employeeId: 'E2',
            departmentName: 'Engineering',
            jobTitle: 'Lead Analyst',
            managerEmail: 'new.boss@corp.example',
            location: 'Helsinki',
          },
          'editor',
        );

        const call = mockEventEmitter.emit.mock.calls.find(
          (c: unknown[]) => c[0] === DomainEventType.IDENTITY_UPDATED,
        );
        const payload = call?.[2] as { changedFields: string[]; previousAttributes: unknown };
        expect(payload.changedFields).toEqual([
          'firstName',
          'lastName',
          'employeeId',
          'departmentName',
          'jobTitle',
          'managerEmail',
          'location',
        ]);
        // location had no value before: null, so the mover evaluates the profile without it.
        // The old manager is masked (plan 2.0dn): the mover reads it from the access baseline.
        expect(payload.previousAttributes).toEqual({
          jobTitle: 'Analyst',
          managerEmail: 'o•••@corp.example',
          location: null,
        });
      });
    });

    // Plan 2.0dn: the event reaches the audit log, the analytics index, the tenant websocket and,
    // when a handler fails, the dead-letter store. Handlers read the address from the identity.
    it('emits IDENTITY_UPDATED with no email address: none of the identity, the old manager masked', async () => {
      await withTestTenant(async () => {
        const identityId = 'no-email-001';
        const existingDoc = createHydratedMock({
          _id: identityId,
          profile: {
            email: 'ada@corp.example',
            departmentName: 'Engineering',
            managerEmail: 'old.boss@corp.example',
            status: 'ACTIVE',
          },
        });
        mockIdentityModel.findOne.mockReturnValue(createChainable(existingDoc));
        mockQueryService.findById.mockResolvedValue({ _id: identityId });

        await service.update(identityId, { managerEmail: 'new.boss@corp.example' }, 'editor');

        const call = mockEventEmitter.emit.mock.calls.find(
          (c: unknown[]) => c[0] === DomainEventType.IDENTITY_UPDATED,
        );
        const payload = call?.[2] as Record<string, unknown>;
        expect(payload).not.toHaveProperty('email');
        expect(payload.previousAttributes).toEqual({ managerEmail: 'o•••@corp.example' });
        expect(JSON.stringify(payload)).not.toMatch(/ada@|old\.boss@|new\.boss@/);
      });
    });

    it('puts no before-value for a manager the edit sent unchanged', async () => {
      await withTestTenant(async () => {
        const identityId = 'same-manager-001';
        const existingDoc = createHydratedMock({
          _id: identityId,
          profile: {
            email: 'ada@corp.example',
            departmentName: 'Engineering',
            managerEmail: 'boss@corp.example',
            status: 'ACTIVE',
          },
        });
        mockIdentityModel.findOne.mockReturnValue(createChainable(existingDoc));
        mockQueryService.findById.mockResolvedValue({ _id: identityId });

        await service.update(
          identityId,
          { managerEmail: 'boss@corp.example', departmentName: 'Research' },
          'editor',
        );

        const call = mockEventEmitter.emit.mock.calls.find(
          (c: unknown[]) => c[0] === DomainEventType.IDENTITY_UPDATED,
        );
        expect((call?.[2] as Record<string, unknown>).previousAttributes).toEqual({
          departmentName: 'Engineering',
        });
      });
    });

    it('strips immutable fields (_id, sourceSystem, sourceUserId, tenantId) from updates', async () => {
      await withTestTenant(async () => {
        const identityId = 'strip-id-001';
        const updateDto = {
          _id: 'malicious-override',
          sourceSystem: 'hacked-system',
          sourceUserId: 'hacked-id',
          tenantId: 'hacked-tenant',
          jobTitle: 'Updated Title',
        };

        const existingDoc = createHydratedMock({
          _id: identityId,
          profile: {
            firstName: 'Jane',
            lastName: 'Smith',
            email: 'jane@example.com',
            jobTitle: 'Engineer',
            status: 'ACTIVE',
          },
        });

        const findOneChainable = createChainable(existingDoc);
        mockIdentityModel.findOne.mockReturnValue(findOneChainable);
        mockQueryService.findById.mockResolvedValue({ _id: identityId, jobTitle: 'Updated Title' });

        await service.update(identityId, updateDto as any, 'editor');

        // The set call should only contain jobTitle (stripped immutable fields)
        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          DomainEventType.IDENTITY_UPDATED,
          identityId,
          expect.objectContaining({
            changedFields: ['jobTitle'],
          }),
          expect.any(Object),
        );
      });
    });
  });

  // -----------------------------------------------------------------------
  // update: authoritative attributes (owner decision 2026-11-24)
  // -----------------------------------------------------------------------
  describe('update of an HR-mastered field', () => {
    /** PATCH /identity/:id and SCIM inbound ask for the refusal. */
    const PATCH_ROUTE = { refuseHrMastered: true };

    /** Ada from csv-hr: the HR source masters what it carries, EuroID the rest. */
    function adaDoc(extra: Record<string, unknown> = {}) {
      const doc = createHydratedMock({
        _id: 'ada-001',
        profile: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@corp.example',
          departmentName: 'Engineering',
          jobTitle: 'Engineer',
          status: 'ACTIVE',
        },
        sources: [
          {
            sourceName: 'csv-hr',
            sourceRole: 'primary-hr',
            rawData: { departmentName: 'Engineering', jobTitle: 'Engineer' },
          },
        ],
        ...extra,
      });
      mockIdentityModel.findOne.mockReturnValue(createChainable(doc));
      mockQueryService.findById.mockResolvedValue({ _id: 'ada-001' });
      return doc;
    }

    const updated = () =>
      mockEventEmitter.emit.mock.calls.filter(
        (c: unknown[]) => c[0] === DomainEventType.IDENTITY_UPDATED,
      );

    it('refuses with 409 naming the owner and the way out, and writes and emits nothing', async () => {
      await withTestTenant(async () => {
        const doc = adaDoc();
        mockReconciliation.hrOwnersOf.mockResolvedValue({ departmentName: 'csv-hr' });

        const refused = service.update('ada-001', { departmentName: 'Sales' }, 'op@corp.example', {
          refuseHrMastered: true,
        });

        await expect(refused).rejects.toThrow(ConflictException);
        await expect(refused).rejects.toThrow(
          'departmentName is mastered by csv-hr: change it in HR, or set an override.',
        );
        expect(doc.save).not.toHaveBeenCalled();
        expect(updated()).toEqual([]);
      });
    });

    // Hunt 2026-11-25 02 F4: contracts are not stored; their primary contract set the job title
    // and the department after the check, which saw only the key `contracts`
    it('refuses contracts whose primary contract changes an HR-mastered title or department', async () => {
      await withTestTenant(async () => {
        const doc = adaDoc();
        mockReconciliation.hrOwnersOf.mockImplementation(async (_doc: unknown, fields: string[]) =>
          Object.fromEntries(
            fields
              .filter((f) => ['departmentName', 'jobTitle'].includes(f))
              .map((f) => [f, 'csv-hr']),
          ),
        );
        const contracts = [
          { id: 'c1', title: 'CFO', department: 'Finance', isPrimary: true, status: 'ACTIVE' },
        ] as const;

        const refused = service.update(
          'ada-001',
          { contracts: [...contracts] },
          'op@corp.example',
          PATCH_ROUTE,
        );

        await expect(refused).rejects.toThrow(ConflictException);
        await expect(refused).rejects.toThrow('jobTitle is mastered by csv-hr');
        expect(doc.save).not.toHaveBeenCalled();
        expect(updated()).toEqual([]);
      });
    });

    it('reports the fields contracts changed, never `contracts`, to identity.updated', async () => {
      await withTestTenant(async () => {
        adaDoc({ sources: [] });
        const contracts = [
          { id: 'c1', title: 'CFO', department: 'Finance', isPrimary: true, status: 'ACTIVE' },
        ] as const;

        await service.update('ada-001', { contracts: [...contracts] }, 'op', PATCH_ROUTE);

        const [[, , payload]] = updated();
        expect((payload as { changedFields: string[] }).changedFields.sort()).toEqual([
          'departmentCode',
          'departmentName',
          'jobTitle',
        ]);
      });
    });

    it('offers no override for a field the controls cannot override', async () => {
      await withTestTenant(async () => {
        adaDoc();
        mockReconciliation.hrOwnersOf.mockResolvedValue({ firstName: 'csv-hr' });

        await expect(
          service.update('ada-001', { firstName: 'Augusta' }, 'op', PATCH_ROUTE),
        ).rejects.toThrow('firstName is mastered by csv-hr: change it in HR.');
      });
    });

    it('passes a body that repeats an HR-mastered value (a full SCIM PUT), and saves a field EuroID keeps', async () => {
      await withTestTenant(async () => {
        const doc = adaDoc();
        // As ReconciliationService: the HR source masters the department and the title
        mockReconciliation.hrOwnersOf.mockImplementation(async (_doc: unknown, fields: string[]) =>
          Object.fromEntries(
            fields
              .filter((f) => ['departmentName', 'jobTitle'].includes(f))
              .map((f) => [f, 'csv-hr']),
          ),
        );

        await service.update(
          'ada-001',
          { departmentName: 'Engineering', preferredName: 'Ada L.' },
          'op@corp.example',
          PATCH_ROUTE,
        );

        expect(mockReconciliation.hrOwnersOf).toHaveBeenCalledWith(doc, ['preferredName']);
        expect(doc.save).toHaveBeenCalled();
        expect(updated()).toHaveLength(1);
      });
    });

    it('refuses only when the caller asks (PATCH /identity/:id, SCIM inbound)', async () => {
      await withTestTenant(async () => {
        const doc = adaDoc();
        mockReconciliation.hrOwnersOf.mockResolvedValue({ departmentName: 'csv-hr' });

        await service.update('ada-001', { departmentName: 'Sales' }, 'internal');

        expect(mockReconciliation.hrOwnersOf).not.toHaveBeenCalled();
        expect(doc.save).toHaveBeenCalled();
      });
    });

    it('refuses an edit of a department that has an active override', async () => {
      await withTestTenant(async () => {
        adaDoc({ controls: { manualDepartment: 'R&D' } });

        await expect(
          service.update('ada-001', { departmentName: 'Sales' }, 'op', PATCH_ROUTE),
        ).rejects.toThrow('departmentName has an override: change or remove the override instead.');
      });
    });

    // An unchanged save from the identity page wrote "Updated: " with "0 field(s) updated"
    it.each([
      ['an empty body', {}],
      ['every value as stored', { firstName: 'Ada', jobTitle: 'Engineer', middleName: '' }],
    ])('writes nothing and emits no identity.updated for %s', async (_label, body) => {
      await withTestTenant(async () => {
        const doc = adaDoc();

        const result = await service.update('ada-001', body, 'op@corp.example', PATCH_ROUTE);

        expect(result).toEqual({ _id: 'ada-001' });
        expect(doc.save).not.toHaveBeenCalled();
        expect(updated()).toEqual([]);
        expect(mockReconciliation.hrOwnersOf).not.toHaveBeenCalled();
      });
    });

    it('answers 404 for an identity of another tenant or none', async () => {
      await withTestTenant(async () => {
        mockIdentityModel.findOne.mockReturnValue(createChainable(null));

        await expect(service.update('nope', { jobTitle: 'X' }, 'op', PATCH_ROUTE)).rejects.toThrow(
          NotFoundException,
        );
      });
    });
  });

  // -----------------------------------------------------------------------
  // markAsDeleted
  // -----------------------------------------------------------------------
  describe('markAsDeleted', () => {
    it('sets deletedAt timestamp and emits IDENTITY_DELETED event', async () => {
      await withTestTenant(async () => {
        const identityId = 'delete-id-001';

        const existingDoc = {
          _id: identityId,
          profile: { email: 'todelete@example.com' },
        };

        const findOneExecChain = createChainable(existingDoc);
        const findOneUpdateExecChain = createChainable(existingDoc);

        mockIdentityModel.findOne.mockReturnValue(findOneExecChain);
        mockIdentityModel.findOneAndUpdate.mockReturnValue(findOneUpdateExecChain);

        const result = await service.markAsDeleted(identityId);

        expect(result).toBeDefined();
        expect(result!._id).toBe(identityId);
        expect(result!.email).toBe('todelete@example.com');
        expect(result!.deletedAt).toBeInstanceOf(Date);

        // findOneAndUpdate was called with $set: { deletedAt, deletedBy }
        expect(mockIdentityModel.findOneAndUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ _id: identityId }),
          { $set: expect.objectContaining({ deletedBy: 'offboarding-workflow' }) },
        );

        // IDENTITY_DELETED event emitted
        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          DomainEventType.IDENTITY_DELETED,
          identityId,
          expect.objectContaining({
            identityId,
            reason: 'offboarding-workflow',
          }),
          expect.objectContaining({ actor: 'offboarding-workflow' }),
        );
      });
    });

    it('records the admin who completed the offboarding by hand as deleter and actor', async () => {
      await withTestTenant(async () => {
        const existingDoc = { _id: 'delete-id-002', profile: { email: 'x@example.com' } };
        mockIdentityModel.findOne.mockReturnValue(createChainable(existingDoc));
        mockIdentityModel.findOneAndUpdate.mockReturnValue(createChainable(existingDoc));

        await service.markAsDeleted('delete-id-002', { actor: 'admin@a', reason: 'manual' });

        expect(mockIdentityModel.findOneAndUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ _id: 'delete-id-002' }),
          { $set: expect.objectContaining({ deletedBy: 'admin@a' }) },
        );
        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          DomainEventType.IDENTITY_DELETED,
          'delete-id-002',
          { identityId: 'delete-id-002', reason: 'manual' },
          { actor: 'admin@a' },
        );
      });
    });

    it('returns null when identity not found', async () => {
      await withTestTenant(async () => {
        const findOneExecChain = createChainable(null);
        mockIdentityModel.findOne.mockReturnValue(findOneExecChain);

        const result = await service.markAsDeleted('nonexistent-id');

        expect(result).toBeNull();
        expect(mockIdentityModel.findOneAndUpdate).not.toHaveBeenCalled();
        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });
    });

    it('returns null when identity has no email', async () => {
      await withTestTenant(async () => {
        const docWithoutEmail = { _id: 'no-email-id', profile: {} };
        const findOneExecChain = createChainable(docWithoutEmail);
        mockIdentityModel.findOne.mockReturnValue(findOneExecChain);

        const result = await service.markAsDeleted('no-email-id');

        expect(result).toBeNull();
        expect(mockIdentityModel.findOneAndUpdate).not.toHaveBeenCalled();
        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });
    });
  });
});
