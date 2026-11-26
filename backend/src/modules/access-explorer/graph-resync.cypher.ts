/**
 * The Cypher of GraphResyncService. Every statement takes $tenantId and $runId; the merges set
 * the properties GraphSyncService sets from events, plus syncRunId, the prunes remove the
 * tenant's nodes and edges a run did not stamp, and the duplicate prunes all but one node of each
 * id (each answers how many as `removed`).
 */

/** $rows: { id, status, email, sourceSystem }. An identity without an email keeps the node's. */
export const IDENTITY_CYPHER = `
UNWIND $rows AS row
MERGE (i:Identity {id: row.id, tenantId: $tenantId})
ON CREATE SET i.createdAt = datetime()
ON MATCH SET i.updatedAt = datetime()
SET i.status = row.status,
    i.email = coalesce(row.email, i.email),
    i.sourceSystem = coalesce(row.sourceSystem, i.sourceSystem),
    i.syncRunId = $runId`;

export const CATALOG_CYPHER = {
  /** $systems: the catalog's systems. */
  applications: `
UNWIND $systems AS system
MERGE (a:Application {id: system, tenantId: $tenantId})
ON CREATE SET a.system = system, a.createdAt = datetime()
ON MATCH SET a.updatedAt = datetime()
SET a.syncRunId = $runId`,
  /** $rows: { id (entitlementNodeId: system::native id), nativeId, name, type, system }. */
  entitlements: `
UNWIND $rows AS row
MERGE (e:Entitlement {id: row.id, tenantId: $tenantId})
ON CREATE SET e.createdAt = datetime()
ON MATCH SET e.updatedAt = datetime()
SET e.name = row.name,
    e.nativeId = row.nativeId,
    e.entitlementType = row.type,
    e.system = row.system,
    e.syncRunId = $runId
WITH e, row
MATCH (a:Application {id: row.system, tenantId: $tenantId})
MERGE (e)-[r:BELONGS_TO]->(a)
SET r.syncRunId = $runId`,
};

/**
 * $rows: { identityId, targetId (entitlementNodeId), nativeId, type, connector, grantedBy,
 * source }. The identity must be one the run merged; an entitlement the catalog does not have is
 * created as provisioning creates it.
 */
export const GRANT_CYPHER = `
UNWIND $rows AS row
MATCH (i:Identity {id: row.identityId, tenantId: $tenantId})
MERGE (e:Entitlement {id: row.targetId, tenantId: $tenantId})
ON CREATE SET e.entitlementType = row.type, e.system = row.connector, e.nativeId = row.nativeId
SET e.syncRunId = $runId
MERGE (i)-[r:HAS_ACCESS]->(e)
ON CREATE SET r.grantedAt = datetime(), r.connector = row.connector
ON MATCH SET r.updatedAt = datetime()
SET r.grantedBy = row.grantedBy,
    r.source = row.source,
    r.syncRunId = $runId`;

const unstamped = (name: string) =>
  `WHERE ${name}.syncRunId IS NULL OR ${name}.syncRunId <> $runId`;

/**
 * The tenant's nodes of a label that share an id with another, written before the uniqueness
 * constraint existed (infrastructure/graph/graph-constraints.ts): each MERGE of the run matched
 * all of them, so each carries the run's stamp and edges. One of each id stays; the others go.
 */
const duplicates = (label: string) => `
MATCH (n:${label} {tenantId: $tenantId})
WITH n.id AS id, collect(n) AS nodes
WHERE size(nodes) > 1
UNWIND tail(nodes) AS duplicate
DETACH DELETE duplicate
RETURN count(duplicate) AS removed`;

export const DUPLICATE_CYPHER = {
  identities: duplicates('Identity'),
  entitlements: duplicates('Entitlement'),
  applications: duplicates('Application'),
};

export const PRUNE_CYPHER = {
  hasAccess: `
MATCH (:Identity {tenantId: $tenantId})-[r:HAS_ACCESS]->(:Entitlement {tenantId: $tenantId})
${unstamped('r')}
DELETE r
RETURN count(r) AS removed`,
  belongsTo: `
MATCH (:Entitlement {tenantId: $tenantId})-[r:BELONGS_TO]->(:Application {tenantId: $tenantId})
${unstamped('r')}
DELETE r
RETURN count(r) AS removed`,
  identities: `
MATCH (i:Identity {tenantId: $tenantId})
${unstamped('i')}
DETACH DELETE i
RETURN count(i) AS removed`,
  entitlements: `
MATCH (e:Entitlement {tenantId: $tenantId})
${unstamped('e')}
DETACH DELETE e
RETURN count(e) AS removed`,
  applications: `
MATCH (a:Application {tenantId: $tenantId})
${unstamped('a')}
DETACH DELETE a
RETURN count(a) AS removed`,
};
