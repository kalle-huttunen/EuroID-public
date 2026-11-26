/**
 * The `/anomalies/:id` routes over HTTP, on in-memory MongoDB with the tenant plugin. An anomaly
 * is addressed by its public id `anomalyId` (a UUID: the id `anomaly.detected` and
 * `anomaly.resolved` carry, so a notification link or a webhook consumer holds it). The document
 * `_id` (an ObjectId) still works because the Risk dashboard of the previous release sends it.
 * Anything else is 400 before any lookup, and another tenant's anomaly is 404 by either id.
 */
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  NestMiddleware,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, HttpAdapterHost } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import type { NextFunction, Request, Response } from 'express';
import * as request from 'supertest';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { TenantContextInterceptor } from '@infrastructure/multi-tenancy/tenant-context.interceptor';
import { CorrelationMiddleware } from '@infrastructure/middleware/correlation.middleware';
import { RolesGuard } from '@infrastructure/auth/roles.guard';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { anomalyConfig } from '@infrastructure/config/anomaly.config';
import { globalExceptionFilters } from '@shared/filters/global-exception-filters';
import { createMockEventEmitter, closeTestDb, testDbUri } from '@testing';
import { AnomalyController } from './anomaly.controller';
import { AccessAnomalyService } from './anomaly.service';
import { Anomaly, AnomalyDocument, AnomalySchema } from './schemas/anomaly.schema';
import { RiskScore, RiskScoreSchema } from './schemas/risk-score.schema';

// Register tenant scoping plugin (normally done by TenantModule at import time)
mongoose.plugin(tenantPlugin);

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const A_UUID = '0b5e2c1d-7a43-4f0e-9d7a-2a1c3b4d5e6f';
const B_UUID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

/** Stand-in for JwtAuthGuard: the caller's tenant comes from its (trusted) token. */
@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const tenantId = String(req.headers['x-test-tenant'] ?? TENANT_A);
    req.user = { sub: 'op', email: `op@${tenantId}.example`, roles: ['operator'], tenantId };
    return true;
  }
}

type Route = { name: string; method: 'get' | 'post'; path: (id: string) => string; ok: number };
const ROUTES: Route[] = [
  { name: 'GET :id', method: 'get', path: (id) => `/anomalies/${id}`, ok: 200 },
  {
    name: 'POST :id/acknowledge',
    method: 'post',
    path: (id) => `/anomalies/${id}/acknowledge`,
    ok: 201,
  },
  { name: 'POST :id/dismiss', method: 'post', path: (id) => `/anomalies/${id}/dismiss`, ok: 201 },
  { name: 'POST :id/resolve', method: 'post', path: (id) => `/anomalies/${id}/resolve`, ok: 201 },
];

