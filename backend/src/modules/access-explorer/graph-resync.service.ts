/**
 * Graph Resync Service
 *
 * Loads one tenant's current state from MongoDB into Neo4j with the node and relationship mapping
 * GraphSyncService writes from events, so a graph connected after the fact (or one that missed
 * events) answers what MongoDB holds. Run by POST /access-explorer/resync (super-admin), like
 * the analytics backfill into Elasticsearch.
 *
 * - (:Identity {id: _id, tenantId}): every identity not soft-deleted (status, email, source).
 * - (:Entitlement {id: system::nativeId, tenantId})-[:BELONGS_TO]->(:Application {id: system,
 *   tenantId}): every entitlement catalog entry with a native id (entitlement-node-id.ts: a native
 *   id can repeat in another system).
 * - (:Identity)-[:HAS_ACCESS]->(:Entitlement): the access the identity page calls Active, what
 *   provisioning.completed would have linked: policy grants (evaluated as
 *   IdentityEntitlementsPolicyHandler does) on a target system where the identity's account is
 *   SYNCED, and the entitlements with a native id of the identity's ACTIVE access requests. Each
 *   edge says how it was granted (grantedBy policy or request, source). A policy grant links to
 *   the catalog entry of its target (catalogTargetLookup: by native id, else the one entry with
 *   that name on the system), so a group a rule names by display name is the catalog's node, as
 *   intelligence names it; a target the catalog does not know, or names twice, keeps its own id.
 *   The node an older run made under the display name is then unstamped and removed.
 *
 * Idempotent MERGE, each node and edge stamped with the run's id; then the tenant's Identity,
 * Entitlement and Application nodes and HAS_ACCESS and BELONGS_TO edges without the stamp are
 * removed (only after every load succeeded), and so are the tenant's duplicate nodes (two of a
 * label with one id, written before the uniqueness constraints existed): one of each id stays.
 * Then GraphService creates the constraints that are still missing, so a resync of each tenant
 * the API log names is what an admin does when one could not be created. Group nesting is not
 * loaded, so MEMBER_OF edges are neither written nor removed (except with a removed node). An
 * event written for the tenant while a resync runs can be removed by it; the next event or resync
 * writes it again. One resync per tenant runs at a time across the API replicas (a lock in the
 * shared lock store, Redis with REDIS_URL).
 */
import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { GraphService } from '@infrastructure/graph/graph.service';
import { OWNED_LOCK_STORE, type OwnedLockStore } from '@infrastructure/cache/owned-lock.store';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { Identity, type IdentityDocument } from '../identity/schemas/identity.schema';
import { NOT_DELETED } from '../identity/identity.constants';
import { IdentityService } from '../identity/identity.service';
import { resolveStatus } from '../identity/identity-entitlements.service';
import { PolicyEngineService, type ProvisioningOperation } from '../policy/policy-engine.service';
import {
  EntitlementCatalog,
  type EntitlementCatalogDocument,
} from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import {
  AccessRequest,
  type AccessRequestDocument,
} from '../access-requests/schemas/access-request.schema';
import { catalogTargetLookup } from '../entitlement-catalog/catalog-target-lookup';
import { catalogSystemName } from '@shared/utils/normalize-system-name';
import { entitlementNodeId } from './entitlement-node-id';
import {
  CATALOG_CYPHER,
  DUPLICATE_CYPHER,
  GRANT_CYPHER,
  IDENTITY_CYPHER,
  PRUNE_CYPHER,
} from './graph-resync.cypher';

/**
 * The tenant's resync lock: held in the lock store every API replica shares (Redis with REDIS_URL;
 * without it an in-process map, one replica only), for LOCK_TTL_MS and renewed while the run goes
 * on, so a replica that dies mid-run frees it within that time.
 */
const lockKey = (tenantId: string) => `euroid:graph-resync:${tenantId}`;
const LOCK_TTL_MS = 5 * 60 * 1000;

/** Operation types that grant access in a target system (as IdentityEntitlementsPolicyHandler). */
const GRANT_TYPES = new Set(['group', 'license', 'role']);

interface GrantRow {
  identityId: string;
  /** The entitlement's node: entitlementNodeId(system, native id). */
  targetId: string;
  nativeId: string;
  type: string;
  connector: string;
  grantedBy: 'policy' | 'request';
  source: string;
}

export interface GraphResyncResult {
  identities: number;
  entitlements: number;
  applications: number;
  grants: { policy: number; request: number };
  removed: {
    identities: number;
    entitlements: number;
    applications: number;
    relationships: number;
  };
  durationMs: number;
}

