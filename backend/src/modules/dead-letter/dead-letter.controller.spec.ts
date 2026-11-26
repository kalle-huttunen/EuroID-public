/**
 * HTTP contract of the dead-letter endpoints, which the Dead-letter queue page mirrors: an
 * operator (or any role above it) may list, read and dismiss; only a super-admin may retry or
 * replay. The tenant and the actor come from the authenticated user; list filters are validated
 * with Zod at the gate.
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
import { DeadLetterController } from './dead-letter.controller';
import { DeadLetterService } from './dead-letter.service';

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

const ENTRY_ID = '64b7f0c2a1b2c3d4e5f60720';

describe('Dead-letter HTTP API', () => {
  let app: INestApplication;
  /** Tenant each service call ran in (from AsyncLocalStorage). */
  const seenTenants: string[] = [];
  const track = <T>(value: T) =>
    jest.fn(async () => {
      seenTenants.push(getCurrentTenantId());
      return value;
    });
  const service = {
    findAll: track([]),
    findOne: track({ _id: ENTRY_ID }),
    getStats: track({ pending: 1 }),
    dismiss: track(undefined),
    replay: track({ id: ENTRY_ID, status: 'replayed', retryCount: 0, maxRetries: 3 }),
    retryEntry: track({ id: ENTRY_ID, status: 'replayed', retryCount: 0, maxRetries: 3 }),
    batchRetry: track({ processed: 0, replayed: 0, failed: 0 }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DeadLetterController],
      providers: [
        { provide: DeadLetterService, useValue: service },
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
    it('a viewer gets 403 on every route', async () => {
      const server = app.getHttpServer();
      await request(server).get('/dead-letter').set(as('viewer')).expect(403);
      await request(server).get('/dead-letter/stats').set(as('viewer')).expect(403);
      await request(server).get(`/dead-letter/${ENTRY_ID}`).set(as('viewer')).expect(403);
      await request(server).post(`/dead-letter/${ENTRY_ID}/dismiss`).set(as('viewer')).expect(403);
      await request(server).post(`/dead-letter/${ENTRY_ID}/retry`).set(as('viewer')).expect(403);
      await request(server).post(`/dead-letter/${ENTRY_ID}/replay`).set(as('viewer')).expect(403);
      expect(service.findAll).not.toHaveBeenCalled();
      expect(service.dismiss).not.toHaveBeenCalled();
    });

    it.each(['operator', 'connector-admin', 'policy-admin'])(
      '%s may list, read and dismiss, but not retry or replay',
      async (role) => {
        const server = app.getHttpServer();
        await request(server).get('/dead-letter').set(as(role)).expect(200);
        await request(server).get('/dead-letter/stats').set(as(role)).expect(200);
        await request(server).get(`/dead-letter/${ENTRY_ID}`).set(as(role)).expect(200);
        await request(server).post(`/dead-letter/${ENTRY_ID}/dismiss`).set(as(role)).expect(201);
        await request(server).post(`/dead-letter/${ENTRY_ID}/retry`).set(as(role)).expect(403);
        await request(server).post(`/dead-letter/${ENTRY_ID}/replay`).set(as(role)).expect(403);
        await request(server).post('/dead-letter/batch-retry').set(as(role)).expect(403);
        expect(service.retryEntry).not.toHaveBeenCalled();
        expect(service.replay).not.toHaveBeenCalled();
        expect(service.batchRetry).not.toHaveBeenCalled();
      },
    );

    it('a super-admin may retry and replay, recorded as the token user in the token tenant', async () => {
      const server = app.getHttpServer();
      await request(server)
        .post(`/dead-letter/${ENTRY_ID}/retry`)
        .set(as('super-admin', 'tenant-b'))
        .expect(201);
      await request(server)
        .post(`/dead-letter/${ENTRY_ID}/replay`)
        .set(as('super-admin', 'tenant-b'))
        .expect(201);

      expect(service.retryEntry).toHaveBeenCalledWith(ENTRY_ID, 'admin@tenant-b.example');
      expect(service.replay).toHaveBeenCalledWith(ENTRY_ID, 'admin@tenant-b.example');
      expect(seenTenants).toEqual(['tenant-b', 'tenant-b']);
    });
  });

  describe('retry and replay outcomes (2.0cu)', () => {
    it('answers the real outcome of a retry: success only when the entry was replayed', async () => {
      const server = app.getHttpServer();
      const replayed = await request(server)
        .post(`/dead-letter/${ENTRY_ID}/retry`)
        .set(as('super-admin'))
        .expect(201);
      expect(replayed.body).toEqual({
        success: true,
        id: ENTRY_ID,
        status: 'replayed',
        retryCount: 0,
        maxRetries: 3,
      });

      service.retryEntry.mockImplementationOnce(async () => ({
        id: ENTRY_ID,
        status: 'pending',
        retryCount: 1,
        maxRetries: 3,
        error: 'handler still failing',
      }));
      const failed = await request(server)
        .post(`/dead-letter/${ENTRY_ID}/retry`)
        .set(as('super-admin'))
        .expect(201);
      expect(failed.body).toEqual({
        success: false,
        id: ENTRY_ID,
        status: 'pending',
        retryCount: 1,
        maxRetries: 3,
        error: 'handler still failing',
      });
    });

    it('answers a failed replay with success false and the entry still pending', async () => {
      service.replay.mockImplementationOnce(async () => ({
        id: ENTRY_ID,
        status: 'pending',
        retryCount: 0,
        maxRetries: 3,
        error: 'still failing',
      }));

      const res = await request(app.getHttpServer())
        .post(`/dead-letter/${ENTRY_ID}/replay`)
        .set(as('super-admin'))
        .expect(201);

      expect(res.body).toMatchObject({ success: false, status: 'pending', error: 'still failing' });
    });

    it('passes the 409 of an entry with nothing to re-run to the caller', async () => {
      service.retryEntry.mockImplementationOnce(async () => {
        throw new ConflictException(
          `Dead-letter entry ${ENTRY_ID} (workflow_terminal) carries no domain event, so there is nothing to re-run.`,
        );
      });

      const res = await request(app.getHttpServer())
        .post(`/dead-letter/${ENTRY_ID}/retry`)
        .set(as('super-admin'))
        .expect(409);

      expect(JSON.stringify(res.body)).toContain('nothing to re-run');
    });
  });

  describe('list filters', () => {
    it('passes status, type, a trimmed source prefix and the page to the service', async () => {
      await request(app.getHttpServer())
        .get('/dead-letter')
        .query({
          status: 'pending',
          type: 'event_handler_failure',
          source: ' webhook: ',
          limit: '21',
          offset: '20',
        })
        .set(as('operator', 'tenant-c'))
        .expect(200);

      expect(service.findAll).toHaveBeenCalledWith({
        status: 'pending',
        type: 'event_handler_failure',
        source: 'webhook:',
        limit: 21,
        offset: 20,
      });
      expect(seenTenants).toEqual(['tenant-c']);
    });

    it('treats an empty source as no filter', async () => {
      await request(app.getHttpServer())
        .get('/dead-letter')
        .query({ source: '' })
        .set(as('operator'))
        .expect(200);

      expect(service.findAll).toHaveBeenCalledWith(expect.objectContaining({ source: undefined }));
    });

    it.each([
      ['an unknown status', { status: 'all' }],
      ['an unknown type', { type: 'anything' }],
      ['a repeated status', 'status=pending&status=dismissed'],
      ['a source over 200 characters', { source: 'x'.repeat(201) }],
      // skip(NaN) reached the driver, which failed: a 500 (r2-05, 05 F18)
      ['an offset that is no number', { offset: 'abc' }],
      ['a negative offset', { offset: '-5' }],
    ])('rejects %s with 400', async (_label, query) => {
      await request(app.getHttpServer())
        .get('/dead-letter')
        .query(query)
        .set(as('operator'))
        .expect(400);
      expect(service.findAll).not.toHaveBeenCalled();
    });
  });
});
