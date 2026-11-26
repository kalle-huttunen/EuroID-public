/**
 * Route-table regression test.
 *
 * Boots every controller in src/ (dependencies auto-mocked, no database) with the same
 * global prefix main.ts applies, then inspects the resulting Express route table.
 * Guards against a controller repeating the global prefix in @Controller(), which made
 * login, MFA, SAML and credential-lifecycle routes live at /api/v1/api/v1/... and 404
 * for the frontend, and against a parameter route registered before a literal route it
 * captures, which made PATCH /blueprints/pipeline-config answer 400 "Invalid ID format".
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import { INestApplication, Type, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { API_GLOBAL_PREFIX, API_GLOBAL_PREFIX_OPTIONS } from '@infrastructure/config/global-prefix';
import { AuthLocalService } from './modules/auth/auth-local.service';

const CONTROLLER_WATERMARK = '__controller__';

interface ExpressRouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

function findControllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return findControllerFiles(full);
    return entry.name.endsWith('.controller.ts') ? [full] : [];
  });
}

async function loadAllControllers(): Promise<Type[]> {
  const controllers: Type[] = [];
  for (const file of findControllerFiles(__dirname)) {
    const exported: Record<string, unknown> = await import(file);
    for (const value of Object.values(exported)) {
      if (typeof value === 'function' && Reflect.getMetadata(CONTROLLER_WATERMARK, value)) {
        controllers.push(value as Type);
      }
    }
  }
  return controllers;
}

/**
 * True when `earlier` ("METHOD /path"), registered first, answers requests meant for `later`:
 * same method, a parameter segment where `later` has a literal one, and the rest equal.
 */
function captures(earlier: string, later: string): boolean {
  const [method, path] = earlier.split(' ');
  const [laterMethod, laterPath] = later.split(' ');
  if (method !== laterMethod || path === laterPath) return false;
  const a = path.split('/');
  const b = laterPath.split('/');
  if (a.length !== b.length) return false;
  let literalUnderParam = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) {
      if (!b[i].startsWith(':')) literalUnderParam = true;
    } else if (a[i] !== b[i]) {
      return false;
    }
  }
  return literalUnderParam;
}

/** Callable proxy that answers any property access or call, so constructors that use deps don't crash. */
function deepMock(): unknown {
  return new Proxy(function mock() {}, {
    get: (_target, prop) => (prop === 'then' ? undefined : deepMock()),
    apply: () => deepMock(),
  });
}

describe('HTTP route table', () => {
  let app: INestApplication;
  let routes: string[];
  const login = jest.fn();

  beforeAll(async () => {
    const controllers = await loadAllControllers();
    const moduleRef = await Test.createTestingModule({ controllers })
      .useMocker((token) => (token === AuthLocalService ? { login } : deepMock()))
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix(API_GLOBAL_PREFIX, API_GLOBAL_PREFIX_OPTIONS);
    await app.init();

    const stack: ExpressRouteLayer[] = app.getHttpAdapter().getInstance().router.stack;
    routes = stack.flatMap((layer) =>
      layer.route
        ? Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route?.path}`)
        : [],
    );
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('registers the controllers (sanity check that the table is populated)', () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it('serves the per-identity entitlements the Access tab calls', () => {
    expect(routes).toContain('GET /api/v1/identity/:id/entitlements');
  });

  it('serves the audited PII reveal and no longer the client-written reveal log', () => {
    expect(routes).toContain('POST /api/v1/identity/:id/pii/reveal');
    expect(routes).not.toContain('POST /api/v1/audit/pii-reveal');
  });

  it('has no route with a doubled /api/v1/api/v1 prefix', () => {
    expect(routes.filter((r) => r.includes('/api/v1/api/v1'))).toEqual([]);
  });

  it('keeps SCIM 2.0 endpoints outside the global prefix', () => {
    expect(routes.some((r) => r.includes(' /scim/v2/'))).toBe(true);
    expect(routes.some((r) => r.includes('/api/v1/scim/v2'))).toBe(false);
  });

  it('routes a real POST /api/v1/auth/login request to the login handler', async () => {
    login.mockRejectedValueOnce(new UnauthorizedException('Invalid credentials'));
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong-password' })
      .expect(401);
    expect(login).toHaveBeenCalledTimes(1);
  });

  // Express answers a request with the first route that matches it, in registration order (a
  // controller's handlers in declaration order). Controllers sharing a prefix (four use
  // 'identity') register in module order in the app, so none may capture another's routes.
  it('registers no literal route after a parameter route that would answer it', () => {
    const shadowed = routes.flatMap((route, i) =>
      routes
        .slice(0, i)
        .filter((earlier) => captures(earlier, route))
        .map((earlier) => `${route} <- ${earlier}`),
    );
    expect(shadowed).toEqual([]);
  });
});
