import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent } from '../events/domain-event.interface';
import { EventsGateway } from './events.gateway';

const EVENT_ROOM_MAP: Record<string, string> = {
  anomaly: 'anomalies',
  provisioning: 'provisioning',
  drift: 'drift',
  access_review: 'reviews',
  pipeline: 'pipeline',
};

function getRoom(eventType: string): string {
  const prefix = eventType.split('.')[0];
  return EVENT_ROOM_MAP[prefix] ?? 'system';
}

@Injectable()
export class RealTimeBridgeService {
  private readonly logger = new Logger(RealTimeBridgeService.name);

  constructor(private readonly gateway: EventsGateway) {}

  @OnEvent('**')
  handleDomainEvent(event: DomainEvent): void {
    const tenantId = event.metadata?.tenantId;
    if (!tenantId) return;

    const room = getRoom(event.type);
    if (room) {
      this.gateway.broadcastToRoom(`t:${tenantId}:${room}`, event.type, event.payload);
    }
  }
}