describe('Anomaly routes (HTTP + in-memory MongoDB)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let anomalyModel: Model<AnomalyDocument>;
  const events = createMockEventEmitter();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Anomaly.name, schema: AnomalySchema },
          { name: RiskScore.name, schema: RiskScoreSchema },
        ]),
      ],
      controllers: [AnomalyController],
      providers: [
        AccessAnomalyService,
        { provide: DomainEventEmitterService, useValue: events },
        { provide: anomalyConfig.KEY, useValue: { businessHoursTz: 'UTC' } },
        { provide: APP_GUARD, useClass: TestAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
    })
      // The rule inputs (audit, identities, policy engine, catalog, Entra) are not used here.
      .useMocker(() => ({}))
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    const correlation = new CorrelationMiddleware();
    app.use((req: Request, res: Response, next: NextFunction) =>
      (correlation as NestMiddleware).use(req, res, next),
    );
    app.useGlobalFilters(...globalExceptionFilters(app.get(HttpAdapterHost)));
    await app.init();
    anomalyModel = moduleRef.get(getModelToken(Anomaly.name));
  });

  afterEach(async () => {
    await anomalyModel.deleteMany({}, { skipTenantScope: true });
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  async function seed(tenantId: string, anomalyId: string): Promise<string> {
    const doc = await withTenantContext(tenantId, () =>
      anomalyModel.create({
        tenantId,
        anomalyId,
        identityId: '64b7f0c2a1b2c3d4e5f60001',
        type: 'VELOCITY',
        severity: 'medium',
        riskScore: 25,
        title: 'Many changes',
        description: 'Many provisioning operations in a short window.',
        evidence: { events: [], pattern: 'velocity_burst', details: {} },
        status: 'open',
      }),
    );
    return String(doc._id);
  }

  function stored(anomalyId: string) {
    return anomalyModel.findOne({ anomalyId }, null, { skipTenantScope: true }).lean().exec();
  }

  function call(route: Route, id: string, tenant = TENANT_A) {
    const server = app.getHttpServer();
    const req =
      route.method === 'get'
        ? request(server).get(route.path(id))
        : request(server).post(route.path(id));
    return req.set('x-test-tenant', tenant);
  }

  describe.each(ROUTES)('$name', (route) => {
    it('finds the anomaly by its anomalyId (UUID)', async () => {
      await seed(TENANT_A, A_UUID);
      const res = await call(route, A_UUID).expect(route.ok);
      expect(res.body.anomalyId).toBe(A_UUID);
    });

    it('still finds it by its document _id (ObjectId), which the last release sends', async () => {
      const objectId = await seed(TENANT_A, A_UUID);
      const res = await call(route, objectId).expect(route.ok);
      expect(res.body.anomalyId).toBe(A_UUID);
    });

    it('answers 400 for a value that is neither, without changing anything', async () => {
      await seed(TENANT_A, A_UUID);
      const res = await call(route, 'not-an-id').expect(400);
      expect(res.body.message).toMatch(/Invalid ID format/);
      expect((await stored(A_UUID))?.status).toBe('open');
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('answers 404 for a UUID nothing has', async () => {
      await seed(TENANT_A, A_UUID);
      await call(route, B_UUID).expect(404);
    });

    it("answers 404 for another tenant's anomaly by either id and leaves it as it is", async () => {
      const objectIdOfB = await seed(TENANT_B, B_UUID);
      await call(route, B_UUID, TENANT_A).expect(404);
      await call(route, objectIdOfB, TENANT_A).expect(404);
      const b = await stored(B_UUID);
      expect(b?.status).toBe('open');
      expect(b?.acknowledgedBy).toBeUndefined();
      expect(b?.resolvedAt).toBeUndefined();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  it('acknowledges as the caller and dismisses with the reason given', async () => {
    await seed(TENANT_A, A_UUID);
    const ack = await call(ROUTES[1], A_UUID).expect(201);
    expect(ack.body).toMatchObject({
      status: 'acknowledged',
      acknowledgedBy: 'op@tenant-a.example',
    });

    const dismissed = await request(app.getHttpServer())
      .post(`/anomalies/${A_UUID}/dismiss`)
      .set('x-test-tenant', TENANT_A)
      .send({ reason: 'Planned migration' })
      .expect(201);
    expect(dismissed.body).toMatchObject({
      status: 'dismissed',
      acknowledgedBy: 'op@tenant-a.example',
      metadata: { dismissReason: 'Planned migration' },
    });
  });

  it('answers 409 naming the current status for a change a closed anomaly does not allow', async () => {
    await seed(TENANT_A, A_UUID);
    await call(ROUTES[3], A_UUID).expect(201);
    events.emit.mockClear();

    const again = await call(ROUTES[3], A_UUID).expect(409);
    expect(again.body.message).toBe(`Anomaly ${A_UUID} is already resolved.`);
    const ack = await call(ROUTES[1], A_UUID).expect(409);
    expect(ack.body.message).toBe(`Anomaly ${A_UUID} is resolved and cannot be acknowledged.`);
    expect((await stored(A_UUID))?.status).toBe('resolved');
    expect(events.emit).not.toHaveBeenCalled();
  });
});
