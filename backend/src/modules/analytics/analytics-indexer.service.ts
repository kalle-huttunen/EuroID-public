/**
 * Analytics Indexer Service
 *
 * Listens to domain events and indexes audit events into Elasticsearch
 * for fast aggregation-based analytics queries (CQRS read model). A GDPR erasure removes the
 * person's documents (gdpr-erasure-external-stores.ts); the backfill does not index them again.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ElasticsearchService } from '@infrastructure/elasticsearch/elasticsearch.service';
import {
  ES_INDEX,
  AUDIT_EVENTS_MAPPINGS,
} from '@infrastructure/elasticsearch/elasticsearch.constants';
import { DomainEventType } from '@infrastructure/events/event-types';
import { DomainEvent } from '@infrastructure/events/domain-event.interface';
import { AuditEvent, AuditEventDocument } from '../audit/schemas/audit-event.schema';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';

/** The audit action of a GDPR erasure (gdpr-erasure.service.ts). */
const ERASURE_ACTION = 'GDPR_ERASURE_EXECUTED';

@Injectable()
export class AnalyticsIndexerService {
  private readonly logger = new Logger(AnalyticsIndexerService.name);

  constructor(
    private readonly esService: ElasticsearchService,
    @InjectModel(AuditEvent.name)
    private readonly auditModel: Model<AuditEventDocument>,
  ) {}

  /** Called once during module init to ensure ES indices exist. */
  async ensureIndices(): Promise<void> {
    if (!this.esService.isAvailable()) {
      this.logger.warn('Elasticsearch unavailable — skipping index creation');
      return;
    }
    await this.esService.ensureIndex(ES_INDEX.AUDIT_EVENTS, AUDIT_EVENTS_MAPPINGS);
    this.logger.log('Audit events ES index ready');
  }

  /**
   * Index a single audit event into Elasticsearch.
   */
  async indexAuditEvent(event: Record<string, unknown>): Promise<boolean> {
    if (!this.esService.isAvailable()) return false;

    const id = String(event._id || event.id || '');
    return this.esService.indexDocument(ES_INDEX.AUDIT_EVENTS, id, {
      tenantId: event.tenantId,
      action: event.action,
      actor: event.actor,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      resourceName: event.resourceName,
      targetSystem: event.targetSystem,
      description: event.description,
      timestamp: event.timestamp,
      severity: event.severity,
      outcome: event.outcome,
      correlationId: event.correlationId,
      payload: event.payload,
    });
  }

  /**
   * Bulk-index historical audit events from MongoDB into Elasticsearch.
   * Processes in batches of 500.
   */
  async backfillFromMongo(batchSize = 500): Promise<{ indexed: number; errors: number }> {
    if (!this.esService.isAvailable()) return { indexed: 0, errors: 0 };

    const tenantId = getRequestContext()?.tenantId || 'default';
    let indexed = 0;
    let errors = 0;
    let skip = 0;

    while (true) {
      const batch = await this.auditModel
        .find({ tenantId })
        .sort({ timestamp: 1 })
        .skip(skip)
        .limit(batchSize)
        .lean()
        .exec();

      if (batch.length === 0) break;

      const erased = await this.erasedIdentities(tenantId, batch);
      for (const doc of batch) {
        if (erased.has(String(doc.resourceId)) && doc.action !== ERASURE_ACTION) continue;
        // An entry of a domain event: the event's id, as live indexing (indexDomainEvent) uses
        const id = String(doc.eventId || doc._id);
        await this.esService.bulkIndex(ES_INDEX.AUDIT_EVENTS, id, {
          tenantId: doc.tenantId,
          action: doc.action,
          actor: doc.actor,
          resourceType: doc.resourceType,
          resourceId: doc.resourceId,
          resourceName: doc.resourceName,
          targetSystem: doc.targetSystem,
          description: doc.description,
          timestamp: doc.timestamp,
          severity: doc.severity,
          payload: doc.payload,
        });
        indexed++;
      }

      await this.esService.flushBulkBuffer();
      skip += batch.length;
      this.logger.log(`Backfill progress: ${indexed} audit events indexed`);
    }

    this.logger.log(`Backfill complete: ${indexed} indexed, ${errors} errors`);
    return { indexed, errors };
  }

  /**
   * The identities of a batch a GDPR erasure (not a dry run) covers. The erasure deletes their
   * entries from MongoDB and from the index, keeping its own entry, which it writes first; a batch
   * read just before that delete still holds the entries, and indexing them would bring the
   * person back into the index. Their erasure entries are indexed, as MongoDB keeps them.
   */
  private async erasedIdentities(
    tenantId: string,
    batch: Array<{ resourceId?: unknown }>,
  ): Promise<Set<string>> {
    const resourceIds = [...new Set(batch.map((d) => String(d.resourceId ?? '')))].filter(Boolean);
    const erased = await this.auditModel
      .distinct('resourceId', {
        tenantId,
        action: ERASURE_ACTION,
        'payload.metadata.dryRun': { $ne: true },
        resourceId: { $in: resourceIds },
      })
      .exec();
    return new Set(erased.map(String));
  }

  // ── Event listeners — index new audit events as they occur ────────────

  @OnEvent(DomainEventType.IDENTITY_CREATED, { async: true })
  async onIdentityCreated(event: DomainEvent): Promise<void> {
    await this.indexDomainEvent('identity.created', event);
  }

  @OnEvent(DomainEventType.IDENTITY_UPDATED, { async: true })
  async onIdentityUpdated(event: DomainEvent): Promise<void> {
    await this.indexDomainEvent('identity.updated', event);
  }

  @OnEvent(DomainEventType.PROVISIONING_COMPLETED, { async: true })
  async onProvisioningCompleted(event: DomainEvent): Promise<void> {
    await this.indexDomainEvent('provisioning.completed', event);
  }

  private async indexDomainEvent(action: string, event: DomainEvent): Promise<void> {
    if (!this.esService.isAvailable()) return;

    try {
      // One document per event: the correlation id is shared by every event of a request (an HR
      // sync's identity.created events) and by context-less events, which overwrote each other
      const id = event.eventId || `${action}-${event.aggregateId}-${Date.now()}`;
      await this.esService.bulkIndex(ES_INDEX.AUDIT_EVENTS, id, {
        tenantId: event.metadata?.tenantId || 'default',
        action,
        actor: event.metadata?.actor || 'system',
        resourceType: 'identity',
        resourceId: event.aggregateId,
        timestamp: new Date().toISOString(),
        correlationId: event.metadata?.correlationId,
        payload: event.payload,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to index domain event ${action}: ${message}`);
    }
  }
}
