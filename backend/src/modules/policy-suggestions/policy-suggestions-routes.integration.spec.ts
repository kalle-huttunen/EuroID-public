/**
 * The `/policy-suggestions/:id` routes over HTTP, on in-memory MongoDB with the tenant plugin. A
 * suggestion is addressed by its `suggestionId` (a UUID), the id the Policy suggestions page
 * sends. The routes validated an ObjectId instead, so Accept and Dismiss always answered 400
 * "Invalid ID format". An ObjectId or any other value is 400 before a lookup; another tenant's
 * suggestion is 404. Dismiss takes an optional reason, so a request without a body dismisses
 * (main.ts's empty-body middleware).
 */
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  NestMiddleware,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, HttpAdapterHost } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { ZodValidationPipe } from '@anatine/zod-nestjs';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import type { NextFunction, Request, Response } from 'express';
import * as request from 'supertest';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { TenantContextInterceptor } from '@infrastructure/multi-tenancy/tenant-context.interceptor';
import { CorrelationMiddleware } from '@infrastructure/middleware/correlation.middleware';
import { emptyBodyAsObject } from '@infrastructure/middleware/empty-body.middleware';
import { RolesGuard } from '@infrastructure/auth/roles.guard';
import { policySuggestionsConfig } from '@infrastructure/config/policy-suggestions.config';
import { globalExceptionFilters } from '@shared/filters/global-exception-filters';
import { PolicySuggestionsController } from './policy-suggestions.controller';
import { PolicySuggestionService } from './policy-suggestions.service';
import {
  PolicySuggestion,
  PolicySuggestionDocument,
  PolicySuggestionSchema,
  SuggestionType,
} from './schemas/suggestion.schema';
import { PolicyService } from '../policy/policy.service';

mongoose.plugin(tenantPlugin);

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const A_UUID = '5f0c6a1e-3b7d-4c2a-9e8f-1a2b3c4d5e6f';
const B_UUID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const NEW_POLICY_ID = '665f1c2a1b2c3d4e5f60aaaa';

/** Stand-in for JwtAuthGuard: a policy-admin of the tenant its (trusted) token names. */
@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const tenantId = String(req.headers['x-test-tenant'] ?? TENANT_A);
    req.user = { sub: 'pa', email: `pa@${tenantId}.example`, roles: ['policy-admin'], tenantId };
    return true;
  }
}

type Route = { name: string; method: 'get' | 'post'; path: (id: string) => string; ok: number };
const ROUTES: Route[] = [
  { name: 'GET :id', method: 'get', path: (id) => `/policy-suggestions/${id}`, ok: 200 },
  {
    name: 'POST :id/accept',
    method: 'post',
    path: (id) => `/policy-suggestions/${id}/accept`,
    ok: 201,
  },
  {
    name: 'POST :id/dismiss',
    method: 'post',
    path: (id) => `/policy-suggestions/${id}/dismiss`,
    ok: 201,
  },
];

