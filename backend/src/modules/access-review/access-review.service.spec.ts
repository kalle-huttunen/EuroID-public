/**
 * Unit tests for AccessReviewService (facade) and its two sub-services.
 */

jest.mock('@infrastructure/multi-tenancy/tenant-context.helper', () => ({
  getCurrentTenantId: jest.fn().mockReturnValue('test-tenant'),
  withTenantContext: jest.fn((tenantId, fn) => fn()),
}));

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { AccessReviewService } from './access-review.service';
import { AccessReviewCampaignService } from './access-review-campaign.service';
import { AccessReviewItemService } from './access-review-item.service';
import { ReviewCampaign, CampaignStatus } from './schemas/review-campaign.schema';
import { ReviewItem } from './schemas/review-item.schema';
import { ScimToken } from '../scim-inbound/schemas/scim-token.schema';
import { AdminUser } from '../auth/schemas/admin-user.schema';
import { IdentityService } from '../identity/identity.service';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { EntraService } from '../connectors/entra-connector/entra.service';
import { ReviewTargetAccessService } from './review-target-access.service';
import { ConfigActivities } from '../../activities/config.activities';
import { AdService } from '../connectors/ad-connector/ad.service';
import { OktaService } from '../connectors/okta-connector/okta.service';
import { SCIMService } from '../connectors/scim-connector/scim.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { accessReviewConfig } from '@infrastructure/config/access-review.config';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';
import { registerBuiltInConnectors } from '../connectors/plugin/register-connectors';

const chainable = {
  sort: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue([]),
};

const mockCampaignModel = {
  create: jest.fn(),
  findOne: jest.fn(),
  exists: jest.fn(),
  // getMyReviews leaves out the items of cancelled campaigns (none here)
  distinct: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
  find: jest.fn().mockReturnValue(chainable),
  countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(0) }),
  updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }) }),
};

const mockReviewItemModel = {
  create: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn().mockReturnValue({ ...chainable }),
  countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(0) }),
  updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
  findOneAndUpdate: jest.fn(),
  // An activation first clears what an earlier attempt left (review-campaign-activation.ts)
  deleteMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ deletedCount: 0 }) }),
};

const mockScimTokenModel = {
  findById: jest.fn().mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
};
const mockAdminUserModel = {
  findById: jest.fn().mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
};

