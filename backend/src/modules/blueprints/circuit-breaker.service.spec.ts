import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { createMockEventEmitter } from '@testing/test-helpers';
import { CircuitBreakerService } from './circuit-breaker.service';
import { ProvisioningMetrics } from './schemas/provisioning-metrics.schema';
import { PipelineService } from './pipeline.service';
import { BlueprintsService } from './blueprints.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { EventsGateway } from '@infrastructure/realtime/events.gateway';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

describe('CircuitBreakerService', () => {
  let service: CircuitBreakerService;
  let mockMetricsModel: Record<string, jest.Mock>;
  let mockPipelineService: Record<string, jest.Mock>;
  let mockBlueprintsService: Record<string, jest.Mock>;
  let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;
  let mockEventsGateway: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockMetricsModel = {
      findOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      }),
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockImplementation((data) => data),
    };

    mockPipelineService = {
      getPipelineConfig: jest.fn().mockResolvedValue({
        errorThresholdPercent: 5,
        minSampleSizeForCircuitBreaker: 5,
      }),
      getPipelineStatus: jest.fn().mockResolvedValue('DEPLOYED'),
      pause: jest.fn().mockResolvedValue({ status: 'PAUSED' }),
    };

    mockBlueprintsService = {
      getLatestBlueprint: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
    };

    mockEventEmitter = createMockEventEmitter();

    mockEventsGateway = {
      broadcastToRoom: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        CircuitBreakerService,
        { provide: getModelToken(ProvisioningMetrics.name), useValue: mockMetricsModel },
        { provide: PipelineService, useValue: mockPipelineService },
        { provide: BlueprintsService, useValue: mockBlueprintsService },
        { provide: DomainEventEmitterService, useValue: mockEventEmitter },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    service = module.get<CircuitBreakerService>(CircuitBreakerService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── recordOutcome ─────────────────────────────────────────────────────

  describe('recordOutcome', () => {
    it('should create new metrics doc when none exists', async () => {
      // findOne returns null → create path
      mockMetricsModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      await service.recordOutcome('test-tenant', true);

      expect(mockMetricsModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'test-tenant',
          successCount: 1,
          failureCount: 0,
        }),
      );
    });

    it('should increment counts within window', async () => {
      const existingMetrics = {
        _id: 'metrics-1',
        tenantId: 'test-tenant',
        totalAttempts: 4,
        successCount: 3,
        failureCount: 1,
        errorRate: 0.25,
        windowStart: new Date(),
      };

      mockMetricsModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(existingMetrics),
      });

      const updatedMetrics = {
        ...existingMetrics,
        totalAttempts: 5,
        failureCount: 2,
      };
      mockMetricsModel.findOneAndUpdate.mockResolvedValue(updatedMetrics);

      await service.recordOutcome('test-tenant', false);

      expect(mockMetricsModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'test-tenant' }),
        expect.objectContaining({ $inc: expect.any(Object) }),
        expect.objectContaining({ new: true }),
      );
    });

    it('should reset window when expired', async () => {
      const expiredDate = new Date();
      expiredDate.setHours(expiredDate.getHours() - 2);

      const expiredMetrics = {
        _id: 'metrics-1',
        tenantId: 'test-tenant',
        totalAttempts: 150,
        successCount: 100,
        failureCount: 50,
        errorRate: 0.33,
        windowStart: expiredDate,
      };

      mockMetricsModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(expiredMetrics),
      });

      mockMetricsModel.findOneAndUpdate.mockResolvedValue({
        tenantId: 'test-tenant',
        totalAttempts: 1,
        successCount: 1,
        failureCount: 0,
        errorRate: 0,
        windowStart: new Date(),
      });

      await service.recordOutcome('test-tenant', true);

      expect(mockMetricsModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'test-tenant' }),
        expect.objectContaining({ $set: expect.any(Object) }),
        expect.objectContaining({ new: true }),
      );
    });
  });

  // ── checkCircuitBreaker ───────────────────────────────────────────────

  describe('checkCircuitBreaker', () => {
    it('should trip when error rate exceeds threshold', async () => {
      const highErrorMetrics = {
        tenantId: 'test-tenant',
        totalAttempts: 15,
        successCount: 5,
        failureCount: 10,
        errorRate: 0.67,
        windowStart: new Date(),
      };

      mockMetricsModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(highErrorMetrics),
      });

      await service.checkCircuitBreaker('test-tenant');

      expect(mockPipelineService.pause).toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalled();
      expect(mockEventsGateway.broadcastToRoom).toHaveBeenCalled();
    });

    it('should do nothing when status is not DEPLOYED', async () => {
      mockPipelineService.getPipelineStatus.mockResolvedValue('PAUSED');

      await service.checkCircuitBreaker('test-tenant');

      expect(mockPipelineService.pause).not.toHaveBeenCalled();
    });

    it('should do nothing when sample size below minimum', async () => {
      const smallSampleMetrics = {
        tenantId: 'test-tenant',
        totalAttempts: 2,
        successCount: 1,
        failureCount: 1,
        errorRate: 0.5,
        windowStart: new Date(),
      };

      mockMetricsModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(smallSampleMetrics),
      });

      await service.checkCircuitBreaker('test-tenant');

      expect(mockPipelineService.pause).not.toHaveBeenCalled();
    });

    it('should do nothing when error rate below threshold', async () => {
      const healthyMetrics = {
        tenantId: 'test-tenant',
        totalAttempts: 96,
        successCount: 95,
        failureCount: 1,
        errorRate: 0.01,
        windowStart: new Date(),
      };

      mockMetricsModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(healthyMetrics),
      });

      await service.checkCircuitBreaker('test-tenant');

      expect(mockPipelineService.pause).not.toHaveBeenCalled();
    });
  });
});
