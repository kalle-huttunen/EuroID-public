/**
 * HTTP contract of the leaver endpoints: policy-admin and super-admin only (RolesGuard, with the
 * role hierarchy), the tenant and the audited actor from the authenticated user (never the body),
 * and Zod validation at the gate.
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
import { LeaversController } from './leavers.controller';
import { LeaverBatchService } from './leaver-batch.service';
import { LeaverPolicyService } from './leaver-policy.service';
import { LeaverManualRemovalService } from './leaver-manual-removal.service';
import { defaultLeaverPolicy } from './leaver-policy.defaults';

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
const WORKFLOW_ID = 't-tenant-a-offboard-64b7f0c2a1b2c3d4e5f60719';
const validPolicy = { ...defaultLeaverPolicy(), timezone: 'Europe/Helsinki' };

describe('Leavers HTTP API', () => {
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
  const manualRemoval = {
    listOpen: jest.fn(async () => {
      seenTenants.push(getCurrentTenantId());
      return [];
    }),
    markRemoved: jest.fn(async (workflowId: string) => {
      seenTenants.push(getCurrentTenantId());
      return { workflowId };
    }),
  };
  const policy = {
    getPolicy: jest.fn(async () => ({ ...defaultLeaverPolicy(), configured: false })),
    updatePolicy: jest.fn(async (dto: object, actor: string) => {
      seenTenants.push(getCurrentTenantId());
      return { ...dto, configured: true, updatedBy: actor };
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LeaversController],
      providers: [
        { provide: LeaverBatchService, useValue: batches },
        { provide: LeaverPolicyService, useValue: policy },
        { provide: LeaverManualRemovalService, useValue: manualRemoval },
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
        await request(server).get('/leavers/batches').set(as(role)).expect(403);
        await request(server)
          .post(`/leavers/batches/${BATCH_ID}/approve`)
          .set(as(role))
          .expect(403);
        await request(server).post(`/leavers/batches/${BATCH_ID}/reject`).set(as(role)).expect(403);
        await request(server).get('/leavers/policy').set(as(role)).expect(403);
        await request(server).put('/leavers/policy').set(as(role)).send(validPolicy).expect(403);
        await request(server).get('/leavers/open-offboardings').set(as(role)).expect(403);
        await request(server)
          .post(`/leavers/offboardings/${WORKFLOW_ID}/removed-manually`)
          .set(as(role))
          .send({ system: 'github', reason: 'removed in GitHub' })
          .expect(403);
        expect(batches.approve).not.toHaveBeenCalled();
        expect(policy.updatePolicy).not.toHaveBeenCalled();
        expect(manualRemoval.markRemoved).not.toHaveBeenCalled();
      },
    );

    it.each(['policy-admin', 'super-admin'])('%s may list and decide', async (role) => {
      await request(app.getHttpServer()).get('/leavers/batches').set(as(role)).expect(200);
      await request(app.getHttpServer())
        .post(`/leavers/batches/${BATCH_ID}/approve`)
        .set(as(role))
        .expect(200);
    });
  });

  describe('tenant and actor come from the authenticated user', () => {
    it('approve runs in the token tenant and records the token user', async () => {
      const res = await request(app.getHttpServer())
        .post(`/leavers/batches/${BATCH_ID}/approve`)
        .set(as('policy-admin', 'tenant-b'))
        .send({ comment: 'HR confirmed the list' })
        .expect(200);

      expect(batches.approve).toHaveBeenCalledWith(
        BATCH_ID,
        'admin@tenant-b.example',
        'HR confirmed the list',
      );
      expect(seenTenants).toEqual(['tenant-b']);
      expect(res.body.decidedBy).toBe('admin@tenant-b.example');
    });

    it('a body cannot name the actor or the tenant (400, nothing decided)', async () => {
      await request(app.getHttpServer())
        .post(`/leavers/batches/${BATCH_ID}/reject`)
        .set(as('policy-admin'))
        .send({ decidedBy: 'someone-else', tenantId: 'tenant-b' })
        .expect(400);
      expect(batches.reject).not.toHaveBeenCalled();
    });

    it('reject records the token user and the comment', async () => {
      await request(app.getHttpServer())
        .post(`/leavers/batches/${BATCH_ID}/reject`)
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

    it('passes a decided batch conflict through as 409', async () => {
      batches.approve.mockRejectedValueOnce(
        new ConflictException('Leaver batch was already decided'),
      );
      await request(app.getHttpServer())
        .post(`/leavers/batches/${BATCH_ID}/approve`)
        .set(as('policy-admin'))
        .expect(409);
    });
  });

  describe('removed manually', () => {
    it('closes the target as the token user in the token tenant, with the note', async () => {
      await request(app.getHttpServer())
        .post(`/leavers/offboardings/${WORKFLOW_ID}/removed-manually`)
        .set(as('policy-admin', 'tenant-b'))
        .send({ system: 'github', reason: '  Removed from the acme org  ' })
        .expect(200);
      expect(manualRemoval.markRemoved).toHaveBeenCalledWith(
        WORKFLOW_ID,
        'github',
        'admin@tenant-b.example',
        'Removed from the acme org',
      );
      expect(seenTenants).toEqual(['tenant-b']);
    });

    it.each([
      ['no reason', { system: 'github' }],
      ['an empty reason', { system: 'github', reason: '   ' }],
      ['no system', { reason: 'gone' }],
      ['a body naming the actor', { system: 'github', reason: 'gone', by: 'someone-else' }],
    ])('rejects %s with 400', async (_label, body) => {
      await request(app.getHttpServer())
        .post(`/leavers/offboardings/${WORKFLOW_ID}/removed-manually`)
        .set(as('policy-admin'))
        .send(body)
        .expect(400);
      expect(manualRemoval.markRemoved).not.toHaveBeenCalled();
    });

    it('rejects an over-long workflow id with 400', async () => {
      await request(app.getHttpServer())
        .post(`/leavers/offboardings/${'x'.repeat(201)}/removed-manually`)
        .set(as('policy-admin'))
        .send({ system: 'github', reason: 'gone' })
        .expect(400);
      expect(manualRemoval.markRemoved).not.toHaveBeenCalled();
    });

    it('passes a target that is not failed through as 409', async () => {
      manualRemoval.markRemoved.mockRejectedValueOnce(
        new ConflictException('github is not a failed target of this offboarding'),
      );
      await request(app.getHttpServer())
        .post(`/leavers/offboardings/${WORKFLOW_ID}/removed-manually`)
        .set(as('policy-admin'))
        .send({ system: 'github', reason: 'gone' })
        .expect(409);
    });

    it('lists open offboardings in the token tenant', async () => {
      await request(app.getHttpServer())
        .get('/leavers/open-offboardings')
        .set(as('super-admin', 'tenant-c'))
        .expect(200);
      expect(seenTenants).toEqual(['tenant-c']);
    });
  });

  describe('validation', () => {
    it('rejects an unknown batch status filter', async () => {
      await request(app.getHttpServer())
        .get('/leavers/batches?status=everything')
        .set(as('policy-admin'))
        .expect(400);
    });

    it('stores a valid policy as the token user', async () => {
      await request(app.getHttpServer())
        .put('/leavers/policy')
        .set(as('policy-admin', 'tenant-b'))
        .send(validPolicy)
        .expect(200);
      expect(policy.updatePolicy).toHaveBeenCalledWith(validPolicy, 'admin@tenant-b.example');
      expect(seenTenants).toEqual(['tenant-b']);
    });

    it.each([
      ['an unknown time zone', { timezone: 'Mars/Olympus' }],
      ['a zero miss threshold', { missingSyncThreshold: 0 }],
      ['a percentage above 100', { massLeaverMaxPercent: 150 }],
      ['a floor above the count limit', { massLeaverMaxCount: 1, massLeaverMinCount: 2 }],
      ['no floor', { massLeaverMinCount: undefined }],
      ['no status words', { terminatedStatuses: [] }],
      ['an extra field', { tenantId: 'tenant-b' }],
    ])('rejects %s with 400', async (_label, change) => {
      await request(app.getHttpServer())
        .put('/leavers/policy')
        .set(as('policy-admin'))
        .send({ ...validPolicy, ...change })
        .expect(400);
      expect(policy.updatePolicy).not.toHaveBeenCalled();
    });
  });
});
