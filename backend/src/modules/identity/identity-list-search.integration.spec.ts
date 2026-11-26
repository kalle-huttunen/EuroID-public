/**
 * GET /identity search and offboarded identities (HTTP, in-memory MongoDB, tenant plugin), the
 * list the GDPR page's person picker reads. `q`: every word in the work email or a name, case
 * ignored, taken as text. `includeDeleted=true`: offboarded (soft-deleted) identities too, with
 * their `deletedAt`, for operator and above only. Both in the caller's tenant only.
 */
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  NestMiddleware,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { ZodValidationPipe } from '@anatine/zod-nestjs';
import mongoose, { Model } from 'mongoose';
import type { NextFunction, Request, Response } from 'express';
import * as request from 'supertest';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { TenantContextInterceptor } from '@infrastructure/multi-tenancy/tenant-context.interceptor';
import { CorrelationMiddleware } from '@infrastructure/middleware/correlation.middleware';
import { RolesGuard } from '@infrastructure/auth/roles.guard';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { clearTestDb, closeTestDb, connectTestDb, createMockLoggerFactory } from '@testing';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { IdentityQueryService } from './identity-query.service';
import { Identity, IdentityDocument, IdentitySchema } from './schemas/identity.schema';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';

/** Test stand-in for JwtAuthGuard: tenant and role from the (trusted) token. */
@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const tenantId = String(req.headers['x-test-tenant']);
    const role = String(req.headers['x-test-role']);
    req.user = { sub: role, email: `${role}@${tenantId}.example`, roles: [role], tenantId };
    return true;
  }
}

@Injectable()
class RequestContextMiddleware implements NestMiddleware {
  private readonly inner = new CorrelationMiddleware();
  use(req: Request, res: Response, next: NextFunction): void {
    this.inner.use(req, res, next);
  }
}