describe('Policy suggestion routes (HTTP + in-memory MongoDB)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let suggestionModel: Model<PolicySuggestionDocument>;
  const policyService = { create: jest.fn() };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: PolicySuggestion.name, schema: PolicySuggestionSchema },
        ]),
      ],
      controllers: [PolicySuggestionsController],
      providers: [
        PolicySuggestionService,
        { provide: PolicyService, useValue: policyService },
        { provide: policySuggestionsConfig.KEY, useValue: {} },
        { provide: APP_GUARD, useClass: TestAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
    })
      // The analyzers' inputs (policy engine, identities, catalog, Entra) are not used here.
      .useMocker(() => ({}))
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    const correlation = new CorrelationMiddleware();
    app.use((req: Request, res: Response, next: NextFunction) =>
      (correlation as NestMiddleware).use(req, res, next),
    );
    app.use(emptyBodyAsObject); // as main.ts
    app.useGlobalFilters(...globalExceptionFilters(app.get(HttpAdapterHost)));
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    suggestionModel = moduleRef.get(getModelToken(PolicySuggestion.name));
  });

  beforeEach(() => {
    policyService.create.mockResolvedValue({ _id: NEW_POLICY_ID });
  });

  afterEach(async () => {
    await suggestionModel.deleteMany({}, { skipTenantScope: true });
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  async function seed(tenantId: string, suggestionId: string): Promise<string> {
    const doc = await withTenantContext(tenantId, () =>
      suggestionModel.create({
        tenantId,
        suggestionId,
        type: SuggestionType.BIRTHRIGHT_PATTERN,
        confidence: 92,
        title: 'Engineering gets GitHub',
        description: 'Most engineers hold the GitHub org membership.',
        status: 'pending',
        suggestedPolicy: {
          name: 'Birthright: Engineering -> GitHub',
          conditionGroups: [
            {
              id: 'g1',
              join: 'AND',
              conditions: [
                { id: 'c1', field: 'departmentName', operator: 'equals', value: 'Engineering' },
              ],
            },
          ],
          actions: [{ id: 'a1', type: 'assign_group', target: 'entra-id', params: {} }],
          risk: 'Low',
        },
      }),
    );
    return String(doc._id);
  }

  function stored(suggestionId: string) {
    return suggestionModel.findOne({ suggestionId }, null, { skipTenantScope: true }).lean().exec();
  }

  /** POSTs carry a JSON body like the page's (`{ reason }` with no reason is `{}`). */
  function call(route: Route, id: string, tenant = TENANT_A) {
    const server = app.getHttpServer();
    return route.method === 'get'
      ? request(server).get(route.path(id)).set('x-test-tenant', tenant)
      : request(server).post(route.path(id)).set('x-test-tenant', tenant).send({});
  }

  describe.each(ROUTES)('$name', (route) => {
    it('finds the suggestion by its suggestionId (UUID)', async () => {
      await seed(TENANT_A, A_UUID);
      const res = await call(route, A_UUID).expect(route.ok);
      expect(res.body.suggestionId).toBe(A_UUID);
    });

    it('answers 400 for its document _id (ObjectId), which no page or event hands out', async () => {
      const objectId = await seed(TENANT_A, A_UUID);
      const res = await call(route, objectId).expect(400);
      expect(res.body.message).toMatch(/Invalid ID format/);
      expect((await stored(A_UUID))?.status).toBe('pending');
    });

    it('answers 400 for garbage', async () => {
      await seed(TENANT_A, A_UUID);
      await call(route, 'not-an-id').expect(400);
      expect(policyService.create).not.toHaveBeenCalled();
    });

    it("answers 404 for another tenant's suggestion and leaves it pending", async () => {
      await seed(TENANT_B, B_UUID);
      await call(route, B_UUID, TENANT_A).expect(404);
      expect((await stored(B_UUID))?.status).toBe('pending');
      expect(policyService.create).not.toHaveBeenCalled();
    });
  });

  it('accept creates the draft policy and answers the suggestion with its resultingPolicyId', async () => {
    await seed(TENANT_A, A_UUID);

    const res = await call(ROUTES[1], A_UUID).expect(201);

    expect(policyService.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Birthright: Engineering -> GitHub', status: 'draft' }),
      'pa@tenant-a.example',
    );
    expect(res.body).toMatchObject({
      suggestionId: A_UUID,
      status: 'accepted',
      resultingPolicyId: NEW_POLICY_ID,
    });
    // No `policy` object: the page must redirect on resultingPolicyId.
    expect(res.body.policy).toBeUndefined();
  });

  /**
   * Two calls race: the policy is created only once both have read the suggestion, so both have
   * passed any status check made on that read.
   */
  function bothReadFirst() {
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    const findOne = suggestionModel.findOne.bind(suggestionModel);
    const spy = jest.spyOn(suggestionModel, 'findOne').mockImplementation(((
      ...args: Parameters<typeof suggestionModel.findOne>
    ) => {
      const query = findOne(...args);
      return {
        exec: async () => {
          const found = await query.exec();
          if (++reads === 2) release();
          return found;
        },
      };
    }) as never);
    policyService.create.mockImplementation(async () => {
      await bothRead;
      return { _id: NEW_POLICY_ID };
    });
    return spy;
  }

  // r2-04 N4: accept read the suggestion, checked pending, created the policy, then saved: two
  // accepts at once both passed the check and made two DRAFT policies
  it('two accepts at once make one draft policy; the other answers 400', async () => {
    await seed(TENANT_A, A_UUID);
    const spy = bothReadFirst();

    const [first, second] = await Promise.all([call(ROUTES[1], A_UUID), call(ROUTES[1], A_UUID)]);
    spy.mockRestore();

    expect([first.status, second.status].sort()).toEqual([201, 400]);
    expect(policyService.create).toHaveBeenCalledTimes(1);
    expect(await stored(A_UUID)).toMatchObject({
      status: 'accepted',
      resultingPolicyId: NEW_POLICY_ID,
    });
  });

  it('a policy that could not be created leaves the suggestion pending', async () => {
    await seed(TENANT_A, A_UUID);
    policyService.create.mockRejectedValue(new Error('validation failed'));

    await call(ROUTES[1], A_UUID).expect(500);

    const after = await stored(A_UUID);
    expect(after?.status).toBe('pending');
    expect(after?.acceptedBy).toBeUndefined();
  });

  it('accept and dismiss at once: one wins, the other answers 400', async () => {
    await seed(TENANT_A, A_UUID);
    const spy = bothReadFirst();

    const [accepted, dismissed] = await Promise.all([
      call(ROUTES[1], A_UUID),
      call(ROUTES[2], A_UUID),
    ]);
    spy.mockRestore();

    expect([accepted.status, dismissed.status].sort()).toEqual([201, 400]);
    const after = await stored(A_UUID);
    expect(after?.status).toBe(accepted.status === 201 ? 'accepted' : 'dismissed');
  });

  it('dismiss records the reason', async () => {
    await seed(TENANT_A, A_UUID);

    const res = await request(app.getHttpServer())
      .post(`/policy-suggestions/${A_UUID}/dismiss`)
      .set('x-test-tenant', TENANT_A)
      .send({ reason: 'Not now' })
      .expect(201);

    expect(res.body).toMatchObject({
      status: 'dismissed',
      dismissedBy: 'pa@tenant-a.example',
      dismissReason: 'Not now',
    });
  });

  // Express 5 leaves req.body undefined; without main.ts's middleware this answered 400 ": Required"
  it('dismiss without a body dismisses without a reason', async () => {
    await seed(TENANT_A, A_UUID);

    const res = await request(app.getHttpServer())
      .post(`/policy-suggestions/${A_UUID}/dismiss`)
      .set('x-test-tenant', TENANT_A)
      .expect(201);

    expect(res.body).toMatchObject({ status: 'dismissed', dismissedBy: 'pa@tenant-a.example' });
    expect(res.body.dismissReason).toBeUndefined();
    expect((await stored(A_UUID))?.status).toBe('dismissed');
  });
});
