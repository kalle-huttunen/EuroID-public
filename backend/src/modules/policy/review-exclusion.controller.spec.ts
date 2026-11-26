/**
 * HTTP contract of access review exclusions (RolesGuard with the role hierarchy): an identity's
 * exclusions and the counts per policy for every console role (viewer and above, as the Access
 * tab and the policy list), in the authenticated user's tenant. The lift has its own spec
 * (modules/mover/review-exclusion-lift.controller.spec.ts).
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
import { ReviewExclusionController } from './review-exclusion.controller';
import { ReviewExclusionService } from './review-exclusion.service';

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
const LIST = `/identity/${ID}/access/review-exclusions`;
const COUNTS = '/policy/review-exclusions/counts';

describe('Access review exclusions HTTP API', () => {
  let app: INestApplication;
  const seenTenants: string[] = [];
  const exclusions = {
    listActive: jest.fn(async (identityId: string) => {
      seenTenants.push(getCurrentTenantId());
      return { identityId, exclusions: [] };
    }),
    countsByPolicy: jest.fn(async () => {
      seenTenants.push(getCurrentTenantId());
      return [{ policyId: 'pol-1', policyName: 'Sales baseline', active: 2, lifted: 1 }];
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ReviewExclusionController],
      providers: [
        { provide: ReviewExclusionService, useValue: exclusions },
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

  it('a viewer reads exclusions and the counts per policy, in its tenant', async () => {
    const server = app.getHttpServer();
    await request(server).get(LIST).set(as('viewer', 'tenant-b')).expect(200, {
      identityId: ID,
      exclusions: [],
    });
    const counts = await request(server).get(COUNTS).set(as('viewer', 'tenant-b')).expect(200);

    expect(counts.body).toEqual({
      counts: [{ policyId: 'pol-1', policyName: 'Sales baseline', active: 2, lifted: 1 }],
    });
    expect(exclusions.listActive).toHaveBeenCalledWith(ID);
    expect(seenTenants).toEqual(['tenant-b', 'tenant-b']);
  });

  it('rejects an identity id that is not an ObjectId with 400', async () => {
    await request(app.getHttpServer())
      .get('/identity/not-an-id/access/review-exclusions')
      .set(as('viewer'))
      .expect(400);
    expect(exclusions.listActive).not.toHaveBeenCalled();
  });
});
