import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent } from '../domain-event.interface';
import { AuditService, LogAuditEvent } from '../../../modules/audit/audit.service';
import { withTenantContext } from '../../multi-tenancy/tenant-context.helper';

/**
 * Catch-all: every domain event becomes an audit log entry.
 * Uses wildcard listener so new event types are automatically audited.
 * Audit failures must NEVER crash the emitting service.
 */
@Injectable()
export class AuditEventHandler {
  private readonly logger = new Logger(AuditEventHandler.name);

  constructor(private readonly auditService: AuditService) {}

  @OnEvent('**', { async: true })
  async handleAll(event: DomainEvent): Promise<void> {
    const tenantId = event.metadata.tenantId;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, skipping audit`);
      return;
    }
    try {
      await withTenantContext(tenantId, async () => {
        const logEvent: LogAuditEvent = {
          action: event.type as LogAuditEvent['action'],
          actor: event.metadata.actor,
          resourceType: this.inferResourceType(event.type),
          resourceId: event.aggregateId,
          resourceName: event.aggregateId,
          description: `${event.type} for ${event.aggregateId}`,
          payload: {
            metadata: {
              ...event.payload,
              correlationId: event.metadata.correlationId,
              eventId: event.eventId,
            },
          },
          tenantId,
          // One entry per event: a redelivered event (outbox reclaim, dead-letter replay) adds none
          eventId: event.eventId,
        };
        await this.auditService.log(logEvent);
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to audit ${event.type}: ${message}`);
      // Audit failures must NOT crash the system — log and continue
    }
  }

  private inferResourceType(eventType: string): string {
    if (eventType.startsWith('identity.')) return 'identity';
    if (eventType.startsWith('provisioning.')) return 'provisioning';
    if (eventType.startsWith('policy.')) return 'policy';
    if (eventType.startsWith('drift.')) return 'drift';
    if (eventType.startsWith('connector.')) return 'connector';
    return 'resource';
  }
}
