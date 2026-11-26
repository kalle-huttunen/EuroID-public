import { Test } from '@nestjs/testing';
import { InternalServerErrorException } from '@nestjs/common';
import { createMockEventEmitter } from '@testing/test-helpers';
import { OffboardingService } from './offboarding.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

// The real URL builder with the UI address and namespace pinned (the environment may set them)
jest.mock('@infrastructure/config/temporal.config', () => {
  const actual = jest.requireActual<typeof import('@infrastructure/config/temporal.config')>(
    '@infrastructure/config/temporal.config',
  );
  return {
    temporalWorkflowUrl: (workflowId: string) =>
      actual.temporalWorkflowUrl(workflowId, 'http://localhost:8233', 'default'),
  };
});

describe('OffboardingService', () => {
  let service: OffboardingService;
  let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;
  let mockWorkflowStart: jest.Mock;
  let mockTemporalClientProvider: {
    getClient: jest.Mock;
  };
  let mockIdentityService: {
    findById: jest.Mock;
  };

  beforeEach(async () => {
    mockWorkflowStart = jest.fn().mockResolvedValue({ workflowId: 'mock-workflow-id' });
    mockTemporalClientProvider = {
      getClient: jest.fn().mockReturnValue({ workflow: { start: mockWorkflowStart } }),
    };
    mockEventEmitter = createMockEventEmitter();
    mockIdentityService = {
      findById: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        OffboardingService,
        { provide: DomainEventEmitterService, useValue: mockEventEmitter },
        { provide: TemporalClientProvider, useValue: mockTemporalClientProvider },
      ],
    }).compile();

    service = module.get<OffboardingService>(OffboardingService);
  });

  describe('triggerOffboarding', () => {
    it('should emit IDENTITY_STATUS_CHANGED event', async () => {
      await service.triggerOffboarding('user-123', 'john@example.com');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        DomainEventType.IDENTITY_STATUS_CHANGED,
        'user-123',
        expect.objectContaining({
          identityId: 'user-123',
          previousStatus: 'ACTIVE',
          newStatus: 'SUSPENDED',
          reason: 'offboarding',
        }),
      );
    });

    it('should start workflow with correct workflowId', async () => {
      const result = await service.triggerOffboarding('user-123', 'john@example.com');

      expect(result).toBe('t-test-tenant-offboard-user-123');
      expect(mockWorkflowStart).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          workflowId: 't-test-tenant-offboard-user-123',
          args: [{ userId: 'user-123', userEmail: 'john@example.com', tenantId: 'test-tenant' }],
          searchAttributes: { TenantId: ['test-tenant'] },
        }),
      );
    });

    it('records an HR leaver reason in the memo and the status change, same workflow id', async () => {
      await service.triggerOffboarding('user-123', 'john@example.com', 'leaver:end-date');

      expect(mockWorkflowStart).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          workflowId: 't-test-tenant-offboard-user-123',
          memo: expect.objectContaining({ reason: 'leaver:end-date' }),
        }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        DomainEventType.IDENTITY_STATUS_CHANGED,
        'user-123',
        expect.objectContaining({ reason: 'offboarding (leaver:end-date)' }),
      );
    });

    it('leaves the memo without a reason for a manual offboarding', async () => {
      await service.triggerOffboarding('user-123', 'john@example.com');

      const options = mockWorkflowStart.mock.calls[0][1] as { memo: Record<string, unknown> };
      expect(options.memo).not.toHaveProperty('reason');
    });

    it('names the identity by id in the memo, never the email (Temporal UI, describe)', async () => {
      await service.triggerOffboarding('user-123', 'john@example.com', 'leaver:terminated');

      const options = mockWorkflowStart.mock.calls[0][1] as { memo: Record<string, unknown> };
      expect(options.memo).toEqual({
        triggeredBy: 'OffboardingService',
        targetDescription: 'Offboarding: identity user-123',
        reason: 'leaver:terminated',
      });
      expect(JSON.stringify(options.memo)).not.toContain('john@example.com');
    });
  });

  describe('triggerOffboardingById', () => {
    beforeEach(() => {
      service.setIdentityService(mockIdentityService as any);
    });

    it('should return success with workflowId when user found', async () => {
      mockIdentityService.findById.mockResolvedValue({
        _id: 'user-123',
        email: 'john@example.com',
      });

      const result = await service.triggerOffboardingById('user-123');

      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          workflowId: 't-test-tenant-offboard-user-123',
          trackingUrl:
            'http://localhost:8233/namespaces/default/workflows/t-test-tenant-offboard-user-123',
          message: 'Offboarding workflow started for john@example.com',
        }),
      );
    });

    it('should return error when user not found', async () => {
      mockIdentityService.findById.mockResolvedValue(null);

      const result = await service.triggerOffboardingById('user-999');

      expect(result).toEqual({ success: false, error: 'User not found' });
    });

    it('should return error when user has no email', async () => {
      mockIdentityService.findById.mockResolvedValue({
        _id: 'user-123',
        email: undefined,
      });

      const result = await service.triggerOffboardingById('user-123');

      expect(result).toEqual({
        success: false,
        error: 'User has no email; cannot trigger offboarding',
      });
    });

    it('should throw InternalServerErrorException when identityService not injected', async () => {
      const freshModule = await Test.createTestingModule({
        providers: [
          OffboardingService,
          { provide: DomainEventEmitterService, useValue: mockEventEmitter },
          { provide: TemporalClientProvider, useValue: mockTemporalClientProvider },
        ],
      }).compile();

      const freshService = freshModule.get<OffboardingService>(OffboardingService);

      await expect(freshService.triggerOffboardingById('user-123')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
