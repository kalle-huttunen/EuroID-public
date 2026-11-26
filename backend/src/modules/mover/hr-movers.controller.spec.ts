/**
 * HTTP contract of the HR mover endpoints: policy-admin and super-admin only (RolesGuard, with
 * the role hierarchy), the tenant and the audited actor from the authenticated user (never the
 * body), and Zod validation at the gate.
 */
import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  INestApplication,
  Injectable,
  NestMiddleware,
  NotFoundException,
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
import { HrMoversController } from './hr-movers.controller';
import { HrMoverBatchService } from './hr-mover-batch.service';
import { HrMoverPolicyService } from './hr-mover-policy.service';
import { defaultMoverPolicy } from './hr-mover-policy.defaults';

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

const BATCH_ID = '64b7f0c2a1b2c3d4e5f60718';
const validPolicy = { massMoverMaxCount: 30, massMoverMaxPercent: 10, massMoverMinCount: 5 };

describe('HR movers HTTP API', () => {
  let app: INestApplication;
  /** Tenant each service call ran in (from AsyncLocalStorage). */
  const seenTenants: string[] = [];
  const batches = {
    list: jest.fn(async () => {
      seenTenants.push(getCurrentTenantId());
      return [];
    }),
    approve: jest.fn(async (id: string, actor: string) => {
      seenTenants.push(getCurrentTenantId());
      return { id, status: 'approved', decidedBy: actor };
    }),
    reject: jest.fn(async (id: string, actor: string) => {
      seenTenants.push(getCurrentTenantId());
      return { id, status: 'rejected', decidedBy: actor };
    }),
  };
  const policy = {
    getPolicy: jest.fn(async () => {
      seenTenants.push(getCurrentTenantId());
      return { ...defaultMoverPolicy(), configured: false };
    }),
    updatePolicy: jest.fn(async (dto: object, actor: string) => {
      seenTenants.push(getCurrentTenantId());
      return { ...dto, configured: true, updatedBy: actor };
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HrMoversController],
      providers: [
        { provide: HrMoverBatchService, useValue: batches },
        { provide: HrMoverPolicyService, useValue: policy },
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

  describe('roles', () => {
    it.each(['viewer', 'operator', 'connector-admin'])(
      '%s gets 403 on every route',
      async (role) => {
        const server = app.getHttpServer();
        await request(server).get('/movers/batches').set(as(role)).expect(403);
        await request(server).post(`/movers/batches/${BATCH_ID}/approve`).set(as(role)).expect(403);
        await request(server).post(`/movers/batches/${BATCH_ID}/reject`).set(as(role)).expect(403);
        await request(server).get('/movers/policy').set(as(role)).expect(403);
        await request(server).put('/movers/policy').set(as(role)).send(validPolicy).expect(403);
        expect(batches.list).not.toHaveBeenCalled();
        expect(batches.approve).not.toHaveBeenCalled();
        expect(batches.reject).not.toHaveBeenCalled();
        expect(policy.updatePolicy).not.toHaveBeenCalled();
      },
    );

    it.each(['policy-admin', 'super-admin'])(
      '%s may list, decide and read the policy',
      async (role) => {
        const server = app.getHttpServer();
        await request(server).get('/movers/batches').set(as(role)).expect(200);
        await request(server).post(`/movers/batches/${BATCH_ID}/approve`).set(as(role)).expect(200);
        await request(server).get('/movers/policy').set(as(role)).expect(200);
      },
    );
  });

  describe('tenant and actor come from the authenticated user', () => {
    it('approve runs in the token tenant and records the token user', async () => {
      const res = await request(app.getHttpServer())
        .post(`/movers/batches/${BATCH_ID}/approve`)
        .set(as('policy-admin', 'tenant-b'))
        .send({ comment: 'Reorganisation confirmed by HR' })
        .expect(200);

      expect(batches.approve).toHaveBeenCalledWith(
        BATCH_ID,
        'admin@tenant-b.example',
        'Reorganisation confirmed by HR',
      );
      expect(seenTenants).toEqual(['tenant-b']);
      expect(res.body.decidedBy).toBe('admin@tenant-b.example');
    });

    it('reject records the token user and the comment', async () => {
      await request(app.getHttpServer())
        .post(`/movers/batches/${BATCH_ID}/reject`)
        .set(as('super-admin', 'tenant-c'))
        .send({ comment: 'Broken export' })
        .expect(200);
      expect(batches.reject).toHaveBeenCalledWith(
        BATCH_ID,
        'admin@tenant-c.example',
        'Broken export',
      );
      expect(seenTenants).toEqual(['tenant-c']);
    });

    it('a body cannot name the actor or the tenant (400, nothing decided)', async () => {
      await request(app.getHttpServer())
        .post(`/movers/batches/${BATCH_ID}/approve`)
        .set(as('policy-admin'))
        .send({ decidedBy: 'someone-else', tenantId: 'tenant-b' })
        .expect(400);
      expect(batches.approve).not.toHaveBeenCalled();
    });

    it('lists batches in the token tenant with the status filter', async () => {
      await request(app.getHttpServer())
        .get('/movers/batches?status=pending')
        .set(as('policy-admin', 'tenant-c'))
        .expect(200);
      expect(batches.list).toHaveBeenCalledWith('pending');
      expect(seenTenants).toEqual(['tenant-c']);
    });

    it('passes a decided batch through as 409 and another tenant batch as 404', async () => {
      batches.approve.mockRejectedValueOnce(
        new ConflictException('Mover batch was already decided'),
      );
      await request(app.getHttpServer())
        .post(`/movers/batches/${BATCH_ID}/approve`)
        .set(as('policy-admin'))
        .expect(409);
      batches.reject.mockRejectedValueOnce(new NotFoundException('Mover batch not found'));
      await request(app.getHttpServer())
        .post(`/movers/batches/${BATCH_ID}/reject`)
        .set(as('policy-admin'))
        .expect(404);
    });
  });

  describe('policy validation', () => {
    it('stores a valid policy as the token user in the token tenant', async () => {
      await request(app.getHttpServer())
        .put('/movers/policy')
        .set(as('policy-admin', 'tenant-b'))
        .send(validPolicy)
        .expect(200);
      expect(policy.updatePolicy).toHaveBeenCalledWith(validPolicy, 'admin@tenant-b.example');
      expect(seenTenants).toEqual(['tenant-b']);
    });

    it.each([
      ['a percentage above 100', { massMoverMaxPercent: 150 }],
      ['a negative count', { massMoverMaxCount: -1 }],
      ['a fractional floor', { massMoverMinCount: 1.5 }],
      ['a floor above the count limit', { massMoverMaxCount: 4, massMoverMinCount: 5 }],
      ['an extra field', { tenantId: 'tenant-b' }],
    ])('rejects %s with 400', async (_label, change) => {
      await request(app.getHttpServer())
        .put('/movers/policy')
        .set(as('policy-admin'))
        .send({ ...validPolicy, ...change })
        .expect(400);
      expect(policy.updatePolicy).not.toHaveBeenCalled();
    });

    it('rejects an unknown batch status filter', async () => {
      await request(app.getHttpServer())
        .get('/movers/batches?status=everything')
        .set(as('policy-admin'))
        .expect(400);
      expect(batches.list).not.toHaveBeenCalled();
    });
  });
});