describe('GET /identity search and offboarded identities (HTTP + in-memory MongoDB)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let identities: Model<IdentityDocument>;

  beforeAll(async () => {
    await connectTestDb();
    identities = mongoose.model(
      Identity.name,
      IdentitySchema,
    ) as unknown as Model<IdentityDocument>;
    const { factory: loggerFactory } = createMockLoggerFactory();
    const query = new IdentityQueryService(
      identities,
      loggerFactory as unknown as LoggerFactoryService,
    );

    moduleRef = await Test.createTestingModule({
      controllers: [IdentityController],
      providers: [
        {
          provide: IdentityService,
          useValue: {
            findAllPaginated: (...args: Parameters<IdentityQueryService['findAllPaginated']>) =>
              query.findAllPaginated(...args),
          },
        },
      ],
    })
      .useMocker(() => ({ logFireAndForget: jest.fn() }))
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    const contextMiddleware = new RequestContextMiddleware();
    app.use((req: Request, res: Response, next: NextFunction) =>
      contextMiddleware.use(req, res, next),
    );
    app.useGlobalGuards(new TestAuthGuard(), new RolesGuard(new Reflector()));
    app.useGlobalInterceptors(new TenantContextInterceptor());
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
  });

  const person = (tenantId: string, firstName: string, lastName: string, extra = {}) =>
    withTenantContext(tenantId, () =>
      identities.create({
        tenantId,
        profile: {
          firstName,
          lastName,
          email: `${firstName}.${lastName}@${tenantId}.example`.toLowerCase(),
        },
        ...extra,
      }),
    );

  beforeEach(async () => {
    await person(A, 'Ada', 'Virtanen');
    await person(A, 'Bob', 'Laine');
    await person(A, 'Leo', 'Lahti', { deletedAt: new Date('2026-10-01T08:00:00.000Z') });
    await person(B, 'Ada', 'Berg');
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const list = (query: string, role = 'viewer', tenant = A) =>
    request(app.getHttpServer())
      .get(`/api/v1/identity?_start=0&_end=50${query}`)
      .set('x-test-tenant', tenant)
      .set('x-test-role', role);

  const emails = (body: Array<{ email: string }>) => body.map((u) => u.email).sort();

  it('searches every word in the work email and the names, ignoring case, in the caller tenant', async () => {
    const byName = await list('&q=ADA').expect(200);
    expect(emails(byName.body)).toEqual(['ada.virtanen@tenant-a.example']);
    expect(byName.headers['x-total-count']).toBe('1');

    const twoWords = await list(`&q=${encodeURIComponent('ada  VIRT')}`).expect(200);
    expect(emails(twoWords.body)).toEqual(['ada.virtanen@tenant-a.example']);
    const byEmail = await list('&q=bob.laine%40tenant-a').expect(200);
    expect(emails(byEmail.body)).toEqual(['bob.laine@tenant-a.example']);
    // Every word must match: Ada and Bob are two people.
    expect((await list('&q=ada%20bob').expect(200)).body).toEqual([]);
    // Tenant B's Ada is found only in tenant B.
    const inB = await list('&q=ada', 'viewer', B).expect(200);
    expect(emails(inB.body)).toEqual(['ada.berg@tenant-b.example']);
    // Without a search: the tenant's identities, the offboarded one left out.
    expect((await list('').expect(200)).body).toHaveLength(2);
  });

  // Hunt 2026-11-25 02 F12: the whitelisted bare keys were applied to the document root, where
  // no profile field is, and a list was an exact array match
  it('filters by a whitelisted bare key as by its profile field, a list as any of its values', async () => {
    await identities.updateOne(
      { 'profile.firstName': 'Ada', tenantId: A },
      { $set: { 'profile.status': 'ACTIVE', 'profile.departmentName': 'R&D' } },
    );
    await identities.updateOne(
      { 'profile.firstName': 'Bob', tenantId: A },
      { $set: { 'profile.status': 'PENDING', 'profile.departmentName': 'Sales' } },
    );
    /** GET /identity with the filter as the query string carries it (JSON). */
    const filtered = (filter: string) => list(`&filter=${encodeURIComponent(filter)}`).expect(200);

    expect(emails((await filtered('{"status":"ACTIVE"}')).body)).toEqual([
      'ada.virtanen@tenant-a.example',
    ]);
    expect(emails((await filtered('{"departmentName":["R&D","Sales"]}')).body)).toEqual([
      'ada.virtanen@tenant-a.example',
      'bob.laine@tenant-a.example',
    ]);
    expect(emails((await filtered('{"email":"Bob.Laine@Tenant-A.example"}')).body)).toEqual([
      'bob.laine@tenant-a.example',
    ]);
    expect(emails((await filtered('{"profile.firstName":"Ada"}')).body)).toEqual([
      'ada.virtanen@tenant-a.example',
    ]);
    // Still the caller's tenant only, and still no operator
    expect((await filtered('{"status":"ACTIVE"}')).headers['x-total-count']).toBe('1');
    await list(`&filter=${encodeURIComponent('{"status":{"$ne":"x"}}')}`).expect(400);
  });

  it('takes the search as text, never as a regular expression', async () => {
    expect((await list(`&q=${encodeURIComponent('.*')}`).expect(200)).body).toEqual([]);
    expect((await list(`&q=${encodeURIComponent('a(')}`).expect(200)).body).toEqual([]);
  });

  it('lists offboarded identities with their deletedAt for an operator and above', async () => {
    const res = await list('&q=leo&includeDeleted=true', 'operator').expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      email: 'leo.lahti@tenant-a.example',
      deletedAt: '2026-10-01T08:00:00.000Z',
    });
    // Active identities carry no deletedAt; the other tenant's stay out.
    const all = await list('&includeDeleted=true', 'super-admin').expect(200);
    expect(emails(all.body)).toEqual([
      'ada.virtanen@tenant-a.example',
      'bob.laine@tenant-a.example',
      'leo.lahti@tenant-a.example',
    ]);
    expect(all.body.filter((u: { deletedAt?: string }) => u.deletedAt)).toHaveLength(1);
    // Without the option the offboarded identity is not found.
    expect((await list('&q=leo', 'operator').expect(200)).body).toEqual([]);
  });

  it('refuses includeDeleted to a viewer and a bad value with a message that says what to fix', async () => {
    const viewer = await list('&includeDeleted=true', 'viewer').expect(403);
    expect(viewer.body.message).toBe('includeDeleted=true needs the operator role or above');

    const badFlag = await list('&includeDeleted=yes', 'operator').expect(400);
    expect(badFlag.body.message).toBe('includeDeleted takes true or false');
    const longSearch = await list(`&q=${'a'.repeat(101)}`).expect(400);
    expect(longSearch.body.message).toBe('q takes at most 100 characters');
    const badFilter = await list('&filter=%7Bnot-json').expect(400);
    expect(badFilter.body.message).toBe('Invalid filter: invalid JSON');
  });
});
