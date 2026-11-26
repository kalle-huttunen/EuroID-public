/**
 * HTTP contract of the NHI routes, real controller and services on in-memory MongoDB: credential
 * verification (POST /nhi/credentials/verify) and the published signing key
 * (GET /nhi/_/public-key), the dry run of revoke and the kill switch (?dryRun=true), expiry on
 * the list, and the OpenAPI shape of the list's filters. Before, nothing could verify a
 * credential, the routes had no dry run, the list showed expired agents as active and the spec
 * marked every list filter required. The guard signs in the user a test sets; RolesGuard and the
 * tenant context are the real ones.
 */
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  NestMiddleware,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, HttpAdapterHost } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import mongoose, { Model } from 'mongoose';
import * as request from 'supertest';
import { clearTestDb, closeTestDb, connectTestDb } from '@testing';
import { RolesGuard } from '@infrastructure/auth/roles.guard';
import { CorrelationMiddleware } from '@infrastructure/middleware/correlation.middleware';
import { TenantContextInterceptor } from '@infrastructure/multi-tenancy/tenant-context.interceptor';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { globalExceptionFilters } from '@shared/filters/global-exception-filters';
import { AuditService } from '../audit/audit.service';
import { Identity } from '../identity/schemas/identity.schema';
import { NhiController } from './nhi.controller';
import { NhiService } from './nhi.service';
import { NhiCredentialService } from './nhi-credential.service';
import { NhiOwnershipService } from './nhi-ownership.service';
import {
  AgentIdentity,
  AgentIdentitySchema,
  type AgentIdentityDocument,
} from './schemas/agent-identity.schema';

type User = { sub: string; email: string; roles: string[]; tenantId: string };
let signedIn: User;
const as = (role: 'viewer' | 'super-admin', tenantId = 'tenant-a'): User => ({
  sub: `${role}-1`,
  email: `${role}@${tenantId}.example`,
  roles: [role],
  tenantId,
});

/** Stand-in for JwtAuthGuard: the user the test signed in. */
@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().user = signedIn;
    return true;
  }
}

const keys = generateKeyPairSync('ed25519');
const PRIVATE_PEM = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const PUBLIC_PEM = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const PAST = new Date(Date.now() - 60 * 60 * 1000);

const agent = (tenantId: string, agentId: string, parentAgentId?: string) => ({
  tenantId,
  agentId,
  displayName: agentId,
  kind: 'ai-agent',
  owner: { identityId: 'owner-1', email: 'owner@example.test' },
  scope: ['hr:read'],
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  status: 'active',
  createdBy: 'admin@example.test',
  ...(parentAgentId ? { parentAgentId } : {}),
});

/** A body shaped like the issue route's answer; its content is not genuine. */
const ENVELOPE = {
  payload: {
    spiffeId: 'spiffe://euroid.test/tenants/tenant-a/agents/payroll-bot',
    agentId: 'payroll-bot',
    tenantId: 'tenant-a',
    scope: ['hr:read'],
    issuedAt: '2026-11-25T10:00:00.000Z',
    expiresAt: '2026-11-25T10:15:00.000Z',
  },
  signature: 'ab'.repeat(64),
  keyFingerprint: 'cd'.repeat(32),
  algorithm: 'ed25519',
};

