/**
 * The access graph's node constraints. GraphSyncService and GraphResyncService MERGE Identity,
 * Entitlement and Application nodes on (id, tenantId). A uniqueness constraint on those two
 * properties per label gives each MERGE an index to find its node by (without one every MERGE
 * scans all nodes of the label) and keeps two MERGEs at once from creating the same node twice.
 * Neo4j 5 Community has property uniqueness constraints, on two properties too; a node key
 * constraint would need Enterprise, and a plain range index would not stop the duplicates.
 *
 * GraphService creates them, each IF NOT EXISTS, when it connects and after a graph resync.
 */
import neo4j, { type Driver, type Session } from 'neo4j-driver';

export const GRAPH_NODE_LABELS = ['Identity', 'Entitlement', 'Application'] as const;

/** The statement that creates the label's constraint, a no-op when it exists. */
export const nodeConstraintCypher = (label: (typeof GRAPH_NODE_LABELS)[number]): string =>
  `CREATE CONSTRAINT ${label.toLowerCase()}_tenant_id_unique IF NOT EXISTS ` +
  `FOR (n:${label}) REQUIRE (n.tenantId, n.id) IS UNIQUE`;

/** What an admin does when a constraint cannot be created because the graph holds duplicates. */
export const DUPLICATES_HINT =
  'Two or more nodes with this label, tenantId and id were written before the constraint ' +
  'existed (the Neo4j message names one of them). A super-admin resyncs that tenant with ' +
  'POST /api/v1/access-explorer/resync: it removes the duplicates and creates the constraint. ' +
  'Until then MERGEs on this label scan the label and can write more duplicates.';

/**
 * Creates each label's constraint if it is not there. One that fails is logged with the cause
 * and DUPLICATES_HINT, and the others are still created: the graph stays in use without it.
 * Never rejects (GraphService runs it inside a connection attempt, which never rejects).
 */
export async function ensureNodeConstraints(
  driver: Driver,
  logger: { warn: (message: string) => void },
): Promise<void> {
  for (const label of GRAPH_NODE_LABELS) {
    let session: Session | undefined;
    try {
      session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
      await session.run(nodeConstraintCypher(label));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Could not create the uniqueness constraint on (:${label}) tenantId and id: ` +
          `${message}. ${DUPLICATES_HINT}`,
      );
    }
    try {
      await session?.close();
    } catch {
      // Nothing to do: the session is gone either way
    }
  }
}
