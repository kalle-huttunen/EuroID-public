/**
 * Graph Sync Service
 *
 * Keeps Neo4j in step with MongoDB between resyncs (GraphResyncService), with the same mapping:
 * - identity.created / identity.updated: the Identity node (email as the identity has it stored).
 * - provisioning.completed: HAS_ACCESS for each group, license or role added, removed for each
 *   one removed. The operation names the target as the rule does (a group's display name, say):
 *   the edge goes to its catalog entry's node, keyed by system and native id
 *   (entitlement-node-id.ts), as the resync links it (catalogTargetLookup); a target the catalog
 *   does not know, or names twice, is keyed by the system and its own id. A removal also removes
 *   an edge to that key, written before the catalog knew the target.
 * - discovery.completed (EntitlementCatalogService.absorbDiscovered, after it wrote the catalog):
 *   the system's catalog entries with a native id, named and typed, BELONGS_TO its Application.
 *   Entries the catalog dropped stay until the next resync.
 * - identity.deleted (soft or hard delete) and identity.offboarding_completed with the Golden
 *   Record deleted: the identity's node and its edges are removed, as the resync leaves out
 *   soft-deleted identities. A suspended offboarding (a target failed) keeps the node: the
 *   account in that target still exists, and the resync keeps it too.
 *
 * Group nesting is not modelled: no group-in-group membership is written to the graph (discovery
 * reads groups without their members; a SCIM inbound group's member types are not read here), so
 * nothing writes MEMBER_OF.
 *
 * Fail-open: errors are logged but never crash the event pipeline. These writes leave a resync's
 * run stamp (syncRunId) as it is.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { GraphService } from '@infrastructure/graph/graph.service';
import { DomainEvent } from '@infrastructure/events/domain-event.interface';
import { DomainEventType } from '@infrastructure/events/event-types';
import {
  DiscoveryCompletedPayload,
  IdentityCreatedPayload,
  IdentityDeletedPayload,
  IdentityUpdatedPayload,
  OffboardingCompletedPayload,
  ProvisioningCompletedPayload,
} from '@infrastructure/events/event-payloads';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import {
  EntitlementCatalog,
  type EntitlementCatalogDocument,
} from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import { loadCatalogTargetLookup } from '../entitlement-catalog/catalog-target-lookup';
import { catalogSystemName } from '@shared/utils/normalize-system-name';
import { entitlementNodeId } from './entitlement-node-id';

/**
 * discovery.completed: the system's Application, then each catalog entry ($rows: { id
 * (entitlementNodeId), nativeId, name, type }) as the resync's CATALOG_CYPHER writes it, without
 * its run stamp.
 */
const DISCOVERY_CYPHER = `
MERGE (a:Application {id: $system, tenantId: $tenantId})
ON CREATE SET a.system = $system, a.createdAt = datetime()
ON MATCH SET a.updatedAt = datetime()
WITH a
UNWIND $rows AS row
MERGE (e:Entitlement {id: row.id, tenantId: $tenantId})
ON CREATE SET e.createdAt = datetime()
ON MATCH SET e.updatedAt = datetime()
SET e.name = row.name, e.nativeId = row.nativeId, e.entitlementType = row.type, e.system = $system
MERGE (e)-[:BELONGS_TO]->(a)`;

@Injectable()
export class GraphSyncService {
  private readonly logger = new Logger(GraphSyncService.name);

  constructor(
    private readonly graphService: GraphService,
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    @InjectModel(EntitlementCatalog.name)
    private readonly catalogModel: Model<EntitlementCatalogDocument>,
  ) {}

  // ── Identity Events ────────────────────────────────────────────────

  @OnEvent(DomainEventType.IDENTITY_CREATED, { async: true })
  async onIdentityCreated(event: DomainEvent<IdentityCreatedPayload>): Promise<void> {
    const { identityId, sourceSystem, status } = event.payload;
    const tenantId = event.metadata.tenantId;

    try {
      // identity.created carries no email (plan 2.8a): the node gets the identity's as stored
      const email = await this.storedEmail(identityId, tenantId);
      await this.graphService.runWriteQuery(
        `MERGE (i:Identity {id: $id, tenantId: $tenantId})
         ON CREATE SET
           i.sourceSystem = $sourceSystem,
           i.status = $status,
           i.email = $email,
           i.createdAt = datetime()
         ON MATCH SET
           i.sourceSystem = $sourceSystem,
           i.status = $status,
           i.email = coalesce($email, i.email),
           i.updatedAt = datetime()`,
        {
          id: identityId,
          tenantId,
          sourceSystem,
          status,
          // null, not '': an identity without an email keeps the email the node has.
          email,
        },
      );
      this.logger.debug(`Graph: upserted Identity node ${identityId}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Graph sync failed for identity.created ${identityId}: ${message}`);
    }
  }

  @OnEvent(DomainEventType.IDENTITY_UPDATED, { async: true })
  async onIdentityUpdated(event: DomainEvent<IdentityUpdatedPayload>): Promise<void> {
    const { identityId, changedFields, source } = event.payload;
    const tenantId = event.metadata.tenantId;

    try {
      // identity.updated carries no email (plan 2.0dn): the node gets the identity's as stored
      const email = await this.storedEmail(identityId, tenantId);
      await this.graphService.runWriteQuery(
        `MERGE (i:Identity {id: $id, tenantId: $tenantId})
         ON CREATE SET
           i.source = $source,
           i.email = $email,
           i.createdAt = datetime()
         ON MATCH SET
           i.source = $source,
           i.email = coalesce($email, i.email),
           i.changedFields = $changedFields,
           i.updatedAt = datetime()`,
        {
          id: identityId,
          tenantId,
          source,
          // null, not '': an identity without an email keeps the email the node has.
          email,
          changedFields,
        },
      );
      this.logger.debug(`Graph: updated Identity node ${identityId}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Graph sync failed for identity.updated ${identityId}: ${message}`);
    }
  }

