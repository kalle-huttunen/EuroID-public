import { DomainEventType } from './event-types';

/**
 * Typed envelope for all domain events. Payload is event-specific.
 *
 * Event handlers must NOT perform provisioning directly. They only start Temporal workflows
 * or emit audit/metrics. Provisioning logic lives in workflows. Handlers that trigger
 * workflows (e.g. SourcesChangedHandler) check metadata.depth and skip when depth > 0
 * to prevent circular event loops.
 */
export interface DomainEvent<T = Record<string, unknown>> {
  eventId: string;
  type: DomainEventType;
  aggregateId: string;
  timestamp: string;
  payload: T;
  metadata: {
    correlationId: string;
    causedBy?: string;
    /** Chain depth. Handlers that trigger provisioning skip when depth > 0. */
    depth: number;
    emittedBy: string;
    actor: string;
    tenantId: string;
  };
}
