/**
 * Port for emitting domain events.
 * Implemented by DomainEventEmitterService, injected via DOMAIN_EVENT_PORT token.
 * Decouples consumers (AccessRequestsService, AccessReviewService) from the emitter's
 * transport choice (EventEmitter2 today, outbox/Kafka later).
 */
import type { DomainEventType } from '../../infrastructure/events/event-types';

export const DOMAIN_EVENT_PORT = Symbol('DOMAIN_EVENT_PORT');

export interface DomainEventOptions {
  causedBy?: string;
  depth?: number;
  tenantId?: string;
  actor?: string;
}

export interface IDomainEventPort {
  emit<T>(
    type: DomainEventType,
    aggregateId: string,
    payload: T,
    options?: DomainEventOptions,
  ): void;
}
