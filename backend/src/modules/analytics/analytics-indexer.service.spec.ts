import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { AnalyticsIndexerService } from './analytics-indexer.service';
import { ElasticsearchService } from '@infrastructure/elasticsearch/elasticsearch.service';
import { AuditEvent } from '../audit/schemas/audit-event.schema';

// Mock requestContext
jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: () => ({ tenantId: 'test-tenant' }),
}));

describe('AnalyticsIndexerService', () => {
  let service: AnalyticsIndexerService;
  let mockEsService: Record<string, jest.Mock>;
  let mockAuditModel: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockEsService = {
      isAvailable: jest.fn().mockReturnValue(true),
      ensureIndex: jest.fn().mockResolvedValue(null),
      indexDocument: jest.fn().mockResolvedValue(true),
      bulkIndex: jest.fn().mockResolvedValue(undefined),
      flushBulkBuffer: jest.fn().mockResolvedValue(null),
    };

    mockAuditModel = {
      // The batch's identities a GDPR erasure covers: none unless a test says so
      distinct: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsIndexerService,
        { provide: ElasticsearchService, useValue: mockEsService },
        { provide: getModelToken(AuditEvent.name), useValue: mockAuditModel },
      ],
    }).compile();

    service = module.get(AnalyticsIndexerService);
  });

  describe('ensureIndices', () => {
    it('creates audit events index when ES is available', async () => {
      await service.ensureIndices();
      expect(mockEsService.ensureIndex).toHaveBeenCalledWith(
        'audit-events',
        expect.objectContaining({ tenantId: { type: 'keyword' } }),
      );
    });

    it('skips index creation when ES is unavailable', async () => {
      mockEsService.isAvailable.mockReturnValue(false);
      await service.ensureIndices();
      expect(mockEsService.ensureIndex).not.toHaveBeenCalled();
    });
  });

  describe('indexAuditEvent', () => {
    it('indexes a single audit event', async () => {
      const event = {
        _id: 'evt-1',
        tenantId: 'test-tenant',
        action: 'identity.created',
        actor: 'admin',
        timestamp: new Date().toISOString(),
      };

      const result = await service.indexAuditEvent(event);
      expect(result).toBe(true);
      expect(mockEsService.indexDocument).toHaveBeenCalledWith(
        'audit-events',
        'evt-1',
        expect.objectContaining({ action: 'identity.created' }),
      );
    });

    it('returns false when ES is unavailable', async () => {
      mockEsService.isAvailable.mockReturnValue(false);
      const result = await service.indexAuditEvent({ _id: '1' });
      expect(result).toBe(false);
    });
  });

  describe('backfillFromMongo', () => {
    it('indexes audit events from MongoDB in batches', async () => {
      const docs = [
        {
          _id: 'a1',
          eventId: 'evt-1',
          tenantId: 'test-tenant',
          action: 'identity.created',
          timestamp: new Date(),
        },
        { _id: 'a2', tenantId: 'test-tenant', action: 'identity.updated', timestamp: new Date() },
      ];

      mockAuditModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest
            .fn()
            .mockReturnValueOnce({
              limit: jest.fn().mockReturnValue({
                lean: jest.fn().mockReturnValue({
                  exec: jest.fn().mockResolvedValue(docs),
                }),
              }),
            })
            .mockReturnValueOnce({
              limit: jest.fn().mockReturnValue({
                lean: jest.fn().mockReturnValue({
                  exec: jest.fn().mockResolvedValue([]),
                }),
              }),
            }),
        }),
      });

      const result = await service.backfillFromMongo(500);
      expect(result.indexed).toBe(2);
      // An audit entry of a domain event goes under the event's id, as live indexing puts it
      expect(mockEsService.bulkIndex.mock.calls.map((call: unknown[]) => call[1])).toEqual([
        'evt-1',
        'a2',
      ]);
      expect(mockEsService.bulkIndex).toHaveBeenCalledTimes(2);
      expect(mockEsService.flushBulkBuffer).toHaveBeenCalled();
    });

    // HX-F report (section 6): a backfill must not bring an erased person back. A batch read
    // just before an erasure deleted the person's entries still holds them; the erasure entry,
    // written before that delete, marks them.
    it('leaves out the entries of an identity a GDPR erasure covers, but its erasure entry', async () => {
      const docs = [
        { _id: 'a1', tenantId: 'test-tenant', action: 'identity.updated', resourceId: 'gone' },
        {
          _id: 'a2',
          tenantId: 'test-tenant',
          action: 'GDPR_ERASURE_EXECUTED',
          resourceId: 'gone',
        },
        { _id: 'a3', tenantId: 'test-tenant', action: 'identity.updated', resourceId: 'here' },
      ];
      const page = (rows: unknown[]) => ({
        limit: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(rows) }),
        }),
      });
      mockAuditModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValueOnce(page(docs)).mockReturnValueOnce(page([])),
        }),
      });
      mockAuditModel.distinct.mockReturnValue({ exec: jest.fn().mockResolvedValue(['gone']) });

      const result = await service.backfillFromMongo(500);

      expect(mockEsService.bulkIndex.mock.calls.map((call: unknown[]) => call[1])).toEqual([
        'a2',
        'a3',
      ]);
      expect(result.indexed).toBe(2);
      expect(mockAuditModel.distinct).toHaveBeenCalledWith('resourceId', {
        tenantId: 'test-tenant',
        action: 'GDPR_ERASURE_EXECUTED',
        'payload.metadata.dryRun': { $ne: true },
        resourceId: { $in: ['gone', 'here'] },
      });
    });

    it('returns zero counts when ES is unavailable', async () => {
      mockEsService.isAvailable.mockReturnValue(false);
      const result = await service.backfillFromMongo();
      expect(result).toEqual({ indexed: 0, errors: 0 });
    });
  });

  describe('domain event listeners', () => {
    // The document id was the request's correlationId, so every event of one request (an HR
    // sync's 500 identity.created) overwrote the one before (hunt 05 F14): the event's own id
    it('indexes each event under its own id, not the request correlation id', async () => {
      await service.onIdentityCreated({
        eventId: 'evt-1',
        type: 'IDENTITY_CREATED',
        aggregateId: 'id-123',
        payload: { name: 'John' },
        metadata: { tenantId: 'test-tenant', correlationId: 'corr-1' },
      } as any);
      await service.onProvisioningCompleted({
        eventId: 'evt-2',
        type: 'PROVISIONING_COMPLETED',
        aggregateId: 'id-123',
        payload: {},
        metadata: { tenantId: 'test-tenant', correlationId: 'corr-1' },
      } as any);

      expect(mockEsService.bulkIndex.mock.calls.map((call: unknown[]) => call[1])).toEqual([
        'evt-1',
        'evt-2',
      ]);
      expect(mockEsService.bulkIndex).toHaveBeenCalledWith(
        'audit-events',
        'evt-1',
        expect.objectContaining({
          action: 'identity.created',
          resourceId: 'id-123',
          tenantId: 'test-tenant',
        }),
      );
    });

    it('skips indexing when ES is unavailable', async () => {
      mockEsService.isAvailable.mockReturnValue(false);
      await service.onIdentityUpdated({
        type: 'IDENTITY_UPDATED',
        aggregateId: 'id-123',
        payload: {},
        metadata: {},
      } as any);

      expect(mockEsService.bulkIndex).not.toHaveBeenCalled();
    });
  });
});
