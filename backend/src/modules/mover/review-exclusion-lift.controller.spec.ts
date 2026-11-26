/**
 * HTTP contract of lifting an access review exclusion (RolesGuard with the role hierarchy):
 * policy-admin and super-admin only, as the policies it gives way to. The tenant and the audited
 * actor come from the authenticated user (never the body); the lift takes no body fields; the
 * answer carries the exclusion and the run it started (ReviewExclusionLiftService).
 */
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  NestMiddleware,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import * as request from 'supertest';
import { RolesGuard } from '@infrastructure/auth/roles.guard';
import { TenantContextInterceptor } from '@infrastructure/multi-tenancy/tenant-context.interceptor';
import { CorrelationMiddleware } from '@infrastructure/middleware/correlation.middleware';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { globalExceptionFilters } from '@shared/filters/global-exception-filters';
import { ReviewExclusionLiftController } from './review-exclusion-lift.controller';
import { ReviewExclusionLiftService } from './review-exclusion-lift.service';

/** Stand-in for JwtAuthGuard: the caller's roles and tenant come from its (trusted) token. */
@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const tenantId = String(req.headers['x-test-tenant'] ?? 'tenant-a');
    req.user = {
      sub: 'user-1',
      email: `admin@${tenantId}.example`,
      roles: String(req.headers['x-test-roles'] ?? '').split(','),
      tenantId,
    };
    return true;
  }
}

const ID = '64b7f0c2a1b2c3d4e5f60a01';
const EXCLUSION = '64b7f0c2a1b2c3d4e5f60b01';
const LIFT = `/identity/${ID}/access/review-exclusions/${EXCLUSION}/lift`;
const LIFTED = {
  exclusion: { _id: EXCLUSION, status: 'lifted' },
  run: { type: 'reevaluation', started: true, workflowId: 't-tenant-b-mover-x' },
};

describe('Lift an access review exclusion: HTTP API', () => {
  let app: INestApplication;
  const seenTenants: string[] = [];
  const lifts = {
    lift: jest.fn(async () => {
      seenTenants.push(getCurrentTenantId());
      return LIFTED;
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ReviewExclusionLiftController],
      providers: [
        { provide: ReviewExclusionLiftService, useValue: lifts },
        { provide: APP_GUARD, useClass: TestAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    const correlation = new CorrelationMiddleware();
    app.use((req: Request, res: Response, next: NextFunction) =>
      (correlation as NestMiddleware).use(req, res, next),
    );
    app.useGlobalFilters(...globalExceptionFilters(app.get(HttpAdapterHost)));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    seenTenants.length = 0;
  });

  const as = (roles: string, tenant = 'tenant-a') => ({
    'x-test-roles': roles,
    'x-test-tenant': tenant,
  });

  it.each(['viewer', 'operator', 'connector-admin'])('%s gets 403', async (role) => {
    await request(app.getHttpServer()).post(LIFT).set(as(role)).send({}).expect(403);
    expect(lifts.lift).not.toHaveBeenCalled();
  });

  it.each(['policy-admin', 'super-admin'])('%s lifts, audited as the token user', async (role) => {
    const res = await request(app.getHttpServer())
      .post(LIFT)
      .set(as(role, 'tenant-b'))
      .send({})
      .expect(200);

    expect(res.body).toEqual(LIFTED);
    expect(lifts.lift).toHaveBeenCalledWith(ID, EXCLUSION, 'admin@tenant-b.example');
    expect(seenTenants).toEqual(['tenant-b']);
  });

  it.each([
    ['a body naming the actor', { liftedBy: 'someone@else.example' }],
    ['a body naming the tenant', { tenantId: 'tenant-b' }],
  ])('rejects %s with 400', async (_label, body) => {
    await request(app.getHttpServer()).post(LIFT).set(as('policy-admin')).send(body).expect(400);
    expect(lifts.lift).not.toHaveBeenCalled();
  });

  it.each([
    ['identity', `/identity/not-an-id/access/review-exclusions/${EXCLUSION}/lift`],
    ['exclusion', `/identity/${ID}/access/review-exclusions/not-an-id/lift`],
  ])('rejects an %s id that is not an ObjectId with 400', async (_label, path) => {
    await request(app.getHttpServer()).post(path).set(as('policy-admin')).send({}).expect(400);
    expect(lifts.lift).not.toHaveBeenCalled();
  });
});
