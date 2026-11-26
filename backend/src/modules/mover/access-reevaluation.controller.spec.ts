/**
 * HTTP contract of the access preview and re-evaluation: the preview is a read (viewer and up),
 * the re-evaluation a write like the other identity write actions (operator and up); the tenant
 * and the audited actor come from the authenticated user, never from the body.
 */
import {
  CanActivate,
  ConflictException,
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
import { AccessReevaluationController } from './access-reevaluation.controller';
import { AccessReevaluationService } from './access-reevaluation.service';

/** Stand-in for JwtAuthGuard: the caller's roles and tenant come from its (trusted) token. */
@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const tenantId = String(req.headers['x-test-tenant'] ?? 'tenant-a');
    req.user = {
      sub: 'user-1',
      email: `ops@${tenantId}.example`,
      roles: String(req.headers['x-test-roles'] ?? '').split(','),
      tenantId,
    };
    return true;
  }
}

const IDENTITY_ID = '64b7f0c2a1b2c3d4e5f60720';

describe('Access preview and re-evaluation HTTP API', () => {
  let app: INestApplication;
  const seenTenants: string[] = [];
  const service = {
    preview: jest.fn(async (id: string) => {
      seenTenants.push(getCurrentTenantId());
      return { identityId: id, toAdd: [], toRemove: [] };
    }),
    reevaluate: jest.fn(async () => {
      seenTenants.push(getCurrentTenantId());
      return { workflowId: 'wf-1', changedFields: ['departmentName'] };
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AccessReevaluationController],
      providers: [
        { provide: AccessReevaluationService, useValue: service },
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
  const preview = () => request(app.getHttpServer()).get(`/identity/${IDENTITY_ID}/access/preview`);
  const reevaluate = () =>
    request(app.getHttpServer()).post(`/identity/${IDENTITY_ID}/access/re-evaluate`);

  it('a viewer may preview, in the token tenant', async () => {
    await preview().set(as('viewer', 'tenant-b')).expect(200);
    expect(service.preview).toHaveBeenCalledWith(IDENTITY_ID);
    expect(seenTenants).toEqual(['tenant-b']);
  });

  it('a viewer may not re-evaluate (403, nothing started)', async () => {
    await reevaluate().set(as('viewer')).expect(403);
    expect(service.reevaluate).not.toHaveBeenCalled();
  });

  it.each(['operator', 'super-admin'])(
    '%s re-evaluates in the token tenant with the token user as actor',
    async (role) => {
      const res = await reevaluate().set(as(role, 'tenant-c')).expect(202);
      expect(res.body).toEqual({ workflowId: 'wf-1', changedFields: ['departmentName'] });
      expect(service.reevaluate).toHaveBeenCalledWith(IDENTITY_ID, 'ops@tenant-c.example');
      expect(seenTenants).toEqual(['tenant-c']);
    },
  );

  it('a body cannot name the actor or the tenant (400, nothing started)', async () => {
    await reevaluate()
      .set(as('operator'))
      .send({ actor: 'someone-else', tenantId: 'tenant-b' })
      .expect(400);
    expect(service.reevaluate).not.toHaveBeenCalled();
  });

  it('refuses an id that is not an ObjectId', async () => {
    await request(app.getHttpServer())
      .post('/identity/not-an-id/access/re-evaluate')
      .set(as('operator'))
      .expect(400);
    expect(service.reevaluate).not.toHaveBeenCalled();
  });

  it('passes a conflict (no baseline, run in progress) through as 409', async () => {
    service.reevaluate.mockRejectedValueOnce(
      new ConflictException('A mover run for this identity is already in progress.'),
    );
    await reevaluate().set(as('operator')).expect(409);
  });
});
