/**
 * GET /identity/:id/offboard-impact over HTTP, with the real controller, the real offboard-impact
 * handler on the real Nest event emitter, and the global AllExceptionsFilter from main.ts.
 * A failed access-request lookup must reach the client as an error, not as an empty preview.
 */
import { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { OffboardImpactEventHandler } from '@infrastructure/events/handlers/offboard-impact.handler';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { AccessRequestsService } from '../access-requests/access-requests.service';
import { DeadLetterService } from '../dead-letter/dead-letter.service';
import { AuditService } from '../audit/audit.service';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { IdentityEntitlementsService } from './identity-entitlements.service';
import { UserEventService } from './user-event.service';

const IDENTITY_ID = '507f1f77bcf86cd799439011';

describe('GET /identity/:id/offboard-impact', () => {
  let app: INestApplication;
  const findActiveRequestsForIdentity = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      controllers: [IdentityController],
      providers: [
        OffboardImpactEventHandler,
        {
          provide: DomainEventEmitterService,
          inject: [EventEmitter2],
          useFactory: (emitter: EventEmitter2) =>
            new DomainEventEmitterService(
              emitter,
              { capture: jest.fn() } as unknown as DeadLetterService,
              {} as never,
              { get: jest.fn().mockReturnValue('test') } as never,
            ),
        },
        {
          provide: IdentityService,
          useValue: {
            findById: jest.fn().mockResolvedValue({
              provisioning: [{ targetSystem: 'entra-id', status: 'PROVISIONED' }],
            }),
          },
        },
        { provide: AccessRequestsService, useValue: { findActiveRequestsForIdentity } },
        { provide: UserEventService, useValue: {} },
        { provide: AuditService, useValue: {} },
        { provide: IdentityEntitlementsService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => findActiveRequestsForIdentity.mockReset());

  it('returns the affected systems and the entitlements of active requests', async () => {
    findActiveRequestsForIdentity.mockResolvedValue([
      { requestId: 'AR-1', entitlements: [{ system: 'entra-id', entitlementName: 'Finance-RO' }] },
    ]);

    const res = await request(app.getHttpServer()).get(`/identity/${IDENTITY_ID}/offboard-impact`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      affectedSystems: ['entra-id'],
      entitlements: [{ name: 'Finance-RO', system: 'entra-id', type: 'Group' }],
    });
    expect(findActiveRequestsForIdentity).toHaveBeenCalledWith(IDENTITY_ID);
  });

  it('answers 500 when the access requests cannot be read, instead of an empty impact', async () => {
    findActiveRequestsForIdentity.mockRejectedValue(new Error('access request store down'));

    const res = await request(app.getHttpServer()).get(`/identity/${IDENTITY_ID}/offboard-impact`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
  });
});