describe('NHI HTTP API (in-memory MongoDB)', () => {
  let agents: Model<AgentIdentityDocument>;
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const events = { emit: jest.fn() };

  async function makeApp(env: Record<string, string | undefined>): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [NhiController],
      providers: [
        NhiService,
        NhiCredentialService,
        NhiOwnershipService,
        { provide: getModelToken(AgentIdentity.name), useValue: agents },
        { provide: getModelToken(Identity.name), useValue: {} },
        { provide: AuditService, useValue: audit },
        { provide: DomainEventEmitterService, useValue: events },
        { provide: ConfigService, useValue: { get: (key: string) => env[key] } },
        { provide: APP_GUARD, useClass: TestAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    const correlation = new CorrelationMiddleware();
    app.use((req: Request, res: Response, next: NextFunction) =>
      (correlation as NestMiddleware).use(req, res, next),
    );
    app.useGlobalFilters(...globalExceptionFilters(app.get(HttpAdapterHost)));
    await app.init();
    return app;
  }

  const stored = (tenantId: string, agentId: string) =>
    agents.findOne({ tenantId, agentId }).lean().exec();
  const everything = () => agents.find({}).sort({ tenantId: 1, agentId: 1 }).lean().exec();

  beforeAll(async () => {
    await connectTestDb();
    agents = mongoose.model(
      AgentIdentity.name,
      AgentIdentitySchema,
    ) as unknown as Model<AgentIdentityDocument>;
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe('with a signing key', () => {
    let app: INestApplication;
    const http = () => request(app.getHttpServer());

    beforeAll(async () => {
      app = await makeApp({
        NHI_SIGNING_PRIVATE_KEY: PRIVATE_PEM,
        NHI_TRUST_DOMAIN: 'euroid.test',
      });
    });

    afterAll(async () => {
      await app.close();
    });

    async function issue(tenantId: string, agentId: string) {
      signedIn = as('super-admin', tenantId);
      const res = await http().post(`/nhi/${agentId}/credentials`).send({ ttlSeconds: 300 });
      expect(res.status).toBe(201);
      return res.body;
    }

    const verify = (body: unknown, user = as('viewer')) => {
      signedIn = user;
      return http()
        .post('/nhi/credentials/verify')
        .send(body as object);
    };

    it('verifies a credential for a viewer until its agent is killed', async () => {
      await agents.create(agent('tenant-a', 'payroll-bot'));
      const credential = await issue('tenant-a', 'payroll-bot');

      const live = await verify(credential);
      expect(live.status).toBe(200);
      expect(live.body).toEqual({
        active: true,
        agentId: 'payroll-bot',
        scope: ['hr:read'],
        expiresAt: credential.payload.expiresAt,
      });

      signedIn = as('super-admin');
      expect((await http().post('/nhi/payroll-bot/kill').send({ reason: 'leaked' })).status).toBe(
        201,
      );
      const killed = await verify(credential);
      expect(killed.status).toBe(200);
      expect(killed.body).toEqual({ active: false, reason: 'kill switch engaged' });
    });

    it('verifies against the tenant of the signed-in user only', async () => {
      await agents.create(agent('tenant-b', 'payroll-bot'));
      const theirs = await issue('tenant-b', 'payroll-bot');

      expect((await verify(theirs)).body).toEqual({
        active: false,
        reason: 'issued for another tenant',
      });
      // The body cannot name the tenant: a payload moved to tenant-a no longer matches its signature
      const moved = { ...theirs, payload: { ...theirs.payload, tenantId: 'tenant-a' } };
      expect((await verify(moved)).body).toEqual({ active: false, reason: 'invalid signature' });
      expect((await verify(theirs, as('viewer', 'tenant-b'))).body).toMatchObject({
        active: true,
      });
    });

    it('refuses the credential of an agent past its expiry and marks the agent expired', async () => {
      await agents.create(agent('tenant-a', 'payroll-bot'));
      const credential = await issue('tenant-a', 'payroll-bot');
      await agents.updateOne({ tenantId: 'tenant-a', agentId: 'payroll-bot' }, { expiresAt: PAST });

      expect((await verify(credential)).body).toEqual({ active: false, reason: 'agent expired' });
      expect(await stored('tenant-a', 'payroll-bot')).toMatchObject({ status: 'expired' });
    });

    it('answers 400 with the problem for a body that is not a credential envelope', async () => {
      const { signature: _signature, ...unsigned } = ENVELOPE;
      for (const body of [
        {},
        unsigned,
        { ...ENVELOPE, issuer: 'someone' },
        { ...ENVELOPE, payload: { ...ENVELOPE.payload, expiresAt: 'tomorrow' } },
      ]) {
        const res = await verify(body);
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body.message)).toMatch(/signature|issuer|expiresAt|payload/);
      }
      // Well formed but not genuine: inactive, never an error
      const forged = await verify(ENVELOPE);
      expect(forged.status).toBe(200);
      expect(forged.body).toEqual({ active: false, reason: 'signed with another key' });
    });

    it('publishes the signing public key to a viewer', async () => {
      await agents.create(agent('tenant-a', 'payroll-bot'));
      const credential = await issue('tenant-a', 'payroll-bot');
      signedIn = as('viewer');

      const res = await http().get('/nhi/_/public-key');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        algorithm: 'ed25519',
        keyFingerprint: credential.keyFingerprint,
        trustDomain: 'euroid.test',
        publicKeyPem: PUBLIC_PEM,
        jwk: {
          kty: 'OKP',
          crv: 'Ed25519',
          x: expect.any(String),
          kid: credential.keyFingerprint,
          alg: 'EdDSA',
          use: 'sig',
        },
      });
    });

    it('previews a revoke and a kill switch without changing anything', async () => {
      await agents.create([
        agent('tenant-a', 'parent-bot'),
        agent('tenant-a', 'child-bot', 'parent-bot'),
        agent('tenant-a', 'grandchild-bot', 'child-bot'),
        agent('tenant-b', 'other-child', 'parent-bot'),
      ]);
      const before = await everything();
      signedIn = as('super-admin');

      for (const action of ['revoke', 'kill']) {
        const res = await http().post(`/nhi/parent-bot/${action}?dryRun=true`).send({});
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
          dryRun: true,
          agentId: 'parent-bot',
          killSwitch: action === 'kill',
          changes: true,
        });
        expect(res.body.reached.map((a: { agentId: string }) => a.agentId)).toEqual([
          'child-bot',
          'grandchild-bot',
        ]);
      }
      expect(await everything()).toEqual(before);
      expect(audit.log).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('refuses an unknown dryRun value, a viewer, and a real call without a reason', async () => {
      await agents.create(agent('tenant-a', 'parent-bot'));

      signedIn = as('super-admin');
      for (const value of ['yes', '1', 'TRUE']) {
        const res = await http().post(`/nhi/parent-bot/kill?dryRun=${value}`).send({});
        expect(res.status).toBe(400);
      }
      expect((await http().post('/nhi/parent-bot/revoke').send({})).status).toBe(400);
      signedIn = as('viewer');
      expect((await http().post('/nhi/parent-bot/revoke?dryRun=true').send({})).status).toBe(403);

      expect(await stored('tenant-a', 'parent-bot')).toMatchObject({
        status: 'active',
        killSwitchEngaged: false,
      });
    });

    it('lists an agent past its expiry under ?status=expired', async () => {
      await agents.create({ ...agent('tenant-a', 'stale-bot'), expiresAt: PAST });
      signedIn = as('viewer');

      const res = await http().get('/nhi?status=expired');

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0]).toMatchObject({ agentId: 'stale-bot', status: 'expired' });
    });

    // HX-G follow-up: agents whose owner left are marked ownerless; the page lists them apart
    // and a super-admin gives each a new owner
    it('lists the ownerless agents apart, and lets only a super-admin change an owner', async () => {
      await agents.create([
        { ...agent('tenant-a', 'orphan-bot'), ownerlessSince: PAST, ownerlessReason: 'offboarded' },
        agent('tenant-a', 'owned-bot'),
      ]);
      signedIn = as('viewer');

      const ownerless = await http().get('/nhi?ownerless=true');
      expect(ownerless.body.data.map((a: { agentId: string }) => a.agentId)).toEqual([
        'orphan-bot',
      ]);
      expect(ownerless.body.data[0]).toMatchObject({ ownerlessReason: 'offboarded' });
      const owned = await http().get('/nhi?ownerless=false');
      expect(owned.body.data.map((a: { agentId: string }) => a.agentId)).toEqual(['owned-bot']);
      expect((await http().get('/nhi?ownerless=yes')).status).toBe(400);
      expect(
        (await http().post('/nhi/orphan-bot/owner').send({ ownerIdentityId: 'x' })).status,
      ).toBe(403);
      signedIn = as('super-admin');
      expect((await http().post('/nhi/orphan-bot/owner').send({})).status).toBe(400);
      expect(await stored('tenant-a', 'orphan-bot')).toMatchObject({
        ownerlessReason: 'offboarded',
      });
    });

    it('documents the list filters and dryRun as optional', () => {
      const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build());
      const optional = (path: string, method: 'get' | 'post') =>
        Object.fromEntries(
          (doc.paths[path][method]?.parameters ?? [])
            .filter((p) => 'in' in p && p.in === 'query')
            .map((p) => ('name' in p ? [p.name, p.required] : [])),
        );

      expect(optional('/nhi', 'get')).toEqual({
        ownerIdentityId: false,
        kind: false,
        status: false,
        riskTier: false,
        ownerless: false,
        page: false,
        limit: false,
      });
      expect(optional('/nhi/{agentId}/revoke', 'post')).toEqual({ dryRun: false });
      expect(optional('/nhi/{agentId}/kill', 'post')).toEqual({ dryRun: false });
      expect(doc.paths['/nhi/credentials/verify']?.post).toBeDefined();
      expect(doc.paths['/nhi/_/public-key']?.get).toBeDefined();
    });
  });

  describe('without a signing key', () => {
    let app: INestApplication;
    const http = () => request(app.getHttpServer());

    beforeAll(async () => {
      app = await makeApp({});
    });

    afterAll(async () => {
      await app.close();
    });

    it('publishes no key and verifies nothing', async () => {
      signedIn = as('viewer');

      const key = await http().get('/nhi/_/public-key');
      expect(key.status).toBe(404);
      expect(key.body.message).toMatch(/signing is not configured/);

      const res = await http().post('/nhi/credentials/verify').send(ENVELOPE);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ active: false, reason: 'credential signing is not configured' });
    });
  });
});