type IdentityRow = Pick<IdentityDocument, 'profile' | 'provisioning' | 'sources'> & {
  _id: unknown;
};

@Injectable()
export class GraphResyncService {
  private readonly logger = new Logger(GraphResyncService.name);
  /** Identities read and written per batch. */
  private pageSize = 500;

  constructor(
    private readonly graphService: GraphService,
    @InjectModel(Identity.name) private readonly identityModel: Model<IdentityDocument>,
    @InjectModel(EntitlementCatalog.name)
    private readonly catalogModel: Model<EntitlementCatalogDocument>,
    @InjectModel(AccessRequest.name) private readonly requestModel: Model<AccessRequestDocument>,
    private readonly identityService: IdentityService,
    private readonly policyEngine: PolicyEngineService,
    @Inject(OWNED_LOCK_STORE) private readonly locks: OwnedLockStore,
  ) {}

  /**
   * One resync per tenant at a time across the API replicas: each run prunes what it did not
   * stamp, so two at once would remove each other's nodes and edges.
   */
  async resync(tenantId: string): Promise<GraphResyncResult> {
    this.graphService.assertAvailable();
    const key = lockKey(tenantId);
    const owner = randomUUID();
    if ((await this.locks.acquire(key, owner, LOCK_TTL_MS)) !== owner) {
      throw new ConflictException(
        'A graph resync for this tenant is already running. Wait for it to finish.',
      );
    }
    const renew = setInterval(() => {
      this.locks.acquire(key, owner, LOCK_TTL_MS).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Could not renew the graph resync lock of ${tenantId}: ${message}`);
      });
    }, LOCK_TTL_MS / 3);
    renew.unref();
    try {
      return await this.run(tenantId);
    } finally {
      clearInterval(renew);
      // A release that fails leaves the lock to expire after LOCK_TTL_MS
      await this.locks.release(key, owner).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Could not release the graph resync lock of ${tenantId}: ${message}`);
      });
    }
  }

  private async run(tenantId: string): Promise<GraphResyncResult> {
    const started = Date.now();
    const runId = randomUUID();
    const write = (cypher: string, params: Record<string, unknown>) =>
      this.graphService.writeStrict(cypher, { ...params, tenantId, runId });

    const identityIds = new Set<string>();
    const grants: GrantRow[] = [];
    let after: Types.ObjectId | undefined;
    for (;;) {
      const page = (await this.identityModel
        .find({ tenantId, ...NOT_DELETED, ...(after ? { _id: { $gt: after } } : {}) })
        .sort({ _id: 1 })
        .limit(this.pageSize)
        .lean()
        .exec()) as unknown as IdentityRow[];
      if (page.length === 0) break;
      await write(IDENTITY_CYPHER, { rows: page.map(identityRow) });
      for (const doc of page) {
        identityIds.add(String(doc._id));
        grants.push(...(await this.policyGrants(doc, tenantId)));
      }
      after = page[page.length - 1]._id as Types.ObjectId;
      if (page.length < this.pageSize) break;
    }

    const catalog = await this.catalogModel
      .find({ tenantId, nativeId: { $nin: [null, ''] } })
      .select('system nativeId name type')
      .lean()
      .exec();
    const systems = [...new Set(catalog.map((e) => e.system))];
    const entitlementRows = catalog.map((e) => ({
      id: entitlementNodeId(e.system, e.nativeId as string),
      nativeId: e.nativeId as string,
      name: e.name,
      type: e.type,
      system: e.system,
    }));
    await write(CATALOG_CYPHER.applications, { systems });
    for (const rows of chunks(entitlementRows, this.pageSize)) {
      await write(CATALOG_CYPHER.entitlements, { rows });
    }

    // So far the policy grants, under the rule's target id: each goes to its catalog entry's node
    const entryOf = catalogTargetLookup(
      catalog.map((e) => ({ system: e.system, nativeId: e.nativeId as string, name: e.name })),
    );
    for (const grant of grants) {
      const entry = entryOf({ system: grant.connector, targetId: grant.targetId });
      grant.nativeId = entry?.nativeId ?? grant.targetId;
      grant.targetId = entry
        ? entitlementNodeId(entry.system, entry.nativeId)
        : entitlementNodeId(grant.connector, grant.targetId);
    }
    grants.push(...(await this.requestGrants(tenantId, identityIds)));
    for (const rows of chunks(grants, this.pageSize)) await write(GRANT_CYPHER, { rows });

    const removed = {
      relationships:
        (await this.prune(write, PRUNE_CYPHER.hasAccess)) +
        (await this.prune(write, PRUNE_CYPHER.belongsTo)),
      identities:
        (await this.prune(write, PRUNE_CYPHER.identities)) +
        (await this.prune(write, DUPLICATE_CYPHER.identities)),
      entitlements:
        (await this.prune(write, PRUNE_CYPHER.entitlements)) +
        (await this.prune(write, DUPLICATE_CYPHER.entitlements)),
      applications:
        (await this.prune(write, PRUNE_CYPHER.applications)) +
        (await this.prune(write, DUPLICATE_CYPHER.applications)),
    };
    await this.graphService.ensureNodeConstraints();
    const result: GraphResyncResult = {
      identities: identityIds.size,
      entitlements: new Set([...entitlementRows.map((e) => e.id), ...grants.map((g) => g.targetId)])
        .size,
      applications: systems.length,
      grants: {
        policy: grants.filter((g) => g.grantedBy === 'policy').length,
        request: grants.filter((g) => g.grantedBy === 'request').length,
      },
      removed,
      durationMs: Date.now() - started,
    };
    this.logger.log(
      `Graph resync of tenant ${tenantId}: ${result.identities} identities, ` +
        `${result.entitlements} entitlements, ${result.grants.policy + result.grants.request} ` +
        `grants; removed ${removed.identities} identities, ${removed.entitlements} entitlements, ` +
        `${removed.relationships} relationships (${result.durationMs} ms)`,
    );
    return result;
  }

  /** Policy grants on a target where the identity's account is SYNCED (the page's Active). */
  private async policyGrants(doc: IdentityRow, tenantId: string): Promise<GrantRow[]> {
    const provisioning = doc.provisioning ?? [];
    if (!provisioning.some((p) => p.status === 'SYNCED')) return [];
    const identityId = String(doc._id);
    let operations: ProvisioningOperation[];
    try {
      const profile = await this.identityService.buildProfileWithContractsForPolicy(
        doc as unknown as IdentityDocument,
      );
      operations = await this.policyEngine.evaluateOperationsWithoutSod(
        profile as unknown as StandardUserDto,
        tenantId,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        `Policy evaluation failed for identity ${identityId}: ${message}. Nothing was removed from the graph.`,
      );
    }
    return operations
      .filter((op) => op.action === 'add' && GRANT_TYPES.has(op.type))
      .filter(
        (op) =>
          resolveStatus(
            {
              grantedBy: 'policy',
              entitlement: op.targetId,
              type: op.type,
              targetSystem: op.target,
              source: op.sourcePolicy,
            },
            provisioning,
          ) === 'Active',
      )
      .map((op) => ({
        identityId,
        targetId: op.targetId,
        nativeId: op.targetId,
        type: op.type,
        connector: catalogSystemName(op.target),
        grantedBy: 'policy' as const,
        source: op.sourcePolicy,
      }));
  }

  /** The entitlements with a native id of the ACTIVE requests of identities the resync merged. */
  private async requestGrants(tenantId: string, identityIds: Set<string>): Promise<GrantRow[]> {
    const requests = await this.requestModel
      .find({ tenantId, status: 'ACTIVE' })
      .select('requestId targetIdentityId requesterId entitlements')
      .lean()
      .exec();
    return requests.flatMap((request) => {
      const identityId = request.targetIdentityId || request.requesterId;
      if (!identityIds.has(identityId)) return [];
      return (request.entitlements ?? [])
        .filter((e) => e.nativeId)
        .map((e) => ({
          identityId,
          targetId: entitlementNodeId(e.system, e.nativeId as string),
          nativeId: e.nativeId as string,
          type: (e.entitlementType ?? 'Group').toLowerCase(),
          connector: catalogSystemName(e.system),
          grantedBy: 'request' as const,
          source: `Access request ${request.requestId}`,
        }));
    });
  }

  private async prune(
    write: (cypher: string, params: Record<string, unknown>) => Promise<{ records: unknown[] }>,
    cypher: string,
  ): Promise<number> {
    const { records } = await write(cypher, {});
    const value = (records[0] as { get(key: string): unknown } | undefined)?.get('removed');
    return toNumber(value);
  }
}

function identityRow(doc: IdentityRow) {
  const profile = (doc.profile ?? {}) as { email?: string; status?: string; sourceSystem?: string };
  return {
    id: String(doc._id),
    status: profile.status ?? null,
    email: profile.email ?? null,
    sourceSystem: profile.sourceSystem ?? doc.sources?.[0]?.sourceName ?? null,
  };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A count from Neo4j: a neo4j Integer, or a number in tests. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const int = value as { toNumber?: () => number } | undefined;
  return int?.toNumber ? int.toNumber() : 0;
}
