import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { AgentManagementService } from './agent-management.service';
import { Agent } from './agent.schema';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AGENT_CONFIG } from './agent-management.config';

// Mock requestContext
jest.mock('@infrastructure/middleware/correlation.middleware', () => ({
  requestContext: {
    getStore: () => ({ tenantId: 'test-tenant' }),
  },
}));

describe('AgentManagementService', () => {
  let service: AgentManagementService;
  let mockModel: Record<string, jest.Mock>;
  let mockEventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    mockModel = {
      create: jest.fn(),
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue([]),
          }),
        }),
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(null),
        }),
      }),
      findOneAndUpdate: jest.fn(),
      countDocuments: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    };
    mockEventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentManagementService,
        { provide: getModelToken(Agent.name), useValue: mockModel },
        { provide: DomainEventEmitterService, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get(AgentManagementService);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('register', () => {
    it('creates and returns a new agent', async () => {
      const dto = { name: 'Agent A', connectorTypes: ['entra'], taskQueue: 'provisioning-entra' };
      const created = { agentId: 'agent-123', ...dto, tenantId: 'test-tenant', status: 'online' };
      mockModel.create.mockResolvedValue(created);

      const result = await service.register(dto as any);

      expect(result.agentId).toBe('agent-123');
      expect(mockModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Agent A', status: 'online', tenantId: 'test-tenant' }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalled();
    });

    it('rejects when max agents reached', async () => {
      mockModel.countDocuments.mockResolvedValue(50);

      await expect(
        service.register({ name: 'X', connectorTypes: [], taskQueue: 'q' } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('heartbeat', () => {
    it('updates lastHeartbeat and returns agent', async () => {
      const agent = { agentId: 'a1', status: 'degraded', lastHeartbeat: new Date() };
      mockModel.findOneAndUpdate.mockResolvedValue(agent);

      const result = await service.heartbeat('a1', { status: 'degraded', version: '1.2.0' } as any);

      expect(result).toBe(agent);
      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { agentId: 'a1', tenantId: 'test-tenant', status: { $ne: 'decommissioned' } },
        { $set: { lastHeartbeat: expect.any(Date), status: 'degraded', version: '1.2.0' } },
        { new: true },
      );
    });

    it('throws NotFoundException for unknown agent', async () => {
      mockModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(service.heartbeat('unknown', {} as any)).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('returns tenant-scoped agents', async () => {
      const result = await service.findAll();
      expect(Array.isArray(result)).toBe(true);
      expect(mockModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'test-tenant' }),
      );
    });
  });

  describe('getStatusSummary', () => {
    it('returns counts by status', async () => {
      const agents = [
        { status: 'online' },
        { status: 'online' },
        { status: 'offline' },
        { status: 'degraded' },
      ];
      mockModel.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue(agents),
          }),
        }),
      });

      const summary = await service.getStatusSummary();
      expect(summary).toEqual({ online: 2, offline: 1, degraded: 1, total: 4 });
    });
  });

  describe('decommission', () => {
    it('marks agent as decommissioned', async () => {
      const agent = { agentId: 'a1', name: 'Agent A', status: 'decommissioned' };
      mockModel.findOneAndUpdate.mockResolvedValue(agent);

      const result = await service.decommission('a1');

      expect(result).toBe(agent);
      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { agentId: 'a1', tenantId: 'test-tenant', status: { $ne: 'decommissioned' } },
        { $set: { status: 'decommissioned', decommissionedAt: expect.any(Date) } },
        { new: true },
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        DomainEventType.CONNECTOR_HEALTH_CHANGED,
        'a1',
        { agentId: 'a1', status: 'decommissioned', name: 'Agent A' },
      );
    });

    it('throws NotFoundException for unknown agent', async () => {
      mockModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(service.decommission('unknown')).rejects.toThrow(NotFoundException);
    });
  });

  describe('stale agent check', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('logs a failed check and keeps checking, instead of an unhandled rejection', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      const error = jest
        .spyOn((service as unknown as { logger: { error: () => void } }).logger, 'error')
        .mockImplementation(() => undefined);
      try {
        mockModel.updateMany
          .mockRejectedValueOnce(new Error('connection lost'))
          .mockResolvedValueOnce({ modifiedCount: 0 });
        service.onModuleInit();

        await jest.advanceTimersByTimeAsync(AGENT_CONFIG.STALE_CHECK_INTERVAL_MS);
        // Node reports an unhandled rejection once the microtasks have run.
        await new Promise((resolve) => setImmediate(resolve));

        expect(unhandled).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('connection lost'));

        await jest.advanceTimersByTimeAsync(AGENT_CONFIG.STALE_CHECK_INTERVAL_MS);
        expect(mockModel.updateMany).toHaveBeenCalledTimes(2);
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });
  });
});
