/**
 * Unit tests for PrivilegedAccessService
 */

jest.mock('@infrastructure/multi-tenancy/tenant-context.helper', () => ({
  getCurrentTenantId: jest.fn().mockReturnValue('test-tenant'),
  withTenantContext: jest.fn((_tenantId: string, fn: () => unknown) => fn()),
}));

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PrivilegedAccessService } from './privileged-access.service';
import { Identity } from '../identity/schemas/identity.schema';
import { IdentityService } from '../identity/identity.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import {
  createMockLoggerFactory,
  createMockEventEmitter,
  TEST_TENANT_ID,
} from '@testing/test-helpers';
import { UserStatus, EmploymentType } from '@shared/dtos/standard-user.dto';
import { pamConfig } from '@infrastructure/config/pam.config';
import { PrivilegedSessionService } from './privileged-session.service';

// ── Helpers ──────────────────────────────────────────────────────────

const PAM_CONFIG = {
  tier0MaxHours: 8,
  tier1MaxHours: 24,
  tier2MaxHours: 72,
  adminUpnPattern: 'adm-{firstName}.{lastName}@{domain}',
  adminUpnMaxSuffix: 20,
};

function createChainable(resolvedValue: unknown = null) {
  return {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(resolvedValue),
  };
}

function createParentDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'parent-id-001' },
    tenantId: TEST_TENANT_ID,
    profile: {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john.doe@example.com',
      status: UserStatus.ACTIVE,
    },
    linkedAdminAccounts: [],
    sources: [],
    controls: {},
    provisioning: [],
    ...overrides,
  };
}

function createAdminDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'admin-id-001' },
    tenantId: TEST_TENANT_ID,
    profile: {
      firstName: 'John',
      lastName: 'Doe',
      email: 'adm-john.doe@example.com',
      status: UserStatus.PENDING,
      employmentType: EmploymentType.ADMIN_ACCOUNT,
    },
    parentIdentityId: { toString: () => 'parent-id-001' },
    adminTier: 'TIER_1',
    provisioning: [],
    ...overrides,
  };
}

// ── Test Suite ───────────────────────────────────────────────────────

