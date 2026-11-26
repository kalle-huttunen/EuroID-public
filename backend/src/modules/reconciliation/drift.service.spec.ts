import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { DriftService } from './drift.service';
import { Drift } from './schemas/drift.schema';
import { DriftCorrectionService } from './drift-correction.service';
import { OrphanCleanupService } from './orphan-cleanup.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { createMockEventEmitter } from '@testing/test-helpers';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

jest.mock('@shared/utils/paginate-query', () => ({
  paginateQuery: jest.fn(),
}));

describe('DriftService', () => {
  let service: DriftService;
  let mockDriftModel: any;
  let mockDriftCorrection: Record<string, jest.Mock>;
  let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;
  const orphanCleanup = { stop: jest.fn() };

  /** Create a Promise that also has an .exec() method, mimicking Mongoose Query */
  const mockQuery = <T>(value: T) => {
    const p = Promise.resolve(value) as Promise<T> & { exec: jest.Mock };
    p.exec = jest.fn().mockResolvedValue(value);
    return p;
  };

  const createMockDrift = (overrides = {}) => ({
    _id: 'drift-1',
    tenantId: 'test-tenant',
    userId: 'user-1',
    targetSystem: 'entra-id',
    fieldName: 'displayName',
    expectedValue: 'John Doe',
    actualValue: 'Johnny Doe',
    status: 'open',
    type: 'FIELD_MISMATCH',
    detectedAt: new Date(),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  beforeEach(async () => {
    mockDriftCorrection = {
      executeCorrection: jest.fn().mockResolvedValue({ success: true, skipConnector: false }),
    };

    mockEventEmitter = createMockEventEmitter();

    mockDriftModel = {
      create: jest.fn().mockImplementation((data) => ({
        ...data,
        status: data.status || 'open',
        detectedAt: data.detectedAt || new Date(),
      })),
      // findOne: used both with .exec() (getDriftById) and without (autoCorrect/ignoreDrift)
      findOne: jest.fn().mockImplementation(() => mockQuery(createMockDrift())),
      // find: uses .sort().limit().exec() chain OR .exec() directly
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue([createMockDrift()]),
          }),
        }),
        exec: jest.fn().mockResolvedValue([createMockDrift()]),
      }),
      aggregate: jest.fn().mockReturnValue({
        exec: jest
          .fn()
          .mockResolvedValue([
            { _id: null, total: 5, critical: 2, autoFixEligible: 3, pending: 2 },
          ]),
      }),
      // findOneAndUpdate: awaited directly (no .exec())
      findOneAndUpdate: jest.fn().mockResolvedValue(createMockDrift({ status: 'ignored' })),
      // updateMany: awaited directly (no .exec())
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 3 }),
    };

    const module = await Test.createTestingModule({
      providers: [
        DriftService,
        { provide: getModelToken(Drift.name), useValue: mockDriftModel },
        { provide: DriftCorrectionService, useValue: mockDriftCorrection },
        { provide: DomainEventEmitterService, useValue: mockEventEmitter },
        { provide: OrphanCleanupService, useValue: orphanCleanup },
      ],
    }).compile();
    orphanCleanup.stop.mockReset().mockResolvedValue(undefined);

    service = module.get<DriftService>(DriftService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('saveDrift', () => {
    it('should create drift with default status open', async () => {
      const driftData = {
        userId: 'user-1',
        targetSystem: 'entra-id',
        fieldName: 'displayName',
        expectedValue: 'John Doe',
        actualValue: 'Johnny Doe',
      };

      const result = await service.saveDrift(driftData as any);

      // The service sets the defaults, not the model
      expect(mockDriftModel.create).toHaveBeenCalledWith({
        ...driftData,
        status: 'open',
        detectedAt: expect.any(Date),
      });
      expect(result.status).toBe('open');
    });
  });

  describe('getDriftById', () => {
    it('should return drift with tenant filter', async () => {
      const result = await service.getDriftById('drift-1');

      expect(mockDriftModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'drift-1', tenantId: 'test-tenant' }),
      );
      expect(result).toBeDefined();
      expect(result!._id).toBe('drift-1');
    });

    it('should return null when not found', async () => {
      mockDriftModel.findOne.mockImplementationOnce(() => mockQuery(null));

      const result = await service.getDriftById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getDrifts', () => {
    it('should return array without pagination', async () => {
      const result = await service.getDrifts();

      expect(mockDriftModel.find).toHaveBeenCalled();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // The counters themselves: drift-actions-scope.integration.spec.ts (real aggregation)
  describe('getStats', () => {
    it('should return zeros when no data', async () => {
      mockDriftModel.aggregate.mockReturnValueOnce({
        exec: jest.fn().mockResolvedValue([]),
      });

      const result = await service.getStats();

      expect(result).toEqual({ total: 0, critical: 0, autoFixEligible: 0, pending: 0 });
    });
  });

  describe('autoCorrect', () => {
    it('should correct drift and emit event', async () => {
      const mockDrift = createMockDrift();
      mockDriftModel.findOne.mockImplementationOnce(() => mockQuery(mockDrift));

      await service.autoCorrect('drift-1');

      expect(mockDriftCorrection.executeCorrection).toHaveBeenCalledWith(mockDrift, 'test-tenant');
      expect(mockDrift.save).toHaveBeenCalled();
      expect(mockDrift.status).toBe('corrected');
      expect(mockEventEmitter.emit).toHaveBeenCalled();
    });

    it('should throw NotFoundException when drift not found', async () => {
      mockDriftModel.findOne.mockImplementationOnce(() => mockQuery(null));

      await expect(service.autoCorrect('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when correction fails', async () => {
      const mockDrift = createMockDrift();
      mockDriftModel.findOne.mockImplementationOnce(() => mockQuery(mockDrift));
      (mockDriftCorrection.executeCorrection as jest.Mock).mockResolvedValueOnce({
        success: false,
        skipConnector: false,
        error: 'Connection failed',
      });

      await expect(service.autoCorrect('drift-1')).rejects.toThrow(
        new BadRequestException('Correction failed: Connection failed'),
      );
    });

    // A closed drift's stored value may be stale: correcting it again would write that to the target
    it.each(['corrected', 'ignored'])(
      'refuses a drift that is %s: no correction, no cleanup stopped, nothing saved or emitted',
      async (status) => {
        const drift = createMockDrift({ status, type: 'ORPHAN_ACCOUNT', workflowId: 'c' });
        mockDriftModel.findOne.mockImplementationOnce(() => mockQuery(drift));

        await expect(service.autoCorrect('drift-1')).rejects.toThrow(
          new ConflictException(
            `Drift drift-1 is ${status}: only an open drift, or a quarantined orphan drift, can be corrected`,
          ),
        );
        expect(mockDriftCorrection.executeCorrection).not.toHaveBeenCalled();
        expect(orphanCleanup.stop).not.toHaveBeenCalled();
        expect(drift.save).not.toHaveBeenCalled();
        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      },
    );
  });

  describe('ignoreDrift', () => {
    it('should set status to ignored', async () => {
      const mockDrift = createMockDrift();
      mockDriftModel.findOne.mockImplementationOnce(() => mockQuery(mockDrift));

      await service.ignoreDrift('drift-1');

      expect(mockDrift.status).toBe('ignored');
      expect(mockDrift.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException when drift not found', async () => {
      mockDriftModel.findOne.mockImplementationOnce(() => mockQuery(null));

      await expect(service.ignoreDrift('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // The cleanup of an orphan drift closed by hand would still disable (and maybe delete) the account
  describe('an orphan drift closed by hand', () => {
    const orphan = () =>
      createMockDrift({ type: 'ORPHAN_ACCOUNT', status: 'quarantined', workflowId: 'cleanup-1' });

    it.each([
      ['ignored', (s: DriftService) => s.ignoreDrift('drift-1'), 'ignored'],
      ['corrected', (s: DriftService) => s.autoCorrect('drift-1'), 'corrected'],
    ])('stops its cleanup before it is saved %s', async (_label, close, status) => {
      const drift = orphan();
      mockDriftModel.findOne.mockImplementationOnce(() => mockQuery(drift));
      mockDriftCorrection.executeCorrection.mockResolvedValueOnce({
        success: true,
        skipConnector: true,
      });

      await close(service);

      expect(orphanCleanup.stop).toHaveBeenCalledWith('cleanup-1');
      expect(orphanCleanup.stop.mock.invocationCallOrder[0]).toBeLessThan(
        drift.save.mock.invocationCallOrder[0],
      );
      expect(drift.status).toBe(status);
    });

    it('stays open when its cleanup cannot be stopped', async () => {
      const drift = orphan();
      mockDriftModel.findOne.mockImplementationOnce(() => mockQuery(drift));
      orphanCleanup.stop.mockRejectedValueOnce(new Error('Temporal is not connected'));

      await expect(service.ignoreDrift('drift-1')).rejects.toThrow('Temporal is not connected');
      expect(drift.save).not.toHaveBeenCalled();
    });

    it('stops no cleanup of a corrected orphan drift: the ignore is refused', async () => {
      mockDriftModel.findOne.mockImplementationOnce(() =>
        mockQuery(
          createMockDrift({ type: 'ORPHAN_ACCOUNT', status: 'corrected', workflowId: 'c' }),
        ),
      );

      await expect(service.ignoreDrift('drift-1')).rejects.toThrow(ConflictException);
      expect(orphanCleanup.stop).not.toHaveBeenCalled();
    });

    it('stops no workflow for another drift type, or an orphan drift without a cleanup', async () => {
      mockDriftModel.findOne
        .mockImplementationOnce(() => mockQuery(createMockDrift({ workflowId: 'recon-1' })))
        .mockImplementationOnce(() =>
          mockQuery(createMockDrift({ type: 'ORPHAN_ACCOUNT', status: 'quarantined' })),
        );

      await service.ignoreDrift('drift-1');
      await service.ignoreDrift('drift-2');

      expect(orphanCleanup.stop).not.toHaveBeenCalled();
    });
  });

  describe('bulkAutoCorrect', () => {
    it('should correct multiple drifts and return count', async () => {
      const drifts = [createMockDrift(), createMockDrift({ _id: 'drift-2' })];
      mockDriftModel.find.mockReturnValueOnce({
        exec: jest.fn().mockResolvedValue(drifts),
      });

      mockDriftModel.updateMany.mockResolvedValueOnce({ modifiedCount: 2 });

      const result = await service.bulkAutoCorrect(['drift-1', 'drift-2']);

      expect(result).toEqual({ corrected: 2, failed: [] });
      expect(mockDriftCorrection.executeCorrection).toHaveBeenCalledTimes(2);
    });

    // 2.0dt: a failed correction was logged as "skipped drift <id>: undefined" and left out of
    // the answer, so the page showed "Auto-Fix applied to 0 drift(s)" as a success.
    it('reports each drift it could not correct with the reason single Correct gives', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const drifts = [createMockDrift(), createMockDrift({ _id: 'drift-2' })];
      mockDriftModel.find.mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(drifts) });
      mockDriftCorrection.executeCorrection
        .mockResolvedValueOnce({ success: true, skipConnector: false })
        .mockResolvedValueOnce({
          success: false,
          skipConnector: false,
          error: 'User not found: ada@example.com',
        });
      mockDriftModel.updateMany.mockResolvedValueOnce({ modifiedCount: 1 });

      const result = await service.bulkAutoCorrect(['drift-1', 'drift-2']);

      expect(result).toEqual({
        corrected: 1,
        failed: [{ driftId: 'drift-2', error: 'User not found: ada@example.com' }],
      });
      expect(mockDriftModel.updateMany).toHaveBeenCalledWith(
        { _id: { $in: ['drift-1'] }, tenantId: 'test-tenant' },
        expect.anything(),
      );
      // The log names the reason, with the email masked.
      expect(warn).toHaveBeenCalledWith(
        '[DriftService] Bulk correction failed for drift drift-2: User not found: a•••@example.com',
      );
      warn.mockRestore();
    });

    it('reports a drift that is not open, or not found, without correcting it', async () => {
      mockDriftModel.find.mockReturnValueOnce({
        exec: jest.fn().mockResolvedValue([createMockDrift({ status: 'corrected' })]),
      });

      const result = await service.bulkAutoCorrect(['drift-1', 'drift-9', 'drift-9']);

      expect(result).toEqual({
        corrected: 0,
        failed: [
          { driftId: 'drift-1', error: 'Drift drift-1 is corrected, not open' },
          { driftId: 'drift-9', error: 'Drift drift-9 not found' },
        ],
      });
      expect(mockDriftModel.find).toHaveBeenCalledWith({
        _id: { $in: ['drift-1', 'drift-9'] },
        tenantId: 'test-tenant',
      });
      expect(mockDriftCorrection.executeCorrection).not.toHaveBeenCalled();
      expect(mockDriftModel.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('bulkIgnore', () => {
    it('should return modified count', async () => {
      const result = await service.bulkIgnore(['drift-1', 'drift-2', 'drift-3']);

      expect(mockDriftModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: { $in: ['drift-1', 'drift-2', 'drift-3'] },
        }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: 'ignored' }),
        }),
      );
      expect(result).toBe(3);
    });
  });

  describe('updateDriftWorkflowId', () => {
    it('should update workflow id on drift', async () => {
      await service.updateDriftWorkflowId('drift-1', 'wf-123');

      expect(mockDriftModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'drift-1' }),
        expect.objectContaining({ $set: expect.objectContaining({ workflowId: 'wf-123' }) }),
        expect.any(Object),
      );
    });
  });

  describe('updateOrphanDrift', () => {
    it('should update drift with type ORPHAN_ACCOUNT', async () => {
      await service.updateOrphanDrift('drift-1', { status: 'corrected' });

      expect(mockDriftModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'drift-1', type: 'ORPHAN_ACCOUNT' }),
        expect.any(Object),
        expect.any(Object),
      );
    });
  });
});
