/**
 * Elasticsearch Service — Connection Manager & Query Executor
 *
 * Manages the ES client lifecycle, index templates, bulk operations,
 * and search queries. Fail-open pattern: returns empty results when
 * Elasticsearch is unavailable.
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@elastic/elasticsearch';
import type {
  SearchResponse,
  BulkResponse,
  IndicesCreateResponse,
} from '@elastic/elasticsearch/lib/api/types';

export interface EsBulkItem {
  index: string;
  id?: string;
  body: Record<string, unknown>;
}

@Injectable()
export class ElasticsearchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ElasticsearchService.name);
  private client: Client | null = null;

  private readonly node: string;
  private readonly username: string;
  private readonly password: string;
  private readonly indexPrefix: string;
  private readonly maxRetries: number;
  private readonly requestTimeout: number;

  private bulkBuffer: EsBulkItem[] = [];
  private readonly bulkFlushIntervalMs: number;
  private readonly bulkFlushSize: number;
  private flushTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly configService: ConfigService) {
    this.node =
      this.configService.get<string>('elasticsearch.ELASTICSEARCH_NODE') ?? 'http://localhost:9200';
    this.username = this.configService.get<string>('elasticsearch.ELASTICSEARCH_USERNAME') ?? '';
    this.password = this.configService.get<string>('elasticsearch.ELASTICSEARCH_PASSWORD') ?? '';
    this.indexPrefix =
      this.configService.get<string>('elasticsearch.ELASTICSEARCH_INDEX_PREFIX') ?? 'euroid';
    this.maxRetries =
      this.configService.get<number>('elasticsearch.ELASTICSEARCH_MAX_RETRIES') ?? 3;
    this.requestTimeout =
      this.configService.get<number>('elasticsearch.ELASTICSEARCH_REQUEST_TIMEOUT_MS') ?? 30000;
    this.bulkFlushIntervalMs =
      this.configService.get<number>('elasticsearch.ELASTICSEARCH_BULK_FLUSH_INTERVAL_MS') ?? 5000;
    this.bulkFlushSize =
      this.configService.get<number>('elasticsearch.ELASTICSEARCH_BULK_FLUSH_SIZE') ?? 500;
  }

  async onModuleInit(): Promise<void> {
    try {
      const auth = this.username ? { username: this.username, password: this.password } : undefined;
      this.client = new Client({
        node: this.node,
        auth,
        maxRetries: this.maxRetries,
        requestTimeout: this.requestTimeout,
      });

      const info = await this.client.info();
      this.logger.log(`Connected to Elasticsearch ${info.version.number} at ${this.node}`);

      this.flushTimer = setInterval(() => this.flushBulkBuffer(), this.bulkFlushIntervalMs);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to connect to Elasticsearch at ${this.node}: ${message}. Operating in fail-open mode.`,
      );
      this.client = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flushBulkBuffer();
    if (this.client) {
      await this.client.close();
      this.logger.log('Elasticsearch client closed');
    }
  }

  /** Check if Elasticsearch is available. */
  async healthCheck(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const result = await this.client.cluster.health();
      return result.status === 'green' || result.status === 'yellow';
    } catch {
      return false;
    }
  }

  /** Whether the client is connected. */
  isAvailable(): boolean {
    return this.client !== null;
  }

  /** Get prefixed index name. */
  indexName(suffix: string): string {
    return `${this.indexPrefix}-${suffix}`;
  }

  /** Create an index with mappings if it does not exist. */
  async ensureIndex(
    suffix: string,
    mappings: Record<string, unknown>,
    settings?: Record<string, unknown>,
  ): Promise<IndicesCreateResponse | null> {
    if (!this.client) return null;
    const index = this.indexName(suffix);

    try {
      const exists = await this.client.indices.exists({ index });
      if (exists) return null;

      const result = await this.client.indices.create({
        index,
        body: {
          settings: settings ?? {
            number_of_shards: 1,
            number_of_replicas: 0,
            refresh_interval: '5s',
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ES client types are overly strict for dynamic mappings
          mappings: { properties: mappings as any },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- body type mismatch between typed and untyped ES client APIs
      } as any);
      this.logger.log(`Created index: ${index}`);
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to create index ${index}: ${message}`);
      return null;
    }
  }

  /** Index a single document. */
  async indexDocument(suffix: string, id: string, body: Record<string, unknown>): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.index({
        index: this.indexName(suffix),
        id,
        body,
        refresh: false,
      });
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to index document: ${message}`);
      return false;
    }
  }

  /** Add a document to the bulk buffer. Flushes when buffer reaches bulkFlushSize. */
  async bulkIndex(suffix: string, id: string, body: Record<string, unknown>): Promise<void> {
    this.bulkBuffer.push({ index: this.indexName(suffix), id, body });
    if (this.bulkBuffer.length >= this.bulkFlushSize) {
      await this.flushBulkBuffer();
    }
  }

  /** Flush the bulk buffer to Elasticsearch. */
  async flushBulkBuffer(): Promise<BulkResponse | null> {
    if (!this.client || this.bulkBuffer.length === 0) return null;

    const items = [...this.bulkBuffer];
    this.bulkBuffer = [];

    try {
      const body = items.flatMap((item) => [
        { index: { _index: item.index, ...(item.id && { _id: item.id }) } },
        item.body,
      ]);

      const result = await this.client.bulk({ body, refresh: false });

      if (result.errors) {
        const failed = result.items.filter((i) => i.index?.error);
        this.logger.warn(`Bulk index: ${failed.length}/${items.length} failed`);
      } else {
        this.logger.debug(`Bulk indexed ${items.length} documents`);
      }
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Bulk index failed: ${message}`);
      return null;
    }
  }

  /** Execute a search query. Returns empty hits if unavailable. */
  async search<T = Record<string, unknown>>(
    suffix: string,
    query: Record<string, unknown>,
    options?: { size?: number; from?: number; sort?: Record<string, unknown>[] },
  ): Promise<{ hits: Array<T & { _id: string }>; total: number }> {
    if (!this.client) return { hits: [], total: 0 };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ES client types are overly strict for dynamic query bodies
      const searchParams: any = {
        index: this.indexName(suffix),
        body: {
          query,
          size: options?.size ?? 100,
          from: options?.from ?? 0,
          ...(options?.sort && { sort: options.sort }),
        },
      };
      const result: SearchResponse = await this.client.search(searchParams);

      const total =
        typeof result.hits.total === 'number' ? result.hits.total : (result.hits.total?.value ?? 0);

      const hits = result.hits.hits.map((hit) => ({
        _id: hit._id!,
        ...(hit._source as T),
      }));

      return { hits, total };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Search failed on ${suffix}: ${message}`);
      return { hits: [], total: 0 };
    }
  }

  /** Execute an aggregation query. Returns empty result if unavailable. */
  async aggregate(
    suffix: string,
    query: Record<string, unknown>,
    aggs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.client) return {};

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ES client types are overly strict for dynamic aggregation bodies
      const aggParams: any = { index: this.indexName(suffix), body: { query, aggs, size: 0 } };
      const result = await this.client.search(aggParams);
      return (result.aggregations ?? {}) as Record<string, unknown>;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Aggregation failed on ${suffix}: ${message}`);
      return {};
    }
  }

  /**
   * Delete the documents of an index the query matches, and answer how many. The bulk buffer is
   * flushed and the index refreshed first, so a document indexed a moment ago is matched too (a
   * delete by query sees what was searchable when it started). An index that does not exist
   * deletes nothing. Unlike the other calls it is not fail-open: it throws when Elasticsearch is
   * not connected or the call fails, so a caller that must delete (GDPR erasure) can tell.
   */
  async deleteByQuery(suffix: string, query: Record<string, unknown>): Promise<number> {
    if (!this.client) throw new Error('Elasticsearch is not connected');
    await this.flushBulkBuffer();
    const index = this.indexName(suffix);
    const missingOk = { ignore_unavailable: true, allow_no_indices: true };
    await this.client.indices.refresh({ index, ...missingOk });
    const result = await this.client.deleteByQuery({
      index,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ES client types are overly strict for dynamic query bodies
      query: query as any,
      conflicts: 'proceed',
      refresh: true,
      ...missingOk,
    });
    return result.deleted ?? 0;
  }

  /** Get document count for an index. */
  async count(suffix: string, query?: Record<string, unknown>): Promise<number> {
    if (!this.client) return 0;
    try {
      const result = await this.client.count({
        index: this.indexName(suffix),
        body: query ? { query } : undefined,
      });
      return result.count;
    } catch {
      return 0;
    }
  }
}
