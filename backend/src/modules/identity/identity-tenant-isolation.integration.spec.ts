/**
 * Tenant isolation of identity writes, on in-memory MongoDB with the tenant plugin.
 * The tenant comes from the authenticated request (JWT -> TenantContextInterceptor ->
 * AsyncLocalStorage), never from a request body or a connector config: a caller in tenant A
 * that names tenant B still writes into A, and cannot touch B's identities.
 */

import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  NestMiddleware,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { ZodValidationPipe } from '@anatine/zod-nestjs';
import mongoose, { Model } from 'mongoose';
import type { NextFunction, Request, Response } from 'express';
import * as request from 'supertest';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { TenantContextInterceptor } from '@infrastructure/multi-tenancy/tenant-context.interceptor';
import { CorrelationMiddleware } from '@infrastructure/middleware/correlation.middleware';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import { createMockLoggerFactory, createMockEventEmitter, closeTestDb, testDbUri } from '@testing';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { IdentityQueryService } from './identity-query.service';
import { IdentityMutationService } from './identity-mutation.service';
import { IdentityCorrelationService } from './identity-correlation.service';
import { IdentityUncorrelatedService } from './identity-uncorrelated.service';
import { IdentityProvisioningService } from './identity-provisioning.service';
import { IdentityOnionService } from './identity-onion.service';
import { IdentityDeletedMatchService } from './identity-deleted-match.service';
import { LeaverPolicy, LeaverPolicySchema } from '../leavers/schemas/leaver-policy.schema';
import { Identity, IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { CorrelationRuleEngine } from './correlation/correlation-rule.engine';
import { HrIngestionService } from '../connectors/hr-ingestion.service';
import { ConnectorConfigService } from '../connectors/connector-config.service';
import { CsvHrService } from '../connectors/csv-hr-connector/csv-hr.service';
import { JsonApiHrService } from '../connectors/json-api-hr-connector/json-api-hr.service';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';
import { BlueprintsService } from '../blueprints/blueprints.service';

// Register tenant scoping plugin (normally done by TenantModule at import time)
mongoose.plugin(tenantPlugin);

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

/** Test stand-in for JwtAuthGuard: the caller's tenant comes from its (trusted) token. */
@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const tenantId = String(req.headers['x-test-token-tenant']);
    req.user = { sub: 'op', email: `op@${tenantId}.example`, roles: ['operator'], tenantId };
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

const newHire = {
  sourceSystem: 'manual-ui',
  sourceUserId: 'ada@corp.example',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@corp.example',
  status: UserStatus.ACTIVE,
};

describe('Identity tenant isolation (HTTP + in-memory MongoDB)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let identityModel: Model<IdentityDocument>;
  const connectorConfig = { getConfig: jest.fn() };
  const csvHr = { fetchUsers: jest.fn() };
  const pluginRegistry = { getById: jest.fn() };

  beforeAll(async () => {
    const { factory: loggerFactory } = createMockLoggerFactory();

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: LeaverPolicy.name, schema: LeaverPolicySchema },
        ]),
      ],
      controllers: [IdentityController],
      providers: [
        IdentityQueryService,
        IdentityMutationService,
        IdentityCorrelationService,
        IdentityUncorrelatedService,
        IdentityProvisioningService,
        IdentityOnionService,
        IdentityDeletedMatchService,
        IdentityService,
        HrIngestionService,
        {
          provide: ReconciliationService,
          useValue: {
            reconcile: jest.fn((identity: unknown) => Promise.resolve(identity)),
            hrOwnersOf: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: ReconciliationConfigService,
          useValue: { getHrSourceTags: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: CorrelationConfigService,
          useValue: {
            getCorrelationConfig: jest.fn().mockResolvedValue({ rules: [{ strategy: 'email' }] }),
            getPrimaryHrSourceName: jest.fn().mockResolvedValue(null),
            getHrPriorityConfig: jest.fn().mockResolvedValue(null),
            getHrPriorityFromBlueprint: jest.fn().mockResolvedValue(null),
            // The built-in HR connectors (manifest capability `ingest`)
            isHrSourceName: jest.fn(async (name: string) =>
              ['csv-hr', 'json-api-hr'].includes(name),
            ),
          },
        },
        {
          provide: CorrelationRuleEngine,
          useValue: {
            findCorrelatedIdentity: jest
              .fn()
              .mockResolvedValue({ identity: null, matchedBy: null, confidence: 0 }),
          },
        },
        { provide: CorrelationHashService, useValue: { hash: jest.fn() } },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: createMockEventEmitter() },
        { provide: ConnectorConfigService, useValue: connectorConfig },
        { provide: CsvHrService, useValue: csvHr },
        { provide: JsonApiHrService, useValue: { fetchUsers: jest.fn() } },
        { provide: PluginRegistryService, useValue: pluginRegistry },
        { provide: BlueprintsService, useValue: {} },
      ],
    })
      .useMocker(() => ({}))
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    const contextMiddleware = new RequestContextMiddleware();
    app.use((req: Request, res: Response, next: NextFunction) =>
      contextMiddleware.use(req, res, next),
    );
    app.useGlobalGuards(new TestAuthGuard());
    app.useGlobalInterceptors(new TenantContextInterceptor());
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    identityModel = moduleRef.get(getModelToken(Identity.name));
  });

  afterEach(async () => {
    await identityModel.deleteMany({}, { skipTenantScope: true });
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  /** Every stored identity, across tenants. */
  function allIdentities() {
    return identityModel.find({}, null, { skipTenantScope: true }).lean().exec();
  }

  async function seedIdentity(tenantId: string, email: string): Promise<string> {
    const doc = await withTenantContext(tenantId, () =>
      identityModel.create({
        tenantId,
        profile: { firstName: 'Bob', lastName: 'B', email, jobTitle: 'Engineer', tenantId },
      }),
    );
    return String(doc._id);
  }

  it('POST /identity stores the identity in the caller tenant, ignoring a body tenantId', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/identity')
      .set('x-test-token-tenant', TENANT_A)
      .send({ ...newHire, tenantId: TENANT_B })
      .expect(201);

    const stored = await allIdentities();
    expect(stored).toHaveLength(1);
    expect(stored[0].tenantId).toBe(TENANT_A);
    // No copy of the foreign tenant id in the profile or the linked source either. The source, an
    // embedded document, carries no tenantId of its own (its identity's applies).
    expect((stored[0].profile as unknown as Record<string, unknown>).tenantId).toBe(TENANT_A);
    expect(stored[0].sources[0]).not.toHaveProperty('tenantId');
    expect(stored[0].sources[0].rawData).toMatchObject({ tenantId: TENANT_A });
    expect(res.body.user.tenantId).toBe(TENANT_A);
  });

  it('PATCH /identity/:id keeps the identity in the caller tenant when the body names another', async () => {
    const id = await seedIdentity(TENANT_A, 'bob@corp.example');

    await request(app.getHttpServer())
      .patch(`/api/v1/identity/${id}`)
      .set('x-test-token-tenant', TENANT_A)
      .send({ jobTitle: 'Architect', tenantId: TENANT_B })
      .expect(200);

    const [stored] = await allIdentities();
    expect(stored.tenantId).toBe(TENANT_A);
    expect(stored.profile.jobTitle).toBe('Architect');
    expect((stored.profile as unknown as Record<string, unknown>).tenantId).toBe(TENANT_A);
  });

  it("PATCH /identity/:id cannot update another tenant's identity", async () => {
    const id = await seedIdentity(TENANT_B, 'bob@corp.example');

    await request(app.getHttpServer())
      .patch(`/api/v1/identity/${id}`)
      .set('x-test-token-tenant', TENANT_A)
      .send({ jobTitle: 'Architect', tenantId: TENANT_B })
      .expect(404);

    const [stored] = await allIdentities();
    expect(stored.tenantId).toBe(TENANT_B);
    expect(stored.profile.jobTitle).toBe('Engineer');
  });

  it('HR ingest writes rows into the request tenant, not the tenant a connector config names', async () => {
    pluginRegistry.getById.mockReturnValue({ id: 'csv-hr', capabilities: ['ingest'] });
    connectorConfig.getConfig.mockResolvedValue({
      config: { filePath: 'hr.csv', tenantId: TENANT_B },
    });
    // The connector maps rows with the tenant it is given (or, without one, its config value).
    csvHr.fetchUsers.mockImplementation(async (config: Record<string, unknown>, tid?: string) => [
      { ...newHire, sourceSystem: 'csv-hr', tenantId: tid ?? config.tenantId },
    ]);
    const ingestion = moduleRef.get(HrIngestionService);

    const result = await withTenantContext(TENANT_A, () => ingestion.ingestFromConnector('csv-hr'));

    expect(result).toEqual({
      ingested: 1,
      errors: [],
      activeRowsOfDeletedIdentities: 0,
      rowsHeldForConflictReview: 0,
      rowsHeldForIdentityLimit: 0,
    });
    const stored = await allIdentities();
    expect(stored.map((s) => s.tenantId)).toEqual([TENANT_A]);
  });

  it('a payload tenantId that disagrees with the tenant context is overwritten', async () => {
    // SCIM and HR mappers used to default dto.tenantId to "default"; the context must win.
    const identityService = moduleRef.get(IdentityService);

    await withTenantContext(TENANT_A, () =>
      identityService.saveOrUpdate({ ...newHire, tenantId: 'default' }),
    );

    const stored = await allIdentities();
    expect(stored.map((s) => s.tenantId)).toEqual([TENANT_A]);
    expect((stored[0].profile as unknown as Record<string, unknown>).tenantId).toBe(TENANT_A);
  });
});
