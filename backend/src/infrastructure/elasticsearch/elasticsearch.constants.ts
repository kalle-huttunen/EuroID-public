/**
 * Elasticsearch Index Definitions & Mappings
 *
 * Central registry of all ES index suffixes and their field mappings.
 */

/** Index suffixes (prefixed with ELASTICSEARCH_INDEX_PREFIX at runtime). */
export const ES_INDEX = {
  AUDIT_EVENTS: 'audit-events',
  ANALYTICS_FORECASTS: 'analytics-forecasts',
} as const;

/** Field mappings for the audit-events index. */
export const AUDIT_EVENTS_MAPPINGS: Record<string, unknown> = {
  tenantId: { type: 'keyword' },
  action: { type: 'keyword' },
  actor: { type: 'keyword' },
  resourceType: { type: 'keyword' },
  resourceId: { type: 'keyword' },
  resourceName: { type: 'text', fields: { keyword: { type: 'keyword' } } },
  targetSystem: { type: 'keyword' },
  description: { type: 'text' },
  timestamp: { type: 'date' },
  severity: { type: 'keyword' },
  outcome: { type: 'keyword' },
  correlationId: { type: 'keyword' },
  payload: { type: 'object', enabled: false },
};

/** Field mappings for the analytics-forecasts index. */
export const ANALYTICS_FORECASTS_MAPPINGS: Record<string, unknown> = {
  tenantId: { type: 'keyword' },
  type: { type: 'keyword' },
  system: { type: 'keyword' },
  license: { type: 'keyword' },
  month: { type: 'integer' },
  year: { type: 'integer' },
  count: { type: 'integer' },
  trend: { type: 'keyword' },
  computedAt: { type: 'date' },
};
