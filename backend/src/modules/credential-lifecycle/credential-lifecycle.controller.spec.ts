/**
 * HTTP contract of the credential lifecycle endpoints, which the Credential lifecycle page mirrors:
 * an operator (or a role above it) reads the inventory and the expiring list; the compliance
 * summary and the policies need policy-admin. The tenant comes from the token; queries are
 * validated with Zod at the gate (400 with the field path).
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
import { CredentialLifecycleController } from './credential-lifecycle.controller';
import { CredentialInventoryService } from './credential-inventory.service';
import { CredentialPolicyService } from './credential-policy.service';

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

const ROW = {
  _id: '64b7f0c2a1b2c3d4e5f60901',
  identityId: '64b7f0c2a1b2c3d4e5f60111',
  targetSystem: 'ad',
  externalId: 'CN=svc-backup,OU=Service',
  password: {
    status: 'UNKNOWN',
    statusReason: 'Active Directory is not configured for this tenant',
  },
};

describe('Credential lifecycle HTTP API', () => {
  let app: INestApplication;
  const seenTenants: string[] = [];
  const track = <T>(value: T) =>
    jest.fn(async () => {
      seenTenants.push(getCurrentTenantId());
      return value;
    });
  const inventory = {
    findByStatus: track([ROW]),
    findByIdentity: track([ROW]),
    findExpiring: track([]),
    getComplianceSummary: track({
      compliant: 0,
      expiringSoon: 0,
      expired: 0,
      unknown: 1,
      total: 1,
    }),
  };
  const policies = { findAll: track([]) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CredentialLifecycleController],
      providers: [
        { provide: CredentialInventoryService, useValue: inventory },
        { provide: CredentialPolicyService, useValue: policies },
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

  describe('GET /credential-lifecycle/inventory?status= (credentials in one status)', () => {
    it('lists an operator the rows in that status, in the token tenant', async () => {
      const res = await request(app.getHttpServer())
        .get('/credential-lifecycle/inventory')
        .query({ status: 'UNKNOWN' })
        .set(as('operator', 'tenant-b'))
        .expect(200);

      expect(res.body).toEqual([ROW]);
      expect(inventory.findByStatus).toHaveBeenCalledWith('tenant-b', 'UNKNOWN', 100);
      expect(seenTenants).toEqual(['tenant-b']);
    });

    it('takes a limit up to 1000', async () => {
      await request(app.getHttpServer())
        .get('/credential-lifecycle/inventory')
        .query({ status: 'EXPIRED', limit: '250' })
        .set(as('policy-admin'))
        .expect(200);

      expect(inventory.findByStatus).toHaveBeenCalledWith('tenant-a', 'EXPIRED', 250);
    });

    it('answers 400 for a missing or unknown status and a limit out of range', async () => {
      const server = app.getHttpServer();
      const missing = await request(server)
        .get('/credential-lifecycle/inventory')
        .set(as('operator'))
        .expect(400);
      expect(JSON.stringify(missing.body.message)).toContain('status');
      await request(server)
        .get('/credential-lifecycle/inventory')
        .query({ status: 'ROTATED' })
        .set(as('operator'))
        .expect(400);
      await request(server)
        .get('/credential-lifecycle/inventory')
        .query({ status: 'UNKNOWN', limit: '5000' })
        .set(as('operator'))
        .expect(400);
      expect(inventory.findByStatus).not.toHaveBeenCalled();
    });

    it('refuses a viewer', async () => {
      await request(app.getHttpServer())
        .get('/credential-lifecycle/inventory')
        .query({ status: 'UNKNOWN' })
        .set(as('viewer'))
        .expect(403);
      expect(inventory.findByStatus).not.toHaveBeenCalled();
    });

    it('leaves a person’s credentials at /inventory/:identityId', async () => {
      await request(app.getHttpServer())
        .get(`/credential-lifecycle/inventory/${ROW.identityId}`)
        .set(as('operator'))
        .expect(200);
      expect(inventory.findByIdentity).toHaveBeenCalledWith('tenant-a', ROW.identityId);
      expect(inventory.findByStatus).not.toHaveBeenCalled();
    });
  });

  // The page shows the summary and the policies to policy-admins only.
  it('keeps the compliance summary and the policies from an operator', async () => {
    const server = app.getHttpServer();
    await request(server).get('/credential-lifecycle/compliance').set(as('operator')).expect(403);
    await request(server).get('/credential-lifecycle/policies').set(as('operator')).expect(403);
    await request(server)
      .get('/credential-lifecycle/compliance')
      .set(as('policy-admin'))
      .expect(200);
    await request(server).get('/credential-lifecycle/policies').set(as('policy-admin')).expect(200);
  });
});
