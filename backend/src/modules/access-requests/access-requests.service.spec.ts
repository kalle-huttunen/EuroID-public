import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { AccessRequestsService } from './access-requests.service';
import { AccessRequestCreationService } from './access-request-creation.service';
import { AccessRequestDecisionService } from './access-request-decision.service';
import { AccessRequestQueryService } from './access-request-query.service';
import { AccessRequestSodService } from './access-request-sod.service';
import { AccessRequestClosureService } from './access-request-closure.service';

jest.mock('@infrastructure/multi-tenancy/tenant-context.helper', () => ({
  getCurrentTenantId: () => 'test-tenant',
}));
import { AccessRequest } from './schemas/access-request.schema';
import { AdminUser } from '../auth/schemas/admin-user.schema';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { SodService } from '../policy/sod.service';
import { PolicyEngineService } from '../policy/policy-engine.service';
import { IDENTITY_QUERY_PORT } from '@shared/interfaces/identity-query.port';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { accessRequestsConfig } from '@infrastructure/config/access-requests.config';

describe('AccessRequestsService', () => {
  let service: AccessRequestsService;
  let catalogService: jest.Mocked<Partial<EntitlementCatalogService>>;
  let sodService: jest.Mocked<Partial<SodService>>;
  let identityQuery: { findById: jest.Mock; findByEmail: jest.Mock };
  let temporalClient: jest.Mocked<Partial<TemporalClientProvider>>;

  const mockAccessRequestModel = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    updateOne: jest.fn(),
    countDocuments: jest.fn(),
  };

  beforeEach(async () => {
    catalogService = {
      findCatalogEntryById: jest.fn(),
    };
    sodService = {
      validate: jest.fn().mockResolvedValue([]),
    };
    identityQuery = {
      findById: jest.fn(),
      findByEmail: jest.fn(),
    };
    temporalClient = {
      getClient: jest.fn().mockReturnValue({
        workflow: {
          start: jest.fn(),
          getHandle: jest.fn().mockReturnValue({ signal: jest.fn() }),
        },
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccessRequestsService,
        AccessRequestCreationService,
        AccessRequestDecisionService,
        AccessRequestQueryService,
        AccessRequestSodService,
        AccessRequestClosureService,
        { provide: getModelToken(AccessRequest.name), useValue: mockAccessRequestModel },
        { provide: getModelToken(AdminUser.name), useValue: { findOne: jest.fn() } },
        { provide: EntitlementCatalogService, useValue: catalogService },
        { provide: SodService, useValue: sodService },
        {
          provide: PolicyEngineService,
          useValue: { evaluate: jest.fn().mockResolvedValue({ operations: [] }) },
        },
        { provide: IDENTITY_QUERY_PORT, useValue: identityQuery },
        { provide: TemporalClientProvider, useValue: temporalClient },
        { provide: DomainEventEmitterService, useValue: { emit: jest.fn() } },
        { provide: accessRequestsConfig.KEY, useValue: { approvalTimeoutDays: 7 } },
      ],
    }).compile();

    service = module.get(AccessRequestsService);
    jest.clearAllMocks();
  });

  describe('getRequestDetail', () => {
    it('should return request when requester is the request owner', async () => {
      const mockRequest = {
        requestId: 'req-1',
        status: 'PENDING_APPROVAL',
        requesterId: 'user-1',
        requesterEmail: 'user@test.com',
        approvalSteps: [],
      };
      mockAccessRequestModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockRequest),
      });

      const result = await service.getRequestDetail('req-1', 'user-1', 'user@test.com');
      expect(result).toEqual(mockRequest);
      expect(mockAccessRequestModel.findOne).toHaveBeenCalledWith({
        requestId: 'req-1',
        tenantId: 'test-tenant',
      });
    });

    it('should throw ForbiddenException when caller is neither requester nor approver', async () => {
      const mockRequest = {
        requestId: 'req-1',
        status: 'PENDING_APPROVAL',
        requesterId: 'user-1',
        requesterEmail: 'user@test.com',
        approvalSteps: [{ approverId: 'approver-1', approverEmail: 'approver@test.com' }],
      };
      mockAccessRequestModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockRequest),
      });

      await expect(
        service.getRequestDetail('req-1', 'other-user', 'other@test.com'),
      ).rejects.toThrow('You can only view your own requests');
    });

    it('should throw NotFoundException when not found', async () => {
      mockAccessRequestModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.getRequestDetail('nonexistent', 'user-1', 'user@test.com'),
      ).rejects.toThrow('Access request not found');
    });
  });

  describe('listMyRequests', () => {
    it('should return paginated requests', async () => {
      const mockRequests = [{ requestId: 'req-1' }];
      const sort = jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(mockRequests) }),
      });
      const limit = jest.fn().mockReturnValue({ sort });
      const skip = jest.fn().mockReturnValue({ limit });
      mockAccessRequestModel.find.mockReturnValue({ skip });
      mockAccessRequestModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(21),
      });

      const result = await service.listMyRequests('user-1', { page: 2, limit: 20 });

      expect(result.data).toEqual(mockRequests);
      expect(result.total).toBe(21);
      // Only the caller's own requests in the caller's tenant, page 2 newest first
      const ownRequests = { tenantId: 'test-tenant', requesterId: 'user-1' };
      expect(mockAccessRequestModel.find).toHaveBeenCalledWith(ownRequests);
      expect(mockAccessRequestModel.countDocuments).toHaveBeenCalledWith(ownRequests);
      expect(skip).toHaveBeenCalledWith(20);
      expect(limit).toHaveBeenCalledWith(20);
      expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
    });
  });
});
