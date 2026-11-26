/**
 * The :id routes of the access request portal take the request's public id (`requestId`, a
 * UUID from randomUUID() in access-request-creation.service.ts), which is what the services look
 * up and what the frontend sends (MyRequests, RequestDetail). The routes validated it as a
 * MongoDB ObjectId, so every detail, approve, reject, cancel and delegate call answered 400
 * "Invalid ID format: <uuid>" and no request could be opened or decided in the UI (browser check
 * of 2026-11-24).
 */
import { INestApplication } from '@nestjs/common';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { globalExceptionFilters } from '@shared/filters/global-exception-filters';
import { RolesGuard } from '@infrastructure/auth/roles.guard';
import { IDENTITY_QUERY_PORT } from '@shared/interfaces/identity-query.port';
import { AccessRequestsController } from './access-requests.controller';
import { AccessRequestsService } from './access-requests.service';
import { AccessRequestManualRemovalService } from './access-request-manual-removal.service';

const REQUEST_ID = '213d3c92-5f0e-4a51-9c3e-8b1f2a7d6e40';
const USER = {
  sub: 'u1',
  email: 'm@example.com',
  name: 'M',
  roles: ['operator'],
  tenantId: 't1',
};

describe('access request :id routes', () => {
  let app: INestApplication;
  const service = {
    getRequestDetail: jest.fn().mockResolvedValue({ requestId: REQUEST_ID }),
    approve: jest.fn().mockResolvedValue(undefined),
    reject: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue(undefined),
    delegate: jest.fn().mockResolvedValue(undefined),
    listMyRequests: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    listRemovalFailing: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  };
  const manualRemoval = {
    markRemovedManually: jest.fn().mockResolvedValue({ requestId: REQUEST_ID, status: 'EXPIRED' }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AccessRequestsController],
      providers: [
        { provide: AccessRequestsService, useValue: service },
        { provide: AccessRequestManualRemovalService, useValue: manualRemoval },
        {
          provide: IDENTITY_QUERY_PORT,
          useValue: { findByEmail: jest.fn().mockResolvedValue({ _id: 'id-m' }) },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = USER;
      next();
    });
    app.useGlobalFilters(...globalExceptionFilters(app.get(HttpAdapterHost)));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  const decision = (d: string) => ({ decision: d, stepIndex: 0, justification: 'ok' });

  it.each([
    ['GET', `/access-requests/${REQUEST_ID}`, undefined, 'getRequestDetail'],
    ['PUT', `/access-requests/${REQUEST_ID}/approve`, decision('approve'), 'approve'],
    ['PUT', `/access-requests/${REQUEST_ID}/reject`, decision('reject'), 'reject'],
    ['PUT', `/access-requests/${REQUEST_ID}/cancel`, undefined, 'cancel'],
    [
      'PUT',
      `/access-requests/${REQUEST_ID}/delegate`,
      { ...decision('approve'), delegateTo: 'd@example.com' },
      'delegate',
    ],
  ] as const)('%s %s reaches the service with the request id', async (method, url, body, fn) => {
    const call =
      method === 'GET'
        ? request(app.getHttpServer()).get(url)
        : request(app.getHttpServer()).put(url);
    const res = body ? await call.send(body) : await call;

    expect(res.status).toBe(200);
    expect(service[fn]).toHaveBeenCalledTimes(1);
    expect(service[fn].mock.calls[0][0]).toBe(REQUEST_ID);
  });

  // The body the console sends (frontend/src/api/access-requests-api.ts delegateRequest): a
  // delegation is no decision, so it carries none. The route parsed DecideAccessRequestSchema,
  // whose `decision` is required, and answered every console delegation 400 (hunt 09 F1).
  it('delegates with the console body, which carries no decision', async () => {
    const res = await request(app.getHttpServer())
      .put(`/access-requests/${REQUEST_ID}/delegate`)
      .send({ stepIndex: 0, delegateTo: 'dave@example.com' });

    expect(res.status).toBe(200);
    expect(service.delegate).toHaveBeenCalledWith(
      REQUEST_ID,
      0,
      'id-m',
      'm@example.com',
      'dave@example.com',
    );
  });

  it.each([
    ['without delegateTo', { stepIndex: 0 }],
    ['with an empty delegateTo', { stepIndex: 0, delegateTo: '  ' }],
    ['without stepIndex', { delegateTo: 'dave@example.com' }],
  ])('refuses a delegation %s with 400', async (_case, body) => {
    const res = await request(app.getHttpServer())
      .put(`/access-requests/${REQUEST_ID}/delegate`)
      .send(body);

    expect(res.status).toBe(400);
    expect(service.delegate).not.toHaveBeenCalled();
  });

  it('answers 400 for an id that is not a request id, without calling the service', async () => {
    const res = await request(app.getHttpServer()).get('/access-requests/not-a-request-id');

    expect(res.status).toBe(400);
    expect(service.getRequestDetail).not.toHaveBeenCalled();
  });

  // Hunt 04 F16: approve, reject and delegate needed the operator role, while MANAGER and OWNER
  // steps go to ordinary employees (viewers), who saw the request and got 403 on deciding it.
  // Who may decide a step is the step's approver (AccessRequestDecisionService), not a role.
  describe('a viewer who is a step’s approver', () => {
    let viewerApp: INestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [AccessRequestsController],
        providers: [
          { provide: AccessRequestsService, useValue: service },
          { provide: AccessRequestManualRemovalService, useValue: manualRemoval },
          {
            provide: IDENTITY_QUERY_PORT,
            useValue: { findByEmail: jest.fn().mockResolvedValue({ _id: 'id-m' }) },
          },
        ],
      }).compile();
      viewerApp = moduleRef.createNestApplication({ logger: false });
      viewerApp.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
        req.user = { ...USER, roles: ['viewer'] };
        next();
      });
      viewerApp.useGlobalGuards(new RolesGuard(viewerApp.get(Reflector)));
      viewerApp.useGlobalFilters(...globalExceptionFilters(viewerApp.get(HttpAdapterHost)));
      await viewerApp.init();
    });

    afterAll(async () => {
      await viewerApp.close();
    });

    it.each([
      ['approve', decision('approve')],
      ['reject', decision('reject')],
      ['delegate', { stepIndex: 0, delegateTo: 'dave@example.com' }],
    ] as const)('reaches %s', async (fn, body) => {
      const res = await request(viewerApp.getHttpServer())
        .put(`/access-requests/${REQUEST_ID}/${fn}`)
        .send(body);

      expect(res.status).toBe(200);
      expect(service[fn]).toHaveBeenCalledTimes(1);
    });
  });
  // HX-E3: an ACTIVE request whose removal keeps failing is closed by a policy-admin who removed
  // the access by hand. Before, nothing but a removal that succeeded could end it.
  describe('POST :id/removed-manually and the detail for a policy-admin', () => {
    const apps: INestApplication[] = [];
    const appWith = async (roles: string[]) => {
      const moduleRef = await Test.createTestingModule({
        controllers: [AccessRequestsController],
        providers: [
          { provide: AccessRequestsService, useValue: service },
          { provide: AccessRequestManualRemovalService, useValue: manualRemoval },
          {
            provide: IDENTITY_QUERY_PORT,
            useValue: { findByEmail: jest.fn().mockResolvedValue({ _id: 'id-m' }) },
          },
        ],
      }).compile();
      const roleApp = moduleRef.createNestApplication({ logger: false });
      roleApp.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
        req.user = { ...USER, roles };
        next();
      });
      roleApp.useGlobalGuards(new RolesGuard(roleApp.get(Reflector)));
      roleApp.useGlobalFilters(...globalExceptionFilters(roleApp.get(HttpAdapterHost)));
      await roleApp.init();
      apps.push(roleApp);
      return roleApp;
    };
    const removedManually = (target: INestApplication, body: unknown) =>
      request(target.getHttpServer())
        .post(`/access-requests/${REQUEST_ID}/removed-manually`)
        .send(body as object);

    afterAll(async () => {
      await Promise.all(apps.map((a) => a.close()));
    });

    it.each([['policy-admin'], ['super-admin']])(
      'lets a %s close it with a note, as the admin of the token',
      async (role) => {
        const res = await removedManually(await appWith([role]), { note: '  removed in Entra  ' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'EXPIRED' });
        expect(manualRemoval.markRemovedManually).toHaveBeenCalledWith(
          REQUEST_ID,
          'm@example.com',
          'removed in Entra',
        );
      },
    );

    it.each([['operator'], ['viewer']])('refuses the %s role with 403', async (role) => {
      const res = await removedManually(await appWith([role]), { note: 'removed' });

      expect(res.status).toBe(403);
      expect(manualRemoval.markRemovedManually).not.toHaveBeenCalled();
    });

    it.each([
      ['without a note', {}],
      ['with an empty note', { note: '   ' }],
      ['with another field', { note: 'removed', by: 'someone@example.com' }],
    ])('refuses a body %s with 400', async (_case, body) => {
      const res = await removedManually(await appWith(['policy-admin']), body);

      expect(res.status).toBe(400);
      expect(manualRemoval.markRemovedManually).not.toHaveBeenCalled();
    });

    // HX-E4: the tenant-wide list of requests whose removal keeps failing, for the admin who
    // closes them by hand
    describe('GET / with removalFailing', () => {
      const list = async (roles: string[], query: string) =>
        request((await appWith(roles)).getHttpServer()).get(`/access-requests?${query}`);

      it.each([['policy-admin'], ['super-admin']])(
        'lists the failing removals of the tenant for a %s',
        async (role) => {
          const res = await list([role], 'removalFailing=true&page=2&limit=10');

          expect(res.status).toBe(200);
          expect(service.listRemovalFailing).toHaveBeenCalledWith({ page: 2, limit: 10 });
          expect(service.listMyRequests).not.toHaveBeenCalled();
        },
      );

      it.each([['operator'], ['viewer']])('refuses the %s role with 403', async (role) => {
        const res = await list([role], 'removalFailing=true');

        expect(res.status).toBe(403);
        expect(service.listRemovalFailing).not.toHaveBeenCalled();
      });

      it('refuses a value other than true or false with 400', async () => {
        const res = await list(['policy-admin'], 'removalFailing=yes');

        expect(res.status).toBe(400);
        expect(service.listRemovalFailing).not.toHaveBeenCalled();
      });

      it("lists only the caller's own requests without it, or with false", async () => {
        await list(['policy-admin'], 'removalFailing=false');

        expect(service.listMyRequests).toHaveBeenCalledWith('id-m', {
          status: undefined,
          page: 1,
          limit: 50,
        });
        expect(service.listRemovalFailing).not.toHaveBeenCalled();
      });
    });

    it('opens any request of the tenant for a policy-admin, only theirs for others', async () => {
      await request((await appWith(['policy-admin'])).getHttpServer()).get(
        `/access-requests/${REQUEST_ID}`,
      );
      await request((await appWith(['viewer'])).getHttpServer()).get(
        `/access-requests/${REQUEST_ID}`,
      );

      expect(service.getRequestDetail.mock.calls).toEqual([
        [REQUEST_ID, 'id-m', 'm@example.com', true],
        [REQUEST_ID, 'id-m', 'm@example.com', false],
      ]);
    });
  });
});
