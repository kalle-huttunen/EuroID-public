import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { IdentityProvisioningService } from './identity-provisioning.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { createMockLoggerFactory, TEST_TENANT_ID, withTestTenant } from '@testing/test-helpers';

function createChainable(resolvedValue: unknown = null) {
  return {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(resolvedValue),
  };
}

function createHydratedDoc(data: Record<string, unknown> = {}) {
  const base = {
    _id: data._id ?? 'identity-id-001',
    tenantId: data.tenantId ?? TEST_TENANT_ID,
    profile: data.profile ?? { email: 'test@example.com', status: 'ACTIVE' },
    sources: data.sources ?? [],
    provisioning: data.provisioning ?? [],
    controls: data.controls ?? {},
    metadata: data.metadata ?? {},
    ...data,
  };
  return {
    ...base,
    toObject: jest.fn().mockReturnValue(base),
    save: jest.fn().mockResolvedValue(base),
    set: jest.fn(),
  };
}

describe('IdentityProvisioningService', () => {
  let service: IdentityProvisioningService;
  let mockIdentityModel: {
    find: jest.Mock;
    findOne: jest.Mock;
    findById: jest.Mock;
  };
  const { factory: loggerFactory } = createMockLoggerFactory();

  beforeEach(async () => {
    mockIdentityModel = {
      find: jest.fn().mockReturnValue(createChainable([])),
      findOne: jest.fn().mockReturnValue(createChainable()),
      findById: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        IdentityProvisioningService,
        { provide: getModelToken('Identity'), useValue: mockIdentityModel },
        { provide: LoggerFactoryService, useValue: loggerFactory },
      ],
    }).compile();

    service = module.get(IdentityProvisioningService);
    jest.clearAllMocks();
  });

  // ── findIdentitiesForOnboardingPaginated ──────────────────────

  describe('findIdentitiesForOnboardingPaginated', () => {
    it('should query active identities with email, respecting pagination', async () => {
      const mockDocs = [{ _id: '1' }, { _id: '2' }];
      const chainable = createChainable(mockDocs);
      mockIdentityModel.find.mockReturnValue(chainable);

      const result = await withTestTenant(() =>
        service.findIdentitiesForOnboardingPaginated(0, 50),
      );

      expect(result).toEqual(mockDocs);
      expect(mockIdentityModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          deletedAt: null,
          'profile.status': 'ACTIVE',
          'profile.email': { $exists: true, $ne: '' },
        }),
      );
      expect(chainable.skip).toHaveBeenCalledWith(0);
      expect(chainable.limit).toHaveBeenCalledWith(50);
    });

    // Hunt 2026-11-25 r2-02 N8: skip/limit without a sort can skip or repeat identities
    it('pages in a stable order, before skipping', async () => {
      const chainable = createChainable([]);
      mockIdentityModel.find.mockReturnValue(chainable);

      await withTestTenant(() => service.findIdentitiesForOnboardingPaginated(50, 50));

      expect(chainable.sort).toHaveBeenCalledWith({ _id: 1 });
      expect(chainable.sort.mock.invocationCallOrder[0]).toBeLessThan(
        chainable.skip.mock.invocationCallOrder[0],
      );
    });

    it('should return empty array when no identities match', async () => {
      mockIdentityModel.find.mockReturnValue(createChainable([]));

      const result = await withTestTenant(() =>
        service.findIdentitiesForOnboardingPaginated(100, 50),
      );

      expect(result).toEqual([]);
    });
  });

  // ── getProvisionedTargetsForDeprovision ────────────────────────

  describe('getProvisionedTargetsForDeprovision', () => {
    it('should return SYNCED targets with matched external IDs', async () => {
      const identity = createHydratedDoc({
        provisioning: [
          { targetSystem: 'entra-id', status: 'SYNCED', lastSync: new Date() },
          { targetSystem: 'ad', status: 'ERROR', lastSync: new Date() },
        ],
        sources: [
          { sourceName: 'entra-id', externalId: 'entra-obj-123', sourceRole: 'target' },
          { sourceName: 'active-directory', externalId: 'ad-dn-456', sourceRole: 'target' },
        ],
      });
      mockIdentityModel.findOne.mockReturnValue(createChainable(identity));

      const result = await withTestTenant(() =>
        service.getProvisionedTargetsForDeprovision('identity-id-001', TEST_TENANT_ID),
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ targetSystem: 'entra-id' });
    });

    it('should return empty array when identity not found', async () => {
      mockIdentityModel.findOne.mockReturnValue(createChainable(null));

      const result = await withTestTenant(() =>
        service.getProvisionedTargetsForDeprovision('nonexistent', TEST_TENANT_ID),
      );

      expect(result).toEqual([]);
    });

    it('should return empty array when no provisioning entries exist', async () => {
      const identity = createHydratedDoc({ provisioning: [] });
      mockIdentityModel.findOne.mockReturnValue(createChainable(identity));

      const result = await withTestTenant(() =>
        service.getProvisionedTargetsForDeprovision('identity-id-001', TEST_TENANT_ID),
      );

      expect(result).toEqual([]);
    });
  });

  // ── getOffboardingTargets ─────────────────────────────────────

  describe('getOffboardingTargets', () => {
    it('returns every entry not yet DEPROVISIONED, with its status and account id', async () => {
      const identity = createHydratedDoc({
        provisioning: [
          { targetSystem: 'entra-id', status: 'SYNCED' },
          { targetSystem: 'okta', status: 'ERROR' },
          { targetSystem: 'scim', status: 'SYNCING' },
          { targetSystem: 'github', status: 'DEPROVISIONED' },
        ],
        sources: [
          { sourceName: 'entra-id', externalId: 'entra-obj-123', sourceRole: 'target' },
          { sourceName: 'scim', externalId: 'scim-9', sourceRole: 'target' },
        ],
      });
      mockIdentityModel.findOne.mockReturnValue(createChainable(identity));

      await expect(
        withTestTenant(() => service.getOffboardingTargets('identity-id-001', TEST_TENANT_ID)),
      ).resolves.toEqual({
        noProvisioningState: false,
        targets: [
          { targetSystem: 'entra-id', externalId: 'entra-obj-123', status: 'SYNCED' },
          { targetSystem: 'okta', externalId: undefined, status: 'ERROR' },
          { targetSystem: 'scim', externalId: 'scim-9', status: 'SYNCING' },
        ],
      });
    });

    it('has provisioning state, and nothing to remove, once every entry is DEPROVISIONED', async () => {
      const identity = createHydratedDoc({
        provisioning: [{ targetSystem: 'entra-id', status: 'DEPROVISIONED' }],
      });
      mockIdentityModel.findOne.mockReturnValue(createChainable(identity));

      await expect(
        withTestTenant(() => service.getOffboardingTargets('identity-id-001', TEST_TENANT_ID)),
      ).resolves.toEqual({ noProvisioningState: false, targets: [] });
    });

    it("never takes an HR source's employee id for a target whose name it contains", async () => {
      const identity = createHydratedDoc({
        provisioning: [{ targetSystem: 'ad', status: 'SYNCED' }],
        sources: [
          { sourceName: 'adp-workforce', externalId: 'EMP-1', sourceRole: 'primary-hr' },
          { sourceName: 'upload', externalId: 'EMP-2', sourceRole: 'secondary-hr' },
        ],
      });
      mockIdentityModel.findOne.mockReturnValue(createChainable(identity));

      const result = await withTestTenant(() =>
        service.getOffboardingTargets('identity-id-001', TEST_TENANT_ID),
      );
      expect(result.targets).toEqual([
        { targetSystem: 'ad', externalId: undefined, status: 'SYNCED' },
      ]);
      const legacy = await withTestTenant(() =>
        service.getProvisionedTargetsForDeprovision('identity-id-001', TEST_TENANT_ID),
      );
      expect(legacy).toEqual([{ targetSystem: 'ad', externalId: undefined }]);
    });

    it('matches a target source by exact normalised name or an alias of the same system', async () => {
      const identity = createHydratedDoc({
        provisioning: [
          { targetSystem: 'entra', status: 'SYNCED' },
          { targetSystem: 'Active-Directory', status: 'SYNCED' },
          { targetSystem: 'scim', status: 'SYNCED' },
          { targetSystem: 'okta', status: 'SYNCED' },
        ],
        sources: [
          { sourceName: 'entra-id', externalId: 'entra-obj-1', sourceRole: 'target' },
          { sourceName: 'ad', externalId: 'CN=Ada,DC=corp', sourceRole: 'target' },
          { sourceName: 'scim-prod', externalId: 'scim-1', sourceRole: 'target' },
          { sourceName: 'okta', externalId: 'EMP-1', sourceRole: 'primary-hr' },
        ],
      });
      mockIdentityModel.findOne.mockReturnValue(createChainable(identity));

      const result = await withTestTenant(() =>
        service.getOffboardingTargets('identity-id-001', TEST_TENANT_ID),
      );
      expect(result.targets.map((t) => [t.targetSystem, t.externalId])).toEqual([
        ['entra', 'entra-obj-1'],
        ['Active-Directory', 'CN=Ada,DC=corp'],
        ['scim', undefined],
        ['okta', undefined],
      ]);
    });

    it('reports no provisioning state only for an existing identity without entries', async () => {
      mockIdentityModel.findOne.mockReturnValue(createChainable(createHydratedDoc()));
      await expect(
        withTestTenant(() => service.getOffboardingTargets('identity-id-001', TEST_TENANT_ID)),
      ).resolves.toEqual({ noProvisioningState: true, targets: [] });

      mockIdentityModel.findOne.mockReturnValue(createChainable(null));
      await expect(
        withTestTenant(() => service.getOffboardingTargets('gone', TEST_TENANT_ID)),
      ).resolves.toEqual({ noProvisioningState: false, targets: [] });
    });
  });

  // ── updateProvisioningState ───────────────────────────────────

  // What it stores: identity-provisioning.integration.spec.ts
  describe('updateProvisioningState', () => {
    it('should return null when identity not found', async () => {
      mockIdentityModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      const result = await withTestTenant(() =>
        service.updateProvisioningState('nonexistent', 'entra-id', 'SYNCED'),
      );

      expect(result).toBeNull();
    });
  });
});
