/**
 * Analytics Search Service (ES-backed v2)
 *
 * Provides Elasticsearch-powered analytics queries using aggregations
 * for seasonal pattern detection, and full-text audit event search.
 * Falls back to MongoDB (v1) when ES is unavailable.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ElasticsearchService } from '@infrastructure/elasticsearch/elasticsearch.service';
import { ES_INDEX } from '@infrastructure/elasticsearch/elasticsearch.constants';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import type { SeasonalPatternResult } from './analytics.service';

export interface AuditSearchResult {
  hits: Array<{
    _id: string;
    action: string;
    actor: string;
    resourceType: string;
    resourceId: string;
    resourceName?: string;
    targetSystem?: string;
    description?: string;
    timestamp: string;
    severity?: string;
    outcome?: string;
  }>;
  total: number;
}

export interface AuditSearchQuery {
  text?: string;
  action?: string;
  actor?: string;
  targetSystem?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

const SEASONAL_LABELS: Record<string, string> = {
  '1': 'Fiscal year start',
  '6': 'Intern wave',
  '7': 'Intern wave',
  '9': 'Back to school',
};

@Injectable()
export class AnalyticsSearchService {
  private readonly logger = new Logger(AnalyticsSearchService.name);

  constructor(private readonly esService: ElasticsearchService) {}

  /** Whether ES-backed analytics is available. */
  isAvailable(): boolean {
    return this.esService.isAvailable();
  }

  /**
   * Full-text search across audit events with filters.
   * Only available when ES is connected.
   */
  async searchAuditEvents(query: AuditSearchQuery): Promise<AuditSearchResult> {
    if (!this.esService.isAvailable()) {
      return { hits: [], total: 0 };
    }

    const tenantId = getRequestContext()?.tenantId || 'default';
    const must: Record<string, unknown>[] = [{ term: { tenantId } }];

    if (query.text) {
      must.push({
        multi_match: {
          query: query.text,
          fields: ['description', 'resourceName', 'actor'],
          fuzziness: 'AUTO',
        },
      });
    }
    if (query.action) must.push({ term: { action: query.action } });
    if (query.actor) must.push({ term: { actor: query.actor } });
    if (query.targetSystem) must.push({ term: { targetSystem: query.targetSystem } });

    if (query.from || query.to) {
      const range: Record<string, unknown> = {};
      if (query.from) range.gte = query.from.toISOString();
      if (query.to) range.lte = query.to.toISOString();
      must.push({ range: { timestamp: range } });
    }

    const pageSize = query.pageSize ?? 50;
    const page = query.page ?? 0;

    return this.esService.search(
      ES_INDEX.AUDIT_EVENTS,
      { bool: { must } },
      {
        size: pageSize,
        from: page * pageSize,
        sort: [{ timestamp: { order: 'desc' } }] as unknown as Record<string, unknown>[],
      },
    );
  }

  /**
   * ES-backed seasonal pattern detection using date_histogram aggregation.
   * Falls back gracefully (returns empty array) when ES is unavailable.
   */
  async detectSeasonalPatternsES(): Promise<SeasonalPatternResult[]> {
    if (!this.esService.isAvailable()) return [];

    const tenantId = getRequestContext()?.tenantId || 'default';
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 12);

    const aggs = {
      monthly_onboardings: {
        date_histogram: {
          field: 'timestamp',
          calendar_interval: 'month',
          min_doc_count: 0,
        },
      },
    };

    const query = {
      bool: {
        must: [
          { term: { tenantId } },
          { term: { action: 'identity.created' } },
          { range: { timestamp: { gte: cutoff.toISOString() } } },
        ],
      },
    };

    const result = await this.esService.aggregate(ES_INDEX.AUDIT_EVENTS, query, aggs);
    const buckets =
      (
        result.monthly_onboardings as {
          buckets?: Array<{ key_as_string: string; doc_count: number }>;
        }
      )?.buckets ?? [];

    if (buckets.length === 0) return [];

    const avg = buckets.reduce((s, b) => s + b.doc_count, 0) / buckets.length;
    const threshold = avg * 2;

    return buckets.map((bucket) => {
      const date = new Date(bucket.key_as_string);
      const month = date.getMonth() + 1;
      const year = date.getFullYear();
      return {
        month,
        year,
        averageOnboardings: Math.round(avg),
        peakOnboardings: bucket.doc_count,
        isAnomalous: bucket.doc_count >= threshold,
        label: SEASONAL_LABELS[String(month)],
      };
    });
  }

  /** The request tenant's audit events indexed in ES (the index holds every tenant's). */
  async getIndexedEventCount(): Promise<number> {
    const tenantId = getRequestContext()?.tenantId || 'default';
    return this.esService.count(ES_INDEX.AUDIT_EVENTS, { term: { tenantId } });
  }
}
