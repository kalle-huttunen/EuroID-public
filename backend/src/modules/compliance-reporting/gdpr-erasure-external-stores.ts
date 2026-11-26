/**
 * The stores outside MongoDB that a GDPR erasure reaches: the access graph (Neo4j) and the
 * Elasticsearch audit index. Both are read models built from MongoDB.
 *
 * - access_graph: the person's Identity node (with their email) and its edges, deleted with
 *   DETACH DELETE. Not configured (no NEO4J_PASSWORD): nothing to erase.
 * - elasticsearch_audit_events: the index's documents filed under the person (resourceId), the
 *   same set the erasure deletes from audit_events: its GDPR_ERASURE_EXECUTED entries stay in both,
 *   so a backfill from MongoDB brings back nothing it erased. The bulk buffer is flushed and the
 *   index refreshed first, so a document indexed a moment ago is deleted too.
 *
 * A store the API cannot reach (Neo4j configured but not connected, no Elasticsearch connection,
 * or the call fails) is named in `notReached`, and the rest of the erasure goes on: a graph resync
 * prunes the node of an identity MongoDB no longer has, and an index rebuilt from MongoDB holds
 * none of the person's erased entries.
 */
import { Injectable, Logger } from '@nestjs/common';
import { GraphService } from '@infrastructure/graph/graph.service';
import { ElasticsearchService } from '@infrastructure/elasticsearch/elasticsearch.service';
import { ES_INDEX } from '@infrastructure/elasticsearch/elasticsearch.constants';

export const ACCESS_GRAPH = 'access_graph';
export const ES_AUDIT_EVENTS = 'elasticsearch_audit_events';

export interface ExternalStoresResult {
  counts: Record<string, number>;
  notReached: string[];
}

const COUNT_NODE = 'MATCH (i:Identity {id: $id, tenantId: $tenantId}) RETURN count(i) AS n';
const DELETE_NODE =
  'MATCH (i:Identity {id: $id, tenantId: $tenantId}) DETACH DELETE i RETURN count(i) AS n';

/** The index's documents filed under the person, but the erasure entries (kept as in MongoDB). */
const subjectDocuments = (tenantId: string, identityId: string) => ({
  bool: {
    filter: [{ term: { tenantId } }, { term: { resourceId: identityId } }],
    must_not: [{ term: { action: 'GDPR_ERASURE_EXECUTED' } }],
  },
});

/** A count from Neo4j: a neo4j Integer, or a number in tests. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const int = value as { toNumber?: () => number } | undefined;
  return int?.toNumber ? int.toNumber() : 0;
}

@Injectable()
export class GdprExternalStores {
  private readonly logger = new Logger(GdprExternalStores.name);

  constructor(
    private readonly graphService: GraphService,
    private readonly esService: ElasticsearchService,
  ) {}

  /** What erase() would delete; changes nothing. */
  async count(tenantId: string, identityId: string): Promise<ExternalStoresResult> {
    return this.each(tenantId, identityId, {
      graph: async (params) => (await this.graphService.readStrict(COUNT_NODE, params)).records,
      es: (query) => this.esService.count(ES_INDEX.AUDIT_EVENTS, query),
    });
  }

  async erase(tenantId: string, identityId: string): Promise<ExternalStoresResult> {
    return this.each(tenantId, identityId, {
      graph: async (params) => (await this.graphService.writeStrict(DELETE_NODE, params)).records,
      es: (query) => this.esService.deleteByQuery(ES_INDEX.AUDIT_EVENTS, query),
    });
  }

  private async each(
    tenantId: string,
    identityId: string,
    run: {
      graph: (params: Record<string, string>) => Promise<Array<{ get(key: string): unknown }>>;
      es: (query: Record<string, unknown>) => Promise<number>;
    },
  ): Promise<ExternalStoresResult> {
    const counts: Record<string, number> = { [ACCESS_GRAPH]: 0, [ES_AUDIT_EVENTS]: 0 };
    const notReached: string[] = [];
    const reach = async (store: string, call: () => Promise<number>) => {
      try {
        counts[store] = await call();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`GDPR erasure could not reach ${store} for ${identityId}: ${message}`);
        notReached.push(store);
      }
    };

    const graphState = this.graphService.connectionState();
    if (graphState === 'not-connected') notReached.push(ACCESS_GRAPH);
    if (graphState === 'ok') {
      await reach(ACCESS_GRAPH, async () => {
        const records = await run.graph({ id: identityId, tenantId });
        return toNumber(records[0]?.get('n'));
      });
    }

    if (!this.esService.isAvailable()) notReached.push(ES_AUDIT_EVENTS);
    else await reach(ES_AUDIT_EVENTS, () => run.es(subjectDocuments(tenantId, identityId)));

    return { counts, notReached };
  }
}
