jest.mock('jose', () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn(() => ({})) }));

import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { DomainEventType } from '../events/event-types';
import { RealTimeBridgeService } from './realtime-bridge.service';
import { EventsGateway } from './events.gateway';

describe('RealTimeBridgeService', () => {
  let service: RealTimeBridgeService;
  let gateway: jest.Mocked<Pick<EventsGateway, 'broadcastToRoom'>>;

  beforeEach(async () => {
    gateway = { broadcastToRoom: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealTimeBridgeService,
        { provide: EventsGateway, useValue: gateway },
        { provide: EventEmitter2, useValue: { on: jest.fn(), emit: jest.fn() } },
      ],
    }).compile();

    service = module.get(RealTimeBridgeService);
  });

  it('should forward ANOMALY_DETECTED to tenant-prefixed anomalies room', () => {
    const event = {
      eventId: 'e1',
      type: DomainEventType.ANOMALY_DETECTED,
      aggregateId: 'id1',
      timestamp: new Date().toISOString(),
      payload: { identityId: 'u1', type: 'TEST', severity: 'HIGH' },
      metadata: { correlationId: 'c1', depth: 0, emittedBy: 'Test', actor: 'system', tenantId: 'tenant-1' },
    };

    service.handleDomainEvent(event);

    expect(gateway.broadcastToRoom).toHaveBeenCalledWith(
      't:tenant-1:anomalies',
      DomainEventType.ANOMALY_DETECTED,
      event.payload,
    );
  });

  it('should forward PROVISIONING_COMPLETED to tenant-prefixed provisioning room', () => {
    const event = {
      eventId: 'e2',
      type: DomainEventType.PROVISIONING_COMPLETED,
      aggregateId: 'id2',
      timestamp: new Date().toISOString(),
      payload: { identityId: 'u2', connector: 'entra', operations: [] },
      metadata: { correlationId: 'c2', depth: 0, emittedBy: 'Test', actor: 'system', tenantId: 'tenant-2' },
    };

    service.handleDomainEvent(event);

    expect(gateway.broadcastToRoom).toHaveBeenCalledWith(
      't:tenant-2:provisioning',
      DomainEventType.PROVISIONING_COMPLETED,
      event.payload,
    );
  });

  it('should forward unknown event type to tenant-prefixed system room', () => {
    const event = {
      eventId: 'e3',
      type: 'identity.created' as DomainEventType,
      aggregateId: 'id3',
      timestamp: new Date().toISOString(),
      payload: { identityId: 'u3' },
      metadata: { correlationId: 'c3', depth: 0, emittedBy: 'Test', actor: 'system', tenantId: 'tenant-3' },
    };

    service.handleDomainEvent(event);

    expect(gateway.broadcastToRoom).toHaveBeenCalledWith(
      't:tenant-3:system',
      'identity.created',
      event.payload,
    );
  });

  it('should forward access_review event to tenant-prefixed reviews room', () => {
    const event = {
      eventId: 'e4',
      type: DomainEventType.ACCESS_REVIEW_CAMPAIGN_ACTIVATED,
      aggregateId: 'id4',
      timestamp: new Date().toISOString(),
      payload: { campaignId: 'c1', name: 'Review', itemCount: 10 },
      metadata: { correlationId: 'c4', depth: 0, emittedBy: 'Test', actor: 'system', tenantId: 'tenant-4' },
    };

    service.handleDomainEvent(event);

    expect(gateway.broadcastToRoom).toHaveBeenCalledWith(
      't:tenant-4:reviews',
      DomainEventType.ACCESS_REVIEW_CAMPAIGN_ACTIVATED,
      event.payload,
    );
  });

  it('payload shape: eventType, timestamp, payload (no _tenantId hack)', () => {
    const payload = { identityId: 'u1', connector: 'ad' };
    const event = {
      eventId: 'e5',
      type: DomainEventType.PROVISIONING_FAILED,
      aggregateId: 'id5',
      timestamp: '2026-01-01T12:00:00Z',
      payload,
      metadata: { correlationId: 'c5', depth: 0, emittedBy: 'Test', actor: 'system', tenantId: 'tenant-5' },
    };

    service.handleDomainEvent(event);

    expect(gateway.broadcastToRoom).toHaveBeenCalledWith(
      't:tenant-5:provisioning',
      DomainEventType.PROVISIONING_FAILED,
      payload,
    );
  });

  it('should not broadcast when tenantId is missing', () => {
    const event = {
      eventId: 'e6',
      type: DomainEventType.IDENTITY_CREATED,
      aggregateId: 'id6',
      timestamp: new Date().toISOString(),
      payload: { identityId: 'u6' },
      metadata: { correlationId: 'c6', depth: 0, emittedBy: 'Test', actor: 'system', tenantId: '' },
    };

    service.handleDomainEvent(event);

    expect(gateway.broadcastToRoom).not.toHaveBeenCalled();
  });

  it('should not broadcast when metadata.tenantId is undefined', () => {
    const event = {
      eventId: 'e7',
      type: DomainEventType.IDENTITY_CREATED,
      aggregateId: 'id7',
      timestamp: new Date().toISOString(),
      payload: { identityId: 'u7' },
      metadata: { correlationId: 'c7', depth: 0, emittedBy: 'Test', actor: 'system' } as any,
    };

    service.handleDomainEvent(event);

    expect(gateway.broadcastToRoom).not.toHaveBeenCalled();
  });
});
