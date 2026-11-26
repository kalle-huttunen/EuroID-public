import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { AuditService } from './audit.service';
import { AuditEvent } from './schemas/audit-event.schema';
import { AuditChainHead } from './schemas/audit-chain-head.schema';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

describe('AuditService', () => {
  let service: AuditService;
  let mockAuditModel: any;

  beforeEach(async () => {
    mockAuditModel = {
      create: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      countDocuments: jest.fn(),
    };

    // Chain stubs for findOne().sort().select().lean().exec()
    const findOneChain = {
      sort: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(null),
    };
    mockAuditModel.findOne.mockReturnValue(findOneChain);

    // Chain stubs for find().sort().lean().exec()
    const findChain = {
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    mockAuditModel.find.mockReturnValue(findChain);

    // countDocuments chain
    mockAuditModel.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

    const module = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getModelToken(AuditEvent.name), useValue: mockAuditModel },
        { provide: getModelToken(AuditChainHead.name), useValue: {} },
      ],
    }).compile();

    service = module.get(AuditService);
  });

  const baseEvent = {
    action: 'PROVISIONING_EXECUTED' as const,
    severity: 'info' as const,
    actor: 'TestActor',
    resourceType: 'identity',
    resourceId: 'id-001',
    resourceName: 'Test Identity',
    description: 'Test event',
    tenantId: 'test-tenant',
  };

  // Writing and verifying the hash chain: audit-chain.integration.spec.ts (in-memory MongoDB).

  describe('logFireAndForget', () => {
    it('does not throw on a failed write, and logs the failure', async () => {
      const log = jest.spyOn(service, 'log').mockRejectedValue(new Error('fail'));
      const error = jest
        .spyOn((service as unknown as { logger: Logger }).logger, 'error')
        .mockImplementation(() => undefined);

      expect(() => service.logFireAndForget(baseEvent)).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve)); // the write runs detached

      expect(log).toHaveBeenCalledWith(baseEvent);
      expect(error).toHaveBeenCalledWith('[Audit] Fire-and-forget write failed: fail');
    });
  });

  describe('query', () => {
    it('should apply action filter', async () => {
      const findChain = {
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      };
      mockAuditModel.find.mockReturnValue(findChain);
      mockAuditModel.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      const result = await service.query({ action: ['LOGIN' as any] });

      const filter = { tenantId: 'test-tenant', action: { $in: ['LOGIN'] } };
      expect(mockAuditModel.find).toHaveBeenCalledWith(filter);
      expect(mockAuditModel.countDocuments).toHaveBeenCalledWith(filter);
      expect(result).toEqual(expect.objectContaining({ data: [], total: 0, page: 1 }));
    });

    it('should cap limit at 100', async () => {
      const findChain = {
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      };
      mockAuditModel.find.mockReturnValue(findChain);
      mockAuditModel.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      await service.query({}, 1, 500);

      expect(findChain.limit).toHaveBeenCalledWith(100);
    });
  });

  describe('getStats', () => {
    it('should return aggregated counts', async () => {
      mockAuditModel.countDocuments
        .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(100) })
        .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(5) })
        .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(10) })
        .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(20) });

      const result = await service.getStats();

      expect(result).toEqual({ total: 100, critical: 5, warnings: 10, today: 20 });
    });
  });
});
