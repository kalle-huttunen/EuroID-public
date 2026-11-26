/**
 * HTTP contract of the identity controls and the field mastery read (owner decision 2026-11-24):
 * an override of the department or job title needs a reason (400 without), the actor is the
 * authenticated user, an unknown identity is 404, and the mastery read is open to viewers.
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
import { globalExceptionFilters } from '@shared/filters/global-exception-filters';
import { IdentityControlsController } from './identity-controls.controller';
import { IdentityControlsService } from './identity-controls.service';

/** Stand-in for JwtAuthGuard: the caller's roles and tenant come from its (trusted) token. */
@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    req.user = {
      sub: 'user-1',
      email: 'op@tenant-a.example',
      roles: String(req.headers['x-test-roles'] ?? '').split(','),
      tenantId: 'tenant-a',
    };
    return true;
  }
}

const ID = '64b7f0c2a1b2c3d4e5f60901';
const CONTROLS = `/identity/v2/${ID}/controls`;

describe('Identity controls HTTP API', () => {
  let app: INestApplication;
  const identity = { _id: ID, controls: { manualDepartment: 'R&D' } };
  const controls = {
    updateControls: jest.fn(async () => ({ toObject: () => identity })),
    getMastery: jest.fn(async () => ({
      identityId: ID,
      masteredBy: { departmentName: 'csv-hr' },
      attributeControls: {},
    })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IdentityControlsController],
      providers: [
        { provide: IdentityControlsService, useValue: controls },
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

  beforeEach(() => jest.clearAllMocks());

  const patch = (body: object, roles = 'operator') =>
    request(app.getHttpServer()).patch(CONTROLS).set('x-test-roles', roles).send(body);

  it('sets an override with its reason and expiry, as the authenticated user', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();

    const res = await patch({ manualDepartment: 'R&D', reason: 'Reorg pilot', expiresAt });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, identity });
    expect(controls.updateControls).toHaveBeenCalledWith(
      ID,
      { manualDepartment: 'R&D', reason: 'Reorg pilot', expiresAt },
      'op@tenant-a.example',
    );
  });

  it('answers 400 for an override without a reason, and changes nothing', async () => {
    const res = await patch({ manualJobTitle: 'Lead' });

    expect(res.status).toBe(400);
    expect(res.body.message).toEqual([
      'reason: A reason is required to set manualDepartment or manualJobTitle',
    ]);
    expect(controls.updateControls).not.toHaveBeenCalled();
  });

  it('answers 404 for an identity that does not exist', async () => {
    controls.updateControls.mockResolvedValueOnce(null as never);

    await patch({ isLoginDisabled: true }).expect(404);
  });

  it('refuses a viewer the change, and lets a viewer read who masters the fields', async () => {
    await patch({ isLoginDisabled: true }, 'viewer').expect(403);

    const res = await request(app.getHttpServer())
      .get(`/identity/${ID}/mastery`)
      .set('x-test-roles', 'viewer')
      .expect(200);
    expect(res.body.masteredBy).toEqual({ departmentName: 'csv-hr' });
  });
});
