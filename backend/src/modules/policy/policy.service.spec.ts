/**
 * Unit tests for PolicyService
 * Covers SoD: DRAFT on create, createdBy, status immutable via PATCH, activate peer-review, toggleStatus DRAFT guard
 */

import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { Policy, PolicyDocument, PolicyStatus } from './schemas/policy.schema';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { createMockEventEmitter } from '@testing/test-helpers';

describe('PolicyService', () => {
  let service: PolicyService;
  let mockPolicyModel: {
    create: jest.Mock;
    find: jest.Mock;
    findById: jest.Mock;
    findByIdAndDelete: jest.Mock;
    bulkWrite: jest.Mock;
  };

  const mockSave = jest.fn();
  const createMockDoc = (overrides: Partial<PolicyDocument> = {}) => ({
    _id: 'policy-123',
    tenantId: 'tenant-1',
    name: 'Test Policy',
    status: PolicyStatus.DRAFT,
    createdBy: 'creator@acme.com',
    save: mockSave,
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSave.mockImplementation(function (this: any) {
      return Promise.resolve(this);
    });

    const findChain = {
      sort: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    mockPolicyModel = {
      create: jest
        .fn()
        .mockImplementation((dto) => Promise.resolve(createMockDoc({ ...dto, _id: 'policy-123' }))),
      find: jest.fn().mockReturnValue(findChain),
      findById: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      }),
      findByIdAndDelete: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      bulkWrite: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    };

    const mockEntitlementCatalog = {
      registerPolicyGroup: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        PolicyService,
        { provide: getModelToken(Policy.name), useValue: mockPolicyModel },
        { provide: EntitlementCatalogService, useValue: mockEntitlementCatalog },
        { provide: DomainEventEmitterService, useValue: createMockEventEmitter() },
      ],
    }).compile();

    service = module.get(PolicyService);
  });

  describe('create', () => {
    it('always creates policy with status DRAFT regardless of input', async () => {
      const dto = {
        tenantId: 'tenant-1',
        name: 'New Policy',
        status: PolicyStatus.ACTIVE,
      };
      const doc = await service.create(dto as any, 'admin@acme.com');

      expect(mockPolicyModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: PolicyStatus.DRAFT,
          createdBy: 'admin@acme.com',
        }),
      );
      expect(doc.status).toBe(PolicyStatus.DRAFT);
    });

    it('sets createdBy from actor on document', async () => {
      await service.create({ tenantId: 't1', name: 'P' } as any, 'policy-admin@acme.com');

      expect(mockPolicyModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          createdBy: 'policy-admin@acme.com',
        }),
      );
    });
  });

  describe('update', () => {
    it('strips status from update DTO — status unchanged', async () => {
      const existing = createMockDoc({
        status: PolicyStatus.DRAFT,
        name: 'Original',
      });
      mockPolicyModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(existing),
      });

      await service.update('policy-123', { status: PolicyStatus.ACTIVE } as any);

      expect(mockSave).toHaveBeenCalled();
      expect(existing.status).toBe(PolicyStatus.DRAFT);
    });

    // PE-1: a change of what a policy grants needs a second policy-admin (activate) again
    const grantChanges: Array<[string, Partial<Policy>]> = [
      ['actions', { actions: [] }],
      ['conditions', { conditionGroups: [] }],
      ['role bundle', { roleBundleId: 'bundle-2' }],
    ];

    it.each(grantChanges)(
      'sends an ACTIVE policy back to DRAFT when its %s change',
      async (_label, dto) => {
        const existing = createMockDoc({ status: PolicyStatus.ACTIVE });
        mockPolicyModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(existing) });

        await service.update('policy-123', dto);

        expect(existing.status).toBe(PolicyStatus.DRAFT);
      },
    );

    // FOLLOWUPS 2026-11-24 (policy.service.ts:87 with toggleStatus): disable, edit, toggle back
    // to ACTIVE skipped the second policy-admin.
    it.each(grantChanges)(
      'sends a DISABLED policy back to DRAFT when its %s change, so it cannot be toggled on',
      async (_label, dto) => {
        const existing = createMockDoc({ status: PolicyStatus.DISABLED });
        mockPolicyModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(existing) });

        await service.update('policy-123', dto);

        expect(existing.status).toBe(PolicyStatus.DRAFT);
        await expect(service.toggleStatus('policy-123')).rejects.toThrow(
          'Draft policies cannot be toggled',
        );
        expect(existing.status).toBe(PolicyStatus.DRAFT);
      },
    );

    it('sends a TESTING policy back to DRAFT when what it grants changes', async () => {
      const existing = createMockDoc({ status: PolicyStatus.TESTING });
      mockPolicyModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(existing) });

      await service.update('policy-123', { actions: [] });

      expect(existing.status).toBe(PolicyStatus.DRAFT);
    });

    it('keeps the status when only the name or description changes', async () => {
      const existing = createMockDoc({ status: PolicyStatus.DISABLED });
      mockPolicyModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(existing) });

      await service.update('policy-123', { name: 'Renamed', description: 'New text' });

      expect(existing.status).toBe(PolicyStatus.DISABLED);
    });
  });

  // The engine runs a policy's regex conditions against every identity: a pattern with
  // catastrophic backtracking is refused when the policy is saved
  describe('regex conditions (ReDoS guard)', () => {
    const withRegex = (value: string): Partial<Policy> => ({
      conditionGroups: [
        {
          id: 'g1',
          join: 'AND',
          conditions: [{ id: 'c1', field: 'departmentCode', operator: 'regex', value }],
        },
      ],
    });

    it('refuses an unsafe pattern on create and on update, saving nothing', async () => {
      const existing = createMockDoc({ status: PolicyStatus.DRAFT });
      mockPolicyModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(existing) });

      await expect(
        service.create({ name: 'P', ...withRegex('(a+)+$') }, 'admin@acme.com'),
      ).rejects.toThrow(BadRequestException);
      await expect(service.update('policy-123', withRegex('(a+)+$'))).rejects.toThrow(
        'Regex pattern "(a+)+$" is unsafe (ReDoS risk)',
      );

      expect(mockPolicyModel.create).not.toHaveBeenCalled();
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('saves a safe pattern', async () => {
      const existing = createMockDoc({ status: PolicyStatus.DRAFT });
      mockPolicyModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(existing) });

      await service.create({ name: 'P', ...withRegex('^eng-.*$') }, 'admin@acme.com');
      await service.update('policy-123', withRegex('^eng-.*$'));

      expect(mockPolicyModel.create).toHaveBeenCalledTimes(1);
      expect(mockSave).toHaveBeenCalledTimes(1);
    });
  });

  // FOLLOWUPS 2026-11-24 (policy.service.ts:205): activation compared only createdBy, so an admin
  // who changed another admin's policy could activate their own change.
  describe('activate after an edit of what the policy grants', () => {
    const ALICE = 'alice@acme.com';
    const BOB = 'bob@acme.com';
    const CAROL = 'carol@acme.com';
    let policy: ReturnType<typeof createMockDoc>;

    beforeEach(() => {
      policy = createMockDoc({ status: PolicyStatus.ACTIVE, createdBy: ALICE });
      mockPolicyModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(policy) });
    });

    it('refuses the admin who changed the grants; a third admin activates', async () => {
      await service.update('policy-123', { actions: [] }, BOB);

      expect(policy).toMatchObject({ status: PolicyStatus.DRAFT, lastEditedBy: BOB });
      expect(policy.lastEditedAt).toBeInstanceOf(Date);
      await expect(service.activate('policy-123', BOB)).rejects.toThrow(ForbiddenException);
      await expect(service.activate('policy-123', BOB)).rejects.toThrow('last editor');
      expect(policy.status).toBe(PolicyStatus.DRAFT);

      await service.activate('policy-123', CAROL);
      expect(policy.status).toBe(PolicyStatus.ACTIVE);
    });

    it('lets the creator review another admin’s change', async () => {
      await service.update('policy-123', { conditionGroups: [] }, BOB);
      await service.activate('policy-123', ALICE);
      expect(policy.status).toBe(PolicyStatus.ACTIVE);
    });

    it('refuses a creator who changed the grants of their own policy', async () => {
      await service.update('policy-123', { roleBundleId: 'bundle-2' }, ALICE);
      await expect(service.activate('policy-123', ALICE)).rejects.toThrow(ForbiddenException);
    });

    it('records no editor for a name or description change, nor from the input', async () => {
      await service.update(
        'policy-123',
        { name: 'Renamed', lastEditedBy: CAROL, createdBy: CAROL } as Partial<Policy>,
        BOB,
      );

      expect(policy.lastEditedBy).toBeUndefined();
      expect(policy.createdBy).toBe(ALICE);
      await expect(service.toggleStatus('policy-123')).resolves.toBeDefined();
    });
  });

  describe('activate', () => {
    it('throws ForbiddenException when activatedBy === createdBy', async () => {
      const policy = createMockDoc({
        status: PolicyStatus.DRAFT,
        createdBy: 'alice@acme.com',
      });
      mockPolicyModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(policy),
      });

      await expect(service.activate('policy-123', 'alice@acme.com')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.activate('policy-123', 'alice@acme.com')).rejects.toThrow(
        'Segregation of Duties',
      );
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('succeeds when activatedBy !== createdBy', async () => {
      const policy = createMockDoc({
        status: PolicyStatus.DRAFT,
        createdBy: 'alice@acme.com',
      });
      mockPolicyModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(policy),
      });

      const result = await service.activate('policy-123', 'bob@acme.com');

      expect(mockSave).toHaveBeenCalled();
      expect(policy.status).toBe(PolicyStatus.ACTIVE);
      expect(result.status).toBe(PolicyStatus.ACTIVE);
    });

    it('allows activation when createdBy is system (legacy)', async () => {
      const policy = createMockDoc({
        status: PolicyStatus.DRAFT,
        createdBy: 'system',
      });
      mockPolicyModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(policy),
      });

      await service.activate('policy-123', 'admin@acme.com');

      expect(mockSave).toHaveBeenCalled();
      expect(policy.status).toBe(PolicyStatus.ACTIVE);
    });

    it('throws BadRequestException when policy is already ACTIVE', async () => {
      const policy = createMockDoc({
        status: PolicyStatus.ACTIVE,
        createdBy: 'alice@acme.com',
      });
      mockPolicyModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(policy),
      });

      await expect(service.activate('policy-123', 'bob@acme.com')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.activate('policy-123', 'bob@acme.com')).rejects.toThrow(
        'already active',
      );
    });

    it('throws BadRequestException when policy is in TESTING', async () => {
      const policy = createMockDoc({
        status: PolicyStatus.TESTING,
        createdBy: 'alice@acme.com',
      });
      mockPolicyModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(policy),
      });

      await expect(service.activate('policy-123', 'bob@acme.com')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.activate('policy-123', 'bob@acme.com')).rejects.toThrow('testing');
    });
  });

  describe('toggleStatus', () => {
    it('throws BadRequestException when policy is DRAFT', async () => {
      const policy = createMockDoc({ status: PolicyStatus.DRAFT });
      mockPolicyModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(policy),
      });

      await expect(service.toggleStatus('policy-123')).rejects.toThrow(BadRequestException);
      await expect(service.toggleStatus('policy-123')).rejects.toThrow(
        'Draft policies cannot be toggled',
      );
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('toggles ACTIVE to DISABLED', async () => {
      const policy = createMockDoc({ status: PolicyStatus.ACTIVE });
      mockPolicyModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(policy),
      });

      const result = await service.toggleStatus('policy-123');

      expect(mockSave).toHaveBeenCalled();
      expect(policy.status).toBe(PolicyStatus.DISABLED);
      expect(result.status).toBe(PolicyStatus.DISABLED);
    });

    it('toggles DISABLED to ACTIVE', async () => {
      const policy = createMockDoc({ status: PolicyStatus.DISABLED });
      mockPolicyModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(policy),
      });

      const result = await service.toggleStatus('policy-123');

      expect(mockSave).toHaveBeenCalled();
      expect(policy.status).toBe(PolicyStatus.ACTIVE);
      expect(result.status).toBe(PolicyStatus.ACTIVE);
    });
  });
});
