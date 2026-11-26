/**
 * HTTP contract of the expired-access admin actions (RolesGuard with the role hierarchy): retry
 * for operator and above; removed manually for policy-admin and super-admin, like closing a
 * failed offboarding target, since it asserts a removal EuroID cannot verify. The tenant and the
 * audited actor come from the authenticated user (never the body); Zod validation at the gate.
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
import { IdentityAccessExpiryController } from './identity-access-expiry.controller';
import { IdentityAccessExpiryService } from './identity-access-expiry.service';

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

const ID = '64b7f0c2a1b2c3d4e5f60718';
const RETRY = `/identity/${ID}/access/expiry/retry`;
const REMOVED = `/identity/${ID}/access/expiry/removed-manually`;

describe('Expired access HTTP API', () => {
  let app: INestApplication;
  const seenTenants: string[] = [];
  const expiry = {
    retry: jest.fn(async (_id: string, targetSystem: string) => {
      seenTenants.push(getCurrentTenantId());
      return { targetSystem, status: 'SYNCED' };
    }),
    markRemovedManually: jest.fn(async (_id: string, targetSystem: string) => {
      seenTenants.push(getCurrentTenantId());
      return { targetSystem, status: 'DEPROVISIONED' };
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IdentityAccessExpiryController],
      providers: [
        { provide: IdentityAccessExpiryService, useValue: expiry },
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

  it('a viewer gets 403 on both actions', async () => {
    const server = app.getHttpServer();
    await request(server).post(RETRY).set(as('viewer')).send({ targetSystem: 'okta' }).expect(403);
    await request(server)
      .post(REMOVED)
      .set(as('viewer'))
      .send({ targetSystem: 'okta', reason: 'gone' })
      .expect(403);
    expect(expiry.retry).not.toHaveBeenCalled();
    expect(expiry.markRemovedManually).not.toHaveBeenCalled();
  });

  it.each(['operator', 'policy-admin', 'super-admin'])('%s may retry', async (role) => {
    await request(app.getHttpServer())
      .post(RETRY)
      .set(as(role))
      .send({ targetSystem: 'okta' })
      .expect(200);
  });

  it.each(['operator', 'connector-admin'])('%s gets 403 on removed manually', async (role) => {
    await request(app.getHttpServer())
      .post(REMOVED)
      .set(as(role))
      .send({ targetSystem: 'okta', reason: 'gone' })
      .expect(403);
    expect(expiry.markRemovedManually).not.toHaveBeenCalled();
  });

  it.each(['policy-admin', 'super-admin'])('%s may close as removed manually', async (role) => {
    await request(app.getHttpServer())
      .post(REMOVED)
      .set(as(role))
      .send({ targetSystem: 'okta', reason: 'gone' })
      .expect(200);
  });

  it('retry runs in the token tenant and records the token user', async () => {
    const res = await request(app.getHttpServer())
      .post(RETRY)
      .set(as('operator', 'tenant-b'))
      .send({ targetSystem: ' okta ' })
      .expect(200);
    expect(res.body).toEqual({ targetSystem: 'okta', status: 'SYNCED' });
    expect(expiry.retry).toHaveBeenCalledWith(ID, 'okta', 'admin@tenant-b.example');
    expect(seenTenants).toEqual(['tenant-b']);
  });

  it('removed manually records the token user and the trimmed note', async () => {
    await request(app.getHttpServer())
      .post(REMOVED)
      .set(as('policy-admin', 'tenant-b'))
      .send({ targetSystem: 'okta', reason: '  Deactivated in the Okta console  ' })
      .expect(200);
    expect(expiry.markRemovedManually).toHaveBeenCalledWith(
      ID,
      'okta',
      'admin@tenant-b.example',
      'Deactivated in the Okta console',
    );
    expect(seenTenants).toEqual(['tenant-b']);
  });

  it.each([
    [RETRY, 'no target system', {}],
    [RETRY, 'a body naming the tenant', { targetSystem: 'okta', tenantId: 'tenant-b' }],
    [REMOVED, 'no reason', { targetSystem: 'okta' }],
    [REMOVED, 'an empty reason', { targetSystem: 'okta', reason: '   ' }],
    [REMOVED, 'a body naming the actor', { targetSystem: 'okta', reason: 'gone', by: 'x' }],
  ])('%s rejects %s with 400', async (path, _label, body) => {
    const role = path === REMOVED ? 'policy-admin' : 'operator';
    await request(app.getHttpServer()).post(path).set(as(role)).send(body).expect(400);
    expect(expiry.retry).not.toHaveBeenCalled();
    expect(expiry.markRemovedManually).not.toHaveBeenCalled();
  });

  it('rejects an identity id that is not an ObjectId with 400', async () => {
    await request(app.getHttpServer())
      .post('/identity/not-an-id/access/expiry/retry')
      .set(as('operator'))
      .send({ targetSystem: 'okta' })
      .expect(400);
    expect(expiry.retry).not.toHaveBeenCalled();
  });
});