describe('AccessReviewService', () => {
  let service: AccessReviewService;
  let itemService: AccessReviewItemService;
  let identityService: jest.Mocked<Partial<IdentityService>>;
  let entitlementCatalog: jest.Mocked<Partial<EntitlementCatalogService>>;
  let entraService: jest.Mocked<Partial<EntraService>>;
  let eventEmitter: jest.Mocked<Partial<DomainEventEmitterService>>;
  let configActivities: { getActiveTargetSystems: jest.Mock; getConnectorConfig: jest.Mock };
  let adService: { getUserGroupDns: jest.Mock; getUserByEmail: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    identityService = {
      findAll: jest.fn().mockResolvedValue([
        {
          _id: 'user-1',
          email: 'user1@test.com',
          firstName: 'Test',
          lastName: 'User1',
          departmentName: 'Finance',
          managerEmail: 'manager@test.com',
        },
      ]),
      findIdentitiesForOnboarding: jest.fn().mockResolvedValue([]),
    };

    entitlementCatalog = {
      isPolicyManaged: jest.fn().mockResolvedValue(false),
      getOwner: jest.fn().mockResolvedValue(null),
      getCatalogEntriesBatch: jest.fn().mockResolvedValue(new Map()),
      findBySystemAndNativeId: jest.fn().mockResolvedValue(null),
    };

    entraService = {
      isConfiguredForTenant: jest.fn().mockResolvedValue(true),
      checkUserExists: jest.fn().mockImplementation((email) => Promise.resolve(`entra-${email}`)),
      getUserGroupMemberships: jest.fn().mockResolvedValue([
        { id: 'group-1', displayName: 'Finance-Admins' },
        { id: 'group-2', displayName: 'Sales-Admins' },
      ]),
      listUserMemberships: jest.fn().mockResolvedValue([
        { id: 'group-1', displayName: 'Finance-Admins', odataType: '#microsoft.graph.group' },
        { id: 'group-2', displayName: 'Sales-Admins', odataType: '#microsoft.graph.group' },
      ]),
    };

    eventEmitter = {
      emit: jest.fn(),
    };

    // Only Entra ID is a review target unless a test puts more on the canvas
    configActivities = {
      getActiveTargetSystems: jest.fn().mockResolvedValue([]),
      getConnectorConfig: jest.fn().mockResolvedValue(null),
    };
    adService = { getUserGroupDns: jest.fn(), getUserByEmail: jest.fn() };
    // The real connector registry: a `system` scope names one of its target systems
    const connectors = new PluginRegistryService({} as ModuleRef);
    registerBuiltInConnectors(connectors);

    const module = await Test.createTestingModule({
      providers: [
        AccessReviewService,
        AccessReviewCampaignService,
        AccessReviewItemService,
        { provide: getModelToken(ReviewCampaign.name), useValue: mockCampaignModel },
        { provide: getModelToken(ReviewItem.name), useValue: mockReviewItemModel },
        { provide: getModelToken(ScimToken.name), useValue: mockScimTokenModel },
        { provide: getModelToken(AdminUser.name), useValue: mockAdminUserModel },
        { provide: IdentityService, useValue: identityService },
        { provide: EntitlementCatalogService, useValue: entitlementCatalog },
        { provide: EntraService, useValue: entraService },
        // Real gathering, from the targets configActivities puts on the canvas
        ReviewTargetAccessService,
        { provide: ConfigActivities, useValue: configActivities },
        { provide: AdService, useValue: adService },
        { provide: OktaService, useValue: {} },
        { provide: SCIMService, useValue: {} },
        { provide: DomainEventEmitterService, useValue: eventEmitter },
        {
          provide: TemporalClientProvider,
          useValue: {
            getClient: () => ({
              workflow: {
                start: jest.fn(),
                getHandle: jest.fn().mockReturnValue({ signal: jest.fn() }),
              },
            }),
            isConnected: () => true,
          },
        },
        {
          provide: accessReviewConfig.KEY,
          useValue: { defaultReviewer: 'unassigned@review.pending' },
        },
        { provide: PluginRegistryService, useValue: connectors },
      ],
    }).compile();

    service = module.get(AccessReviewService);
    itemService = module.get(AccessReviewItemService);

    mockCampaignModel.create.mockImplementation((doc) =>
      Promise.resolve({
        ...doc,
        campaignId: doc.campaignId || 'campaign-123',
        save: jest.fn(),
      }),
    );

    mockCampaignModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });
    mockCampaignModel.exists.mockResolvedValue({ _id: 'camp-1' });
  });

  describe('createCampaign', () => {
    it('should create campaign in DRAFT status', async () => {
      // The default create mock stores what the service hands it
      const result = await service.createCampaign(
        {
          name: 'Q1 2026 Finance Access Review',
          scope: { type: 'department', value: 'Finance' },
          deadline: new Date('2026-03-31'),
        },
        'admin@test.com',
      );

      expect(mockCampaignModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'test-tenant',
          status: CampaignStatus.DRAFT,
          createdBy: 'admin@test.com',
          stats: { totalItems: 0, approved: 0, revoked: 0, pending: 0, expired: 0 },
        }),
      );
      expect(result.status).toBe(CampaignStatus.DRAFT);
      expect(result.campaignId).toBeDefined();
      expect(eventEmitter.emit).toHaveBeenCalled();
    });
  });

  describe('createCampaign (scope system)', () => {
    const create = (value?: string) =>
      service.createCampaign(
        { name: 'Q1 review', scope: { type: 'system', value }, deadline: new Date('2026-03-31') },
        'admin@test.com',
      );

    it('refuses a system that maps to no known system, naming the known systems', async () => {
      for (const value of ['file', 'sharepoint', '', undefined]) {
        const error = await create(value).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as Error).message).toBe(
          `Scope system "${value ?? ''}" is not a known system. Known systems: ad, ` +
            'discord-webhook, entra-id, file-outbound, github, google-sheets, okta, scim, ' +
            'servicenow.',
        );
      }
      expect(mockCampaignModel.create).not.toHaveBeenCalled();
    });

    it('takes a known system under any of its names', async () => {
      for (const value of ['ad', 'active-directory', 'entra', 'entra-id', 'File-Outbound']) {
        await expect(create(value)).resolves.toBeDefined();
      }
      expect(mockCampaignModel.create).toHaveBeenCalledTimes(5);
    });
  });

  describe('findAll', () => {
    it('should return paginated campaigns', async () => {
      mockCampaignModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(22),
      });
      const query = {
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          { campaignId: 'c1', name: 'Campaign 1' },
          { campaignId: 'c2', name: 'Campaign 2' },
        ]),
      };
      mockCampaignModel.find.mockReturnValue(query);

      // Pages count from 0: the first page skips nothing, page 2 skips two pages
      const first = await service.findAll({ page: 0, limit: 10 });
      expect(query.skip).toHaveBeenLastCalledWith(0);
      expect(query.limit).toHaveBeenLastCalledWith(10);
      await service.findAll({ page: 2, limit: 10, status: CampaignStatus.ACTIVE });
      expect(query.skip).toHaveBeenLastCalledWith(20);

      expect(first.total).toBe(22);
      expect(first.data).toHaveLength(2);
      expect(query.sort).toHaveBeenCalledWith({ createdAt: -1 });
      expect(mockCampaignModel.find).toHaveBeenNthCalledWith(1, { tenantId: 'test-tenant' });
      expect(mockCampaignModel.find).toHaveBeenNthCalledWith(2, {
        tenantId: 'test-tenant',
        status: CampaignStatus.ACTIVE,
      });
    });
  });

  describe('decide', () => {
    it('should approve item and update stats', async () => {
      const mockItem = {
        itemId: 'item-1',
        campaignId: 'camp-1',
        identityId: 'identity-123',
        identityEmail: 'user@test.com',
        reviewerId: 'reviewer@test.com',
        decision: 'pending',
        save: jest.fn(),
      };
      mockReviewItemModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockItem),
      });
      mockCampaignModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          campaignId: 'camp-1',
          workflowId: null,
          status: CampaignStatus.ACTIVE,
        }),
      });
      // The decision is a conditional update on the pending item (hunt 04 F14)
      mockReviewItemModel.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ ...mockItem, decision: 'approved' }),
      });

      const result = await service.decide('item-1', 'approved', 'reviewer@test.com');

      expect(result.decision).toBe('approved');
      expect(mockReviewItemModel.findOneAndUpdate).toHaveBeenCalledWith(
        { itemId: 'item-1', tenantId: 'test-tenant', decision: 'pending' },
        { $set: expect.objectContaining({ decision: 'approved', decidedBy: 'reviewer@test.com' }) },
        { new: true },
      );
      // The stats move by this one decision
      expect(mockCampaignModel.updateOne).toHaveBeenCalledWith(
        { campaignId: 'camp-1', tenantId: 'test-tenant' },
        { $inc: { 'stats.pending': -1, 'stats.approved': 1 } },
      );
    });

    it('answers 400 when another decision took the item first', async () => {
      mockReviewItemModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          itemId: 'item-1',
          campaignId: 'camp-1',
          identityId: 'identity-123',
          identityEmail: 'user@test.com',
          reviewerId: 'reviewer@test.com',
          decision: 'pending',
        }),
      });
      mockCampaignModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ campaignId: 'camp-1', status: CampaignStatus.ACTIVE }),
      });
      mockReviewItemModel.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      await expect(service.decide('item-1', 'approved', 'reviewer@test.com')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockCampaignModel.updateOne).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenException when actor approves their own access via email (SoD)', async () => {
      const mockItem = {
        itemId: 'item-1',
        campaignId: 'camp-1',
        identityId: 'identity-123',
        identityEmail: 'self@test.com',
        reviewerId: 'self@test.com',
        decision: 'pending',
        save: jest.fn(),
      };
      mockReviewItemModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockItem),
      });

      await expect(service.decide('item-1', 'approved', 'self@test.com')).rejects.toThrow(
        'Segregation of Duties',
      );
    });

    it('should throw ForbiddenException when actor approves their own access via identityId (SoD)', async () => {
      const mockItem = {
        itemId: 'item-2',
        campaignId: 'camp-1',
        identityId: 'user-123',
        identityEmail: 'user@test.com',
        reviewerId: 'user-123',
        decision: 'pending',
        save: jest.fn(),
      };
      mockReviewItemModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockItem),
      });

      await expect(service.decide('item-2', 'approved', 'user-123')).rejects.toThrow(
        'Segregation of Duties',
      );
    });

    it('should log blocked self-approval attempt for audit trail', async () => {
      const mockItem = {
        itemId: 'item-3',
        campaignId: 'camp-1',
        identityId: 'identity-456',
        identityEmail: 'self@test.com',
        reviewerId: 'self@test.com',
        decision: 'pending',
        save: jest.fn(),
      };
      mockReviewItemModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockItem),
      });

      const warnSpy = jest.spyOn(itemService['logger'], 'warn');

      await expect(service.decide('item-3', 'approved', 'self@test.com')).rejects.toThrow(
        'Segregation of Duties',
      );

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Self-approval attempt blocked'),
      );
    });

    it('should require justification for revoke', async () => {
      const mockItem = {
        itemId: 'item-1',
        campaignId: 'camp-1',
        identityId: 'identity-123',
        identityEmail: 'user@test.com',
        reviewerId: 'reviewer@test.com',
        decision: 'pending',
        save: jest.fn(),
      };
      mockReviewItemModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockItem),
      });

      await expect(service.decide('item-1', 'revoked', 'reviewer@test.com')).rejects.toThrow(
        'Justification is required when revoking',
      );
    });

    it('should allow self-approval when isSelfReview is true', async () => {
      const mockItem = {
        itemId: 'item-self',
        campaignId: 'camp-1',
        identityId: 'self@test.com',
        identityEmail: 'self@test.com',
        reviewerId: 'self@test.com',
        decision: 'pending',
        isSelfReview: true,
        save: jest.fn(),
      };
      mockReviewItemModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockItem),
      });
      mockCampaignModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          campaignId: 'camp-1',
          workflowId: null,
          status: CampaignStatus.ACTIVE,
        }),
      });
      mockReviewItemModel.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ ...mockItem, decision: 'approved' }),
      });

      const result = await service.decide('item-self', 'approved', 'self@test.com');

      expect(result.decision).toBe('approved');
      expect(mockReviewItemModel.findOneAndUpdate).toHaveBeenCalled();
    });
  });

  describe('activate (reviewer chain)', () => {
    it('should use manager as reviewer when present', async () => {
      mockCampaignModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          campaignId: 'camp-1',
          status: CampaignStatus.DRAFT,
          scope: { type: 'all' },
          targetEmploymentTypes: ['FULL_TIME', 'PART_TIME', 'CONTRACTOR'],
          deadline: new Date('2026-12-31'),
          allowSelfReview: false,
          selfReviewRiskLevels: ['LOW'],
        }),
      });
      jest.mocked(identityService.findAll)!.mockResolvedValue([
        {
          _id: 'user-1',
          email: 'user1@test.com',
          firstName: 'Test',
          lastName: 'User1',
          managerEmail: 'manager@test.com',
        },
      ]);
      mockReviewItemModel.create.mockResolvedValue({});
      jest.mocked(entitlementCatalog.getCatalogEntriesBatch)!.mockResolvedValue(new Map());

      await service.activate('camp-1');

      expect(mockReviewItemModel.create).toHaveBeenCalled();
      const createCalls = mockReviewItemModel.create.mock.calls;
      expect(createCalls.length).toBeGreaterThan(0);
      expect(createCalls[0][0].reviewerId).toBe('manager@test.com');
      expect(createCalls[0][0].isSelfReview).toBe(false);
      // Revocation acts on the account the membership was reviewed on
      expect(createCalls[0][0].entitlements[0]).toMatchObject({
        system: 'entra-id',
        type: 'group',
        nativeId: 'group-1',
        accountId: 'entra-user1@test.com',
      });
      // Account records (written-back target ids) are read for every identity, not only machines
      expect(identityService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ includeSources: true }),
      );
    });

    it('should fall to entitlement owner when no manager', async () => {
      mockCampaignModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          campaignId: 'camp-1',
          status: CampaignStatus.DRAFT,
          scope: { type: 'all' },
          targetEmploymentTypes: ['FULL_TIME', 'PART_TIME', 'CONTRACTOR'],
          deadline: new Date('2026-12-31'),
          allowSelfReview: false,
          selfReviewRiskLevels: ['LOW'],
        }),
      });
      jest.mocked(identityService.findAll)!.mockResolvedValue([
        {
          _id: 'user-1',
          email: 'user1@test.com',
          firstName: 'Test',
          lastName: 'User1',
          managerEmail: undefined,
          managerId: undefined,
        },
      ]);
      jest.mocked(entitlementCatalog.getOwner)!.mockResolvedValue('owner@test.com');
      jest
        .mocked(entitlementCatalog.getCatalogEntriesBatch)!
        .mockResolvedValue(
          new Map([['entra-id:group-1', { owner: 'owner@test.com', riskLevel: 'MEDIUM' }]]),
        );
      mockReviewItemModel.create.mockResolvedValue({});

      await service.activate('camp-1');

      const createCalls = mockReviewItemModel.create.mock.calls;
      expect(createCalls.length).toBeGreaterThan(0);
      expect(createCalls[0][0].reviewerId).toBe('owner@test.com');
      expect(createCalls[0][0].isSelfReview).toBe(false);
    });

    it('should use self when allowSelfReview and LOW risk', async () => {
      mockCampaignModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          campaignId: 'camp-1',
          status: CampaignStatus.DRAFT,
          scope: { type: 'all' },
          targetEmploymentTypes: ['FULL_TIME', 'PART_TIME', 'CONTRACTOR'],
          deadline: new Date('2026-12-31'),
          allowSelfReview: true,
          selfReviewRiskLevels: ['LOW'],
        }),
      });
      jest.mocked(identityService.findAll)!.mockResolvedValue([
        {
          _id: 'user-1',
          email: 'self@test.com',
          firstName: 'Self',
          lastName: 'User',
          managerEmail: undefined,
          managerId: undefined,
        },
      ]);
      jest.mocked(entitlementCatalog.getOwner)!.mockResolvedValue(null);
      jest
        .mocked(entitlementCatalog.getCatalogEntriesBatch)!
        .mockResolvedValue(new Map([['entra-id:group-1', { riskLevel: 'LOW' }]]));
      mockReviewItemModel.create.mockResolvedValue({});

      await service.activate('camp-1');

      const createCalls = mockReviewItemModel.create.mock.calls;
      expect(createCalls.length).toBeGreaterThan(0);
      expect(createCalls[0][0].reviewerId).toBe('self@test.com');
      expect(createCalls[0][0].isSelfReview).toBe(true);
    });
  });

  describe('activate (accounts in targets without readable memberships)', () => {
    const draft = (scope: { type: string; value?: string }) => ({
      exec: jest.fn().mockResolvedValue({
        campaignId: 'camp-1',
        status: CampaignStatus.DRAFT,
        scope,
        targetEmploymentTypes: ['FULL_TIME'],
        deadline: new Date('2026-12-31'),
        allowSelfReview: false,
        selfReviewRiskLevels: ['LOW'],
      }),
    });
    const provisioning = [
      { targetSystem: 'file-outbound', status: 'SYNCED', writebackComplete: true },
      { targetSystem: 'github', status: 'SYNCED' },
      { targetSystem: 'servicenow', status: 'DEPROVISIONED' },
    ];
    const sources = [
      { sourceName: 'csv-hr', externalId: 'E102', sourceRole: 'primary-hr' },
      { sourceName: 'github', externalId: 'github-user-7', sourceRole: 'target' },
    ];
    const created = () => mockReviewItemModel.create.mock.calls.map((c) => c[0]);

    beforeEach(() => {
      jest.mocked(entraService.listUserMemberships)!.mockResolvedValue([]);
      mockReviewItemModel.create.mockResolvedValue({});
    });

    it('reviews each account the identity has there, one item each (scope all)', async () => {
      mockCampaignModel.findOne.mockReturnValue(draft({ type: 'all' }));
      jest.mocked(identityService.findAll)!.mockResolvedValue([
        {
          _id: 'user-7',
          email: 'alan.turing@acme.test',
          firstName: 'Alan',
          lastName: 'Turing',
          employmentType: 'FULL_TIME',
          provisioning,
          sources,
        },
      ]);

      await service.activate('camp-1');

      expect(identityService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ includeProvisioning: true }),
      );
      expect(created().map((i) => i.entitlements)).toEqual([
        [{ system: 'file-outbound', type: 'account', name: 'Account', policyManaged: true }],
        [
          {
            system: 'github',
            type: 'account',
            name: 'Account',
            accountId: 'github-user-7',
            policyManaged: true,
          },
        ],
      ]);
      expect(created()[0]).toMatchObject({
        identityId: 'user-7',
        reviewerId: 'unassigned@review.pending',
        decision: 'pending',
      });
    });

    const scopedTo = async (system: string) => {
      mockCampaignModel.findOne.mockReturnValue(draft({ type: 'system', value: system }));
      jest.mocked(identityService.findIdentitiesForOnboarding)!.mockResolvedValue([
        {
          _id: 'user-7',
          profile: { email: 'alan.turing@acme.test', employmentType: 'FULL_TIME' },
          provisioning: [...provisioning, { targetSystem: 'entra-id', status: 'SYNCED' }],
          sources,
        },
      ] as never);
      // The identity is also in an Entra ID group
      jest
        .mocked(entraService.listUserMemberships)!
        .mockResolvedValue([
          { id: 'group-1', displayName: 'Finance-Admins', odataType: '#microsoft.graph.group' },
        ] as never);

      await service.activate('camp-1');
      return created().map((i) => `${i.entitlements[0].system}:${i.entitlements[0].type}`);
    };

    it('a campaign scoped to such a system reviews only its account there (scope system)', async () => {
      // Not the GitHub account, not the Entra ID membership
      expect(await scopedTo('file-outbound')).toEqual(['file-outbound:account']);
    });

    it("a campaign scoped to Entra ID reviews only that system's memberships", async () => {
      expect(await scopedTo('entra-id')).toEqual(['entra-id:group']);
    });

    it('names the scoped system as the policy engine does (`entra` is entra-id)', async () => {
      expect(await scopedTo('entra')).toEqual(['entra-id:group']);
    });

    it('selects identities by the names items use (`entraid`, `fileoutbound`)', async () => {
      // A substring of the provisioning target selected nobody for these
      expect(await scopedTo('entraid')).toEqual(['entra-id:group']);
      mockReviewItemModel.create.mockClear();
      expect(await scopedTo('fileoutbound')).toEqual(['file-outbound:account']);
    });

    it('scoped to `active-directory`, reviews identities provisioned to `ad`', async () => {
      configActivities.getActiveTargetSystems.mockResolvedValue(['ad']);
      configActivities.getConnectorConfig.mockResolvedValue({ host: 'ldap.corp.test' });
      adService.getUserGroupDns.mockResolvedValue(['CN=Developers,OU=Groups,DC=corp']);
      mockCampaignModel.findOne.mockReturnValue(
        draft({ type: 'system', value: 'active-directory' }),
      );
      jest.mocked(identityService.findIdentitiesForOnboarding)!.mockResolvedValue([
        {
          _id: 'user-8',
          profile: { email: 'grace.hopper@acme.test', employmentType: 'FULL_TIME' },
          provisioning: [{ targetSystem: 'ad', status: 'SYNCED' }],
          sources: [
            { sourceName: 'ad', externalId: 'CN=Grace,OU=Users,DC=corp', sourceRole: 'target' },
          ],
        },
      ] as never);

      await service.activate('camp-1');

      expect(created().map((i) => i.entitlements[0])).toEqual([
        expect.objectContaining({
          system: 'ad',
          type: 'group',
          name: 'Developers',
          accountId: 'CN=Grace,OU=Users,DC=corp',
        }),
      ]);
    });
  });

  describe('activate (machine identities)', () => {
    it('should include SERVICE_ACCOUNT when targetEmploymentTypes includes it', async () => {
      mockCampaignModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          campaignId: 'camp-1',
          status: CampaignStatus.DRAFT,
          scope: { type: 'all' },
          targetEmploymentTypes: ['FULL_TIME', 'SERVICE_ACCOUNT'],
          deadline: new Date('2026-12-31'),
          allowSelfReview: false,
          selfReviewRiskLevels: ['LOW'],
        }),
      });
      jest.mocked(identityService.findAll)!.mockResolvedValue([
        {
          _id: 'scim-id-1',
          email: 'scim-workday@service.internal',
          firstName: 'Workday SCIM',
          lastName: 'Service Account',
          employmentType: 'SERVICE_ACCOUNT',
          sources: [{ sourceName: 'scim-token', externalId: 'token-123' }],
        },
      ]);
      mockScimTokenModel.findById.mockReturnValue({
        lean: () => ({
          exec: () =>
            Promise.resolve({
              _id: 'token-123',
              scopes: ['Users:read', 'Users:write'],
              createdBy: 'admin@test.com',
            }),
        }),
      });
      jest.mocked(entitlementCatalog.isPolicyManaged)!.mockResolvedValue(true);
      mockReviewItemModel.create.mockResolvedValue({});

      await service.activate('camp-1');

      expect(mockReviewItemModel.create).toHaveBeenCalled();
      const createCalls = mockReviewItemModel.create.mock.calls;
      expect(createCalls.length).toBe(2);
      const scimCall = createCalls.find((c) => c[0].entitlements?.[0]?.system === 'euroid-scim');
      expect(scimCall).toBeDefined();
      expect(scimCall![0].entitlements[0]).toMatchObject({
        system: 'euroid-scim',
        type: 'license',
        name: 'Users:read',
        nativeId: 'Users:read',
      });
      expect(scimCall![0].reviewerId).toBe('admin@test.com');
    });
  });

  describe('activate (carry-forward)', () => {
    it('should set previousDecision on items when campaign has previousCampaignId', async () => {
      mockCampaignModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          campaignId: 'camp-2',
          status: CampaignStatus.DRAFT,
          scope: { type: 'all' },
          targetEmploymentTypes: ['FULL_TIME', 'PART_TIME', 'CONTRACTOR'],
          deadline: new Date('2026-12-31'),
          allowSelfReview: false,
          selfReviewRiskLevels: ['LOW'],
          recurrence: { enabled: true, previousCampaignId: 'camp-1' },
        }),
      });
      jest.mocked(identityService.findAll)!.mockResolvedValue([
        {
          _id: 'user-1',
          email: 'user1@test.com',
          firstName: 'Test',
          lastName: 'User1',
          managerEmail: 'manager@test.com',
        },
      ]);
      jest.mocked(entitlementCatalog.getCatalogEntriesBatch)!.mockResolvedValue(new Map());
      mockReviewItemModel.create.mockResolvedValue({});

      const prevItems = [
        {
          campaignId: 'camp-1',
          identityId: 'user-1',
          decision: 'approved',
          decidedAt: new Date('2026-01-15'),
          entitlements: [{ system: 'entra-id', nativeId: 'group-1', name: 'Finance-Admins' }],
        },
        {
          campaignId: 'camp-1',
          identityId: 'user-1',
          decision: 'revoked',
          decidedAt: new Date('2026-01-16'),
          entitlements: [{ system: 'entra-id', nativeId: 'group-2', name: 'Sales-Admins' }],
        },
      ];
      mockReviewItemModel.find.mockReturnValueOnce({
        lean: () => ({ exec: () => Promise.resolve(prevItems) }),
      } as unknown as ReturnType<typeof mockReviewItemModel.find>);

      await service.activate('camp-2');

      const createCalls = mockReviewItemModel.create.mock.calls;
      expect(createCalls.length).toBeGreaterThan(0);
      const approvedItem = createCalls.find((c) => c[0].previousDecision === 'approved');
      const revokedItem = createCalls.find((c) => c[0].previousDecision === 'revoked');
      expect(approvedItem).toBeDefined();
      expect(approvedItem![0].previousDecisionDate).toBeDefined();
      expect(approvedItem![0].previousCampaignId).toBe('camp-1');
      expect(revokedItem).toBeDefined();
      expect(revokedItem![0].previousCampaignId).toBe('camp-1');
    });
  });

  describe('getMyReviews', () => {
    it('should return items for reviewer', async () => {
      const items = [{ itemId: 'item-1', reviewerId: 'manager@test.com' }];
      mockReviewItemModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(5),
      });
      mockReviewItemModel.find.mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(items),
      });
      mockCampaignModel.distinct.mockReturnValueOnce({
        exec: jest.fn().mockResolvedValue(['camp-cancelled']),
      });

      const result = await service.getMyReviews('manager@test.com');

      expect(result.total).toBe(5);
      expect(result.data).toEqual(items);
      // The reviewer's own items in the caller's tenant, none of a cancelled or draft campaign
      const mine = {
        reviewerId: 'manager@test.com',
        tenantId: 'test-tenant',
        campaignId: { $nin: ['camp-cancelled'] },
      };
      expect(mockReviewItemModel.find).toHaveBeenCalledWith(mine);
      expect(mockReviewItemModel.countDocuments).toHaveBeenCalledWith(mine);
      expect(mockCampaignModel.distinct).toHaveBeenCalledWith('campaignId', {
        tenantId: 'test-tenant',
        status: { $in: [CampaignStatus.CANCELLED, CampaignStatus.DRAFT] },
      });
    });
  });
});
