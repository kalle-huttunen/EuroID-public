import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsSearchService } from './analytics-search.service';
import { ElasticsearchService } from '@infrastructure/elasticsearch/elasticsearch.service';

// Mock requestContext
jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: () => ({ tenantId: 'test-tenant' }),
}));

describe('AnalyticsSearchService', () => {
  let service: AnalyticsSearchService;
  let mockEsService: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockEsService = {
      isAvailable: jest.fn().mockReturnValue(true),
      search: jest.fn().mockResolvedValue({ hits: [], total: 0 }),
      aggregate: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsSearchService,
        { provide: ElasticsearchService, useValue: mockEsService },
      ],
    }).compile();

    service = module.get(AnalyticsSearchService);
  });

  describe('isAvailable', () => {
    it('returns true when ES is connected', () => {
      expect(service.isAvailable()).toBe(true);
    });

    it('returns false when ES is disconnected', () => {
      mockEsService.isAvailable.mockReturnValue(false);
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('searchAuditEvents', () => {
    it('returns empty results when ES is unavailable', async () => {
      mockEsService.isAvailable.mockReturnValue(false);
      const result = await service.searchAuditEvents({ text: 'test' });
      expect(result).toEqual({ hits: [], total: 0 });
      expect(mockEsService.search).not.toHaveBeenCalled();
    });

    it('builds bool query with text and filters', async () => {
      mockEsService.search.mockResolvedValue({
        hits: [{ _id: '1', action: 'identity.created', actor: 'admin' }],
        total: 1,
      });

      const result = await service.searchAuditEvents({
        text: 'john',
        action: 'identity.created',
        actor: 'admin@test.com',
        page: 0,
        pageSize: 10,
      });

      expect(result.total).toBe(1);
      expect(mockEsService.search).toHaveBeenCalledWith(
        'audit-events',
        expect.objectContaining({
          bool: expect.objectContaining({
            must: expect.arrayContaining([
              { term: { tenantId: 'test-tenant' } },
              expect.objectContaining({ multi_match: expect.any(Object) }),
              { term: { action: 'identity.created' } },
              { term: { actor: 'admin@test.com' } },
            ]),
          }),
        }),
        expect.objectContaining({ size: 10, from: 0 }),
      );
    });

    it('includes date range filter when from/to are provided', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-03-31');

      await service.searchAuditEvents({ from, to });

      const callArgs = mockEsService.search.mock.calls[0];
      const must = callArgs[1].bool.must;
      const rangeFilter = must.find((m: Record<string, unknown>) => 'range' in m);
      expect(rangeFilter).toBeDefined();
      expect(rangeFilter.range.timestamp.gte).toBe(from.toISOString());
      expect(rangeFilter.range.timestamp.lte).toBe(to.toISOString());
    });
  });

  describe('detectSeasonalPatternsES', () => {
    it('returns empty array when ES is unavailable', async () => {
      mockEsService.isAvailable.mockReturnValue(false);
      const result = await service.detectSeasonalPatternsES();
      expect(result).toEqual([]);
    });

    it('processes date_histogram buckets into seasonal patterns', async () => {
      mockEsService.aggregate.mockResolvedValue({
        monthly_onboardings: {
          buckets: [
            { key_as_string: '2025-01-01T00:00:00.000Z', doc_count: 5 },
            { key_as_string: '2025-06-01T00:00:00.000Z', doc_count: 30 },
            { key_as_string: '2025-07-01T00:00:00.000Z', doc_count: 3 },
          ],
        },
      });

      const results = await service.detectSeasonalPatternsES();

      expect(results).toHaveLength(3);
      // avg = (5+30+3)/3 = 12.67, threshold = 25.33
      const june = results.find((r) => r.month === 6);
      expect(june?.isAnomalous).toBe(true);
      expect(june?.label).toBe('Intern wave');
      expect(june?.peakOnboardings).toBe(30);

      const jan = results.find((r) => r.month === 1);
      expect(jan?.label).toBe('Fiscal year start');
      expect(jan?.isAnomalous).toBe(false);
    });

    it('returns empty when aggregation returns no buckets', async () => {
      mockEsService.aggregate.mockResolvedValue({
        monthly_onboardings: { buckets: [] },
      });

      const results = await service.detectSeasonalPatternsES();
      expect(results).toEqual([]);
    });
  });

  describe('getIndexedEventCount', () => {
    // The index holds every tenant's audit events: the count was of all of them.
    it("returns count from ES: the request tenant's indexed audit events only", async () => {
      mockEsService.count.mockResolvedValue(42);
      expect(await service.getIndexedEventCount()).toBe(42);
      expect(mockEsService.count).toHaveBeenCalledWith('audit-events', {
        term: { tenantId: 'test-tenant' },
      });
    });
  });
});