  /** The identity's email now, null when it has none (or the event names no stored identity). */
  private async storedEmail(identityId: string, tenantId: string): Promise<string | null> {
    if (!isValidObjectId(identityId) || !tenantId) return null;
    const identity = await this.identityModel
      .findOne({ _id: identityId, tenantId })
      .select('profile.email')
      .lean()
      .exec();
    return (identity as { profile?: { email?: string } } | null)?.profile?.email ?? null;
  }

  // ── Deleted and offboarded identities ─────────────────────────────

  @OnEvent(DomainEventType.IDENTITY_DELETED, { async: true })
  async onIdentityDeleted(event: DomainEvent<IdentityDeletedPayload>): Promise<void> {
    await this.removeIdentity(event.payload.identityId, event.metadata.tenantId, event.type);
  }

  @OnEvent(DomainEventType.IDENTITY_OFFBOARDING_COMPLETED, { async: true })
  async onOffboardingCompleted(event: DomainEvent<OffboardingCompletedPayload>): Promise<void> {
    if (event.payload.hubStatus !== 'deleted') return;
    await this.removeIdentity(event.payload.identityId, event.metadata.tenantId, event.type);
  }

  private async removeIdentity(identityId: string, tenantId: string, cause: string) {
    try {
      await this.graphService.runWriteQuery(
        `MATCH (i:Identity {id: $id, tenantId: $tenantId}) DETACH DELETE i`,
        { id: identityId, tenantId },
      );
      this.logger.debug(`Graph: removed Identity node ${identityId} (${cause})`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Graph sync failed for ${cause} ${identityId}: ${message}`);
    }
  }

  // ── Entitlement Discovery ──────────────────────────────────────────

  @OnEvent(DomainEventType.DISCOVERY_COMPLETED, { async: true })
  async onDiscoveryCompleted(event: DomainEvent<DiscoveryCompletedPayload>): Promise<void> {
    const { system } = event.payload;
    const tenantId = event.metadata.tenantId;

    try {
      const entries = await this.catalogModel
        .find({ tenantId, system, nativeId: { $nin: [null, ''] } })
        .select('nativeId name type')
        .lean()
        .exec();
      const rows = entries.map((e) => ({
        id: entitlementNodeId(system, e.nativeId as string),
        nativeId: e.nativeId as string,
        name: e.name,
        type: e.type,
      }));
      await this.graphService.runWriteQuery(DISCOVERY_CYPHER, { tenantId, system, rows });
      this.logger.debug(`Graph: synced ${rows.length} catalog entries of ${system}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Graph sync failed for discovery.completed ${system}: ${message}`);
    }
  }

  // ── Provisioning Events ────────────────────────────────────────────

  @OnEvent(DomainEventType.PROVISIONING_COMPLETED, { async: true })
  async onProvisioningCompleted(event: DomainEvent<ProvisioningCompletedPayload>): Promise<void> {
    const { identityId, connector, operations } = event.payload;
    const tenantId = event.metadata.tenantId;
    // A profile without an identity id (bulk rows, PAM profiles): no Identity node to link
    if (!identityId) return;

    try {
      const done = operations.filter((op) => op.success);
      const entryOf = await loadCatalogTargetLookup(
        this.catalogModel,
        tenantId,
        done.map((op) => ({ system: connector, targetId: op.targetId })),
      );
      for (const op of done) {
        const entry = entryOf({ system: connector, targetId: op.targetId });
        const ownKey = entitlementNodeId(connector, op.targetId);
        const targetId = entry ? entitlementNodeId(entry.system, entry.nativeId) : ownKey;

        if (op.action === 'add') {
          // Create HAS_ACCESS edge from Identity to Entitlement
          await this.graphService.runWriteQuery(
            `MERGE (i:Identity {id: $identityId, tenantId: $tenantId})
             MERGE (e:Entitlement {id: $targetId, tenantId: $tenantId})
             ON CREATE SET e.entitlementType = $type, e.system = $system, e.name = $name,
               e.nativeId = $nativeId
             MERGE (i)-[r:HAS_ACCESS]->(e)
             ON CREATE SET r.grantedAt = datetime(), r.connector = $connector
             ON MATCH SET r.updatedAt = datetime()`,
            {
              identityId,
              tenantId,
              targetId,
              nativeId: entry?.nativeId ?? op.targetId,
              name: entry?.name ?? null,
              type: op.type,
              system: catalogSystemName(connector),
              connector,
            },
          );
        } else if (op.action === 'remove') {
          // Remove HAS_ACCESS edge
          await this.graphService.runWriteQuery(
            `MATCH (i:Identity {id: $identityId, tenantId: $tenantId})
                   -[r:HAS_ACCESS]->
                   (e:Entitlement {tenantId: $tenantId})
             WHERE e.id IN $targetIds
             DELETE r`,
            { identityId, tenantId, targetIds: [...new Set([targetId, ownKey])] },
          );
        }
      }

      this.logger.debug(
        `Graph: synced ${operations.length} provisioning operations for ${identityId}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Graph sync failed for provisioning.completed ${identityId}: ${message}`);
    }
  }
}
