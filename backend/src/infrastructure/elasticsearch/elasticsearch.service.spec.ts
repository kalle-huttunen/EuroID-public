import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ElasticsearchService } from './elasticsearch.service';

describe('ElasticsearchService', () => {
  let service: ElasticsearchService;
  let mockConfigService: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn().mockReturnValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ElasticsearchService, { provide: ConfigService, useValue: mockConfigService }],
    }).compile();

    service = module.get(ElasticsearchService);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('fail-open mode', () => {
    it('returns false for healthCheck when client is null', async () => {
      expect(await service.healthCheck()).toBe(false);
    });

    it('returns false for isAvailable when not connected', () => {
      expect(service.isAvailable()).toBe(false);
    });

    it('returns empty hits for search when unavailable', async () => {
      const result = await service.search('test', { match_all: {} });
      expect(result).toEqual({ hits: [], total: 0 });
    });

    it('returns empty object for aggregate when unavailable', async () => {
      const result = await service.aggregate(
        'test',
        { match_all: {} },
        { count: { value_count: { field: '_id' } } },
      );
      expect(result).toEqual({});
    });

    it('returns 0 for count when unavailable', async () => {
      expect(await service.count('test')).toBe(0);
    });

    it('returns false for indexDocument when unavailable', async () => {
      expect(await service.indexDocument('test', '1', { foo: 'bar' })).toBe(false);
    });

    it('returns null for ensureIndex when unavailable', async () => {
      expect(await service.ensureIndex('test', { field: { type: 'keyword' } })).toBeNull();
    });

    it('returns null for flushBulkBuffer when unavailable', async () => {
      expect(await service.flushBulkBuffer()).toBeNull();
    });

    // A GDPR erasure must know when it did not reach the index
    it('throws for deleteByQuery when unavailable', async () => {
      await expect(service.deleteByQuery('test', { match_all: {} })).rejects.toThrow(
        'Elasticsearch is not connected',
      );
    });
  });

  describe('deleteByQuery', () => {
    it('flushes the bulk buffer and refreshes before it deletes, and answers the count', async () => {
      const calls: string[] = [];
      const client = {
        bulk: jest.fn(async () => {
          calls.push('bulk');
          return { errors: false, items: [] };
        }),
        indices: {
          refresh: jest.fn(async () => {
            calls.push('refresh');
          }),
        },
        deleteByQuery: jest.fn(async () => {
          calls.push('deleteByQuery');
          return { deleted: 3 };
        }),
      };
      (service as unknown as { client: unknown }).client = client;
      await service.bulkIndex('audit-events', 'e1', { resourceId: 'id-1' });
      const query = { term: { resourceId: 'id-1' } };

      expect(await service.deleteByQuery('audit-events', query)).toBe(3);

      expect(calls).toEqual(['bulk', 'refresh', 'deleteByQuery']);
      expect(client.deleteByQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'euroid-audit-events',
          query,
          conflicts: 'proceed',
          ignore_unavailable: true,
        }),
      );
      (service as unknown as { client: unknown }).client = null;
    });
  });

  describe('indexName', () => {
    it('prefixes index name with configured prefix', () => {
      expect(service.indexName('audit-events')).toBe('euroid-audit-events');
    });
  });

  describe('bulkIndex', () => {
    it('buffers items without flushing below threshold', async () => {
      await service.bulkIndex('test', '1', { data: 'value' });
      // Buffer should have 1 item; no flush since threshold not reached
      const result = await service.flushBulkBuffer();
      expect(result).toBeNull(); // null because client is null (fail-open)
    });
  });
});