describe('PrivilegedAccessService', () => {
  let service: PrivilegedAccessService;
  let mockIdentityModel: {
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
  };
  let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;
  const { factory: loggerFactory } = createMockLoggerFactory();
  const sessions = {
    activate: jest.fn(),
    deactivate: jest.fn(),
    endExpired: jest.fn(),
  };

  beforeEach(async () => {
    mockIdentityModel = {
      findOne: jest.fn().mockReturnValue(createChainable(null)),
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockReturnValue(createChainable([])),
      create: jest.fn(),
    };

    mockEventEmitter = createMockEventEmitter();

    const module = await Test.createTestingModule({
      providers: [
        PrivilegedAccessService,
        { provide: getModelToken(Identity.name), useValue: mockIdentityModel },
        { provide: IdentityService, useValue: {} },
        { provide: DomainEventEmitterService, useValue: mockEventEmitter },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: pamConfig.KEY, useValue: PAM_CONFIG },
        { provide: PrivilegedSessionService, useValue: sessions },
      ],
    }).compile();

    service = module.get(PrivilegedAccessService);
    jest.clearAllMocks();
  });

  // ── createLinkedAdminIdentity ────────────────────────────────────

  describe('createLinkedAdminIdentity', () => {
    it('should create admin identity and link to parent', async () => {
      const parent = createParentDoc();
      const createdAdmin = createAdminDoc();

      mockIdentityModel.findOne
        .mockReturnValueOnce(createChainable(parent)) // find parent
        .mockReturnValueOnce(createChainable(null)); // check duplicate email
      mockIdentityModel.create.mockResolvedValue(createdAdmin);
      mockIdentityModel.findOneAndUpdate.mockResolvedValue(null);

      const result = await service.createLinkedAdminIdentity(
        'parent-id-001',
        'TIER_1',
        TEST_TENANT_ID,
      );

      expect(result).toBe(createdAdmin);
      expect(mockIdentityModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TEST_TENANT_ID,
          parentIdentityId: 'parent-id-001',
          adminTier: 'TIER_1',
          profile: expect.objectContaining({
            email: 'adm-john.doe@example.com',
            employmentType: EmploymentType.ADMIN_ACCOUNT,
            status: UserStatus.PENDING,
          }),
        }),
      );
      expect(mockIdentityModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'parent-id-001', tenantId: TEST_TENANT_ID },
        {
          $push: {
            linkedAdminAccounts: expect.objectContaining({
              identityId: 'admin-id-001',
              adminTier: 'TIER_1',
              status: 'PENDING',
            }),
          },
        },
      );
      // No admin UPN in the event (audit log, websocket, webhooks): the aggregate names it
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        DomainEventType.ADMIN_ACCOUNT_CREATED,
        'admin-id-001',
        { parentIdentityId: 'parent-id-001', adminTier: 'TIER_1' },
        { actor: 'privileged-access-service' },
      );
    });

    it('should be idempotent — return existing admin for same tier', async () => {
      const existingAdmin = createAdminDoc();
      const parent = createParentDoc({
        linkedAdminAccounts: [
          { identityId: 'admin-id-001', adminTier: 'TIER_1', status: 'ACTIVE' },
        ],
      });

      mockIdentityModel.findOne
        .mockReturnValueOnce(createChainable(parent)) // find parent
        .mockReturnValueOnce(createChainable(existingAdmin)); // find existing admin

      const result = await service.createLinkedAdminIdentity(
        'parent-id-001',
        'TIER_1',
        TEST_TENANT_ID,
      );

      expect(result).toBe(existingAdmin);
      expect(mockIdentityModel.create).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when parent not found', async () => {
      mockIdentityModel.findOne.mockReturnValueOnce(createChainable(null));

      await expect(
        service.createLinkedAdminIdentity('nonexistent-id', 'TIER_1', TEST_TENANT_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException for duplicate admin email', async () => {
      const parent = createParentDoc();
      const existingByEmail = createAdminDoc();

      mockIdentityModel.findOne
        .mockReturnValueOnce(createChainable(parent)) // find parent
        .mockReturnValueOnce(createChainable(existingByEmail)); // found by email

      await expect(
        service.createLinkedAdminIdentity('parent-id-001', 'TIER_1', TEST_TENANT_ID),
      ).rejects.toThrow(ConflictException);

      expect(mockIdentityModel.create).not.toHaveBeenCalled();
    });
  });

  // ── activateAdminAccount ─────────────────────────────────────────

  describe('activateAdminAccount', () => {
    // The session enables the accounts and records ACTIVE (privilegedSessionWorkflow): the
    // service only checks and starts it, so the PAM page never shows ACTIVE for an account that
    // is still disabled
    it("starts a privileged session of the tier's length and writes nothing itself", async () => {
      const admin = createAdminDoc({ adminTier: 'TIER_0' });
      mockIdentityModel.findOne
        .mockReturnValueOnce(createChainable(admin))
        .mockReturnValueOnce(createChainable(createParentDoc())); // the live parent
      const answer = { state: 'ACTIVE', expiresAt: '2026-11-25T18:00:00.000Z' };
      sessions.activate.mockResolvedValue(answer);

      await expect(service.activateAdminAccount('admin-id-001')).resolves.toBe(answer);

      expect(sessions.activate).toHaveBeenCalledWith(
        'admin-id-001',
        'parent-id-001',
        PAM_CONFIG.tier0MaxHours * 60 * 60 * 1000,
        TEST_TENANT_ID,
      );
      expect(mockIdentityModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenException for unauthorized requester', async () => {
      const admin = createAdminDoc();
      mockIdentityModel.findOne.mockReturnValueOnce(createChainable(admin));

      await expect(
        service.activateAdminAccount('admin-id-001', 'some-other-user', ['viewer']),
      ).rejects.toThrow(ForbiddenException);

      expect(mockIdentityModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(sessions.activate).not.toHaveBeenCalled();
    });

    it('should allow parent identity to activate their own admin account', async () => {
      const admin = createAdminDoc();
      mockIdentityModel.findOne
        .mockReturnValueOnce(createChainable(admin))
        .mockReturnValueOnce(createChainable(createParentDoc())); // the live parent
      sessions.activate.mockResolvedValue({ state: 'ACTIVATING' });

      await service.activateAdminAccount('admin-id-001', 'parent-id-001', ['viewer']);

      expect(sessions.activate).toHaveBeenCalled();
    });

    it('should throw NotFoundException when admin identity not found', async () => {
      mockIdentityModel.findOne.mockReturnValueOnce(createChainable(null));

      await expect(service.activateAdminAccount('nonexistent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── deactivateAdminAccount ───────────────────────────────────────

  describe('deactivateAdminAccount', () => {
    it('ends the session and leaves the provisioning entries as they are', async () => {
      const admin = createAdminDoc({
        provisioning: [
          { targetSystem: 'entra', status: 'SYNCED' },
          { targetSystem: 'ad', status: 'SYNCED' },
        ],
      });
      mockIdentityModel.findOne.mockReturnValueOnce(createChainable(admin));
      sessions.deactivate.mockResolvedValue({ state: 'INACTIVE' });

      await expect(service.deactivateAdminAccount('admin-id-001')).resolves.toEqual({
        state: 'INACTIVE',
      });

      // The session disables the accounts and records INACTIVE; nothing is removed, so the
      // provisioning entries (what offboarding removes) are not touched
      expect(sessions.deactivate).toHaveBeenCalledWith(
        'admin-id-001',
        'parent-id-001',
        TEST_TENANT_ID,
        'deactivated',
      );
      expect(mockIdentityModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenException for unauthorized requester', async () => {
      const admin = createAdminDoc();
      mockIdentityModel.findOne.mockReturnValueOnce(createChainable(admin));

      await expect(
        service.deactivateAdminAccount('admin-id-001', 'other-user-id', ['viewer']),
      ).rejects.toThrow(ForbiddenException);

      expect(mockIdentityModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(sessions.deactivate).not.toHaveBeenCalled();
    });
  });

  // ── getLinkedAdminAccounts ───────────────────────────────────────

  describe('getLinkedAdminAccounts', () => {
    it('should return accounts for the owner', async () => {
      const linkedAccounts = [
        { identityId: 'admin-id-001', adminTier: 'TIER_1', status: 'ACTIVE' },
        { identityId: 'admin-id-002', adminTier: 'TIER_0', status: 'PENDING' },
      ];
      const parent = createParentDoc({ linkedAdminAccounts: linkedAccounts });
      mockIdentityModel.findOne.mockReturnValueOnce(createChainable(parent));
      // Both admin identities are live (not soft-deleted)
      mockIdentityModel.find.mockReturnValueOnce(
        createChainable([{ _id: 'admin-id-001' }, { _id: 'admin-id-002' }]),
      );

      const result = await service.getLinkedAdminAccounts('parent-id-001', 'parent-id-001', [
        'viewer',
      ]);

      expect(result).toEqual(linkedAccounts);
    });

    it('should return accounts for an operator role', async () => {
      const linkedAccounts = [
        { identityId: 'admin-id-001', adminTier: 'TIER_1', status: 'ACTIVE' },
      ];
      const parent = createParentDoc({ linkedAdminAccounts: linkedAccounts });
      mockIdentityModel.findOne.mockReturnValueOnce(createChainable(parent));
      mockIdentityModel.find.mockReturnValueOnce(createChainable([{ _id: 'admin-id-001' }]));

      const result = await service.getLinkedAdminAccounts('parent-id-001', 'different-user', [
        'operator',
      ]);

      expect(result).toEqual(linkedAccounts);
    });

    it('should throw ForbiddenException for non-owner/non-operator', async () => {
      const parent = createParentDoc();
      mockIdentityModel.findOne.mockReturnValueOnce(createChainable(parent));

      await expect(
        service.getLinkedAdminAccounts('parent-id-001', 'other-user-id', ['viewer']),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when parent not found', async () => {
      mockIdentityModel.findOne.mockReturnValueOnce(createChainable(null));

      await expect(
        service.getLinkedAdminAccounts('nonexistent-id', 'nonexistent-id', ['viewer']),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── deactivateExpiredSessions ────────────────────────────────────

  describe('deactivateExpiredSessions', () => {
    // Which entries count as expired: privileged-session-sweep.integration.spec.ts
    it('ends the expired sessions through the session service', async () => {
      sessions.endExpired.mockResolvedValue(2);

      await expect(service.deactivateExpiredSessions(TEST_TENANT_ID)).resolves.toBe(2);

      expect(sessions.endExpired).toHaveBeenCalledWith(TEST_TENANT_ID, expect.any(Date));
    });
  });

  // ── listAllAdminAccounts ─────────────────────────────────────────

  describe('listAllAdminAccounts', () => {
    it('should return correct shape with parent email and linked status', async () => {
      const adminLean = {
        _id: { toString: () => 'admin-id-001' },
        profile: { email: 'adm-john.doe@example.com' },
        parentIdentityId: 'parent-id-001',
        adminTier: 'TIER_1',
      };
      const parentLean = {
        _id: { toString: () => 'parent-id-001' },
        profile: { email: 'john.doe@example.com' },
        linkedAdminAccounts: [
          {
            identityId: 'admin-id-001',
            adminTier: 'TIER_1',
            status: 'ACTIVE',
            activatedAt: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      };

      // First find: admin identities (chained .select().lean().exec())
      mockIdentityModel.find.mockReturnValueOnce(createChainable([adminLean]));
      // Second find: parent identities (chained .select().lean().exec())
      mockIdentityModel.find.mockReturnValueOnce(createChainable([parentLean]));

      const result = await service.listAllAdminAccounts(TEST_TENANT_ID);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        adminIdentityId: 'admin-id-001',
        adminEmail: 'adm-john.doe@example.com',
        parentIdentityId: 'parent-id-001',
        parentEmail: 'john.doe@example.com',
        adminTier: 'TIER_1',
        status: 'ACTIVE',
        activatedAt: new Date('2026-01-01T00:00:00Z'),
        parentDeleted: false,
      });
    });

    it('should default status to PENDING when no linked entry found on parent', async () => {
      const adminLean = {
        _id: { toString: () => 'admin-id-002' },
        profile: { email: 'adm-jane.smith@example.com' },
        parentIdentityId: 'parent-id-002',
        adminTier: 'TIER_0',
      };
      const parentLean = {
        _id: { toString: () => 'parent-id-002' },
        profile: { email: 'jane.smith@example.com' },
        linkedAdminAccounts: [], // no matching linked entry
      };

      mockIdentityModel.find
        .mockReturnValueOnce(createChainable([adminLean]))
        .mockReturnValueOnce(createChainable([parentLean]));

      const result = await service.listAllAdminAccounts(TEST_TENANT_ID);

      expect(result[0]).toEqual(
        expect.objectContaining({
          adminIdentityId: 'admin-id-002',
          status: 'PENDING',
          activatedAt: undefined,
        }),
      );
    });
  });
});
