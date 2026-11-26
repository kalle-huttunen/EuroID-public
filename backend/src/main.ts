// OTel MUST be initialized before any instrumented libraries (HTTP, MongoDB) are loaded.
import './infrastructure/observability/tracing';

import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { resolve } from 'path';
import { existsSync, writeFileSync } from 'fs';
import { AppModule } from './app.module';
import { ZodValidationPipe } from '@anatine/zod-nestjs';
import helmet from 'helmet';
import * as cookieParser from 'cookie-parser';
import { emptyBodyAsObject } from './infrastructure/middleware/empty-body.middleware';
import { MetricsService } from './infrastructure/observability/metrics.service';
import { createLoggerConfig } from './infrastructure/observability/logger.config';
import {
  API_GLOBAL_PREFIX,
  API_GLOBAL_PREFIX_OPTIONS,
} from './infrastructure/config/global-prefix';
import { backendRootOf } from './infrastructure/config/backend-root';
import { isDevOrTest } from './infrastructure/config/runtime-env';
import { trustProxySetting } from './infrastructure/config/trust-proxy';
import { metricsTokenMatches } from './infrastructure/observability/metrics-token';

// Load .env before any module: same path order as app.module (backend/.env, cwd/.env, cwd/backend/.env).
const backendDir = backendRootOf(__dirname);
const envPaths = [
  resolve(backendDir, '.env'),
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), 'backend', '.env'),
].filter((p) => existsSync(p));
const envPath = envPaths[0];
if (envPath) {
  try {
    require('dotenv').config({ path: envPath });
  } catch {
    // ConfigModule will still try to load from its envFilePath in app.module
  }
}

async function bootstrap() {
  const logger = createLoggerConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger,
  });

  const config = app.get(ConfigService);
  // Development conveniences (Swagger, an open /metrics, a weak JWT_SECRET) only in development and
  // test: staging, pre-prod and an unset NODE_ENV get the production rules (runtime-env.ts).
  const devOrTest = isDevOrTest();

  // Validate JWT_SECRET strength when auth is enabled (never log the secret)
  if (config.get('auth.AUTH_DISABLED') !== 'true') {
    const jwtSecret = config.get<string>('auth.JWT_SECRET');
    if (jwtSecret) {
      if (jwtSecret.length < 32) {
        console.error('[FATAL] JWT_SECRET must be at least 32 characters.');
        if (!devOrTest) process.exit(1);
      }
      if (jwtSecret.includes('change-this') || jwtSecret === 'secret') {
        console.error('[FATAL] JWT_SECRET appears to be a placeholder. Generate a real secret.');
        if (!devOrTest) process.exit(1);
      }
    }
  }

  // 0. Trust proxy (TRUST_PROXY, one reverse proxy by default): which X-Forwarded-For hops
  // request.ip believes. Set it to false when the API is reached directly, or a client chooses the
  // address the IP rate limits count.
  app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY));

  // 1. CORS: Restrict access via CORS_ORIGINS env var (comma-separated)
  const isDev = devOrTest;
  const corsOriginsRaw = config.get<string>('CORS_ORIGINS');
  const corsOrigins = corsOriginsRaw
    ? corsOriginsRaw.split(',').map((o) => o.trim())
    : isDev
      ? ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:3001']
      : [];

  // 2. SECURITY: Helmet with explicit CSP, HSTS, referrer policy
  const cspDirectives: Record<string, string[]> = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:'],
    connectSrc: ["'self'", ...corsOrigins],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
  };
  const cspReportUri = config.get<string>('CSP_REPORT_URI');
  if (cspReportUri) {
    cspDirectives['report-uri'] = [cspReportUri];
  }
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: cspDirectives,
        reportOnly: config.get('CSP_REPORT_ONLY') === 'true',
      },
      hsts: {
        maxAge: 63072000,
        includeSubDomains: true,
        preload: true,
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  app.enableCors({
    origin: corsOrigins,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // Cookie parser: required for httpOnly auth cookies (FA-1)
  app.use(cookieParser());

  // A request without a body gets {} (Express 5 leaves it undefined): see the middleware.
  app.use(emptyBodyAsObject);

  // 2b. WebSocket: Use Socket.IO adapter for real-time gateway
  app.useWebSocketAdapter(new IoAdapter(app));

  // 2c. Exception filters (order matters: specific filters override the catch-all)
  const { globalExceptionFilters } = await import('./shared/filters/global-exception-filters');
  app.useGlobalFilters(...globalExceptionFilters(app.get(HttpAdapterHost)));

  // 3. VALIDATION: Zod schemas at API boundary (CLAUDE.md Safety Rule 4)
  app.useGlobalPipes(new ZodValidationPipe());

  // 4. VERSIONING: Move everything to /api/v1 (exclude SCIM 2.0 endpoints)
  app.setGlobalPrefix(API_GLOBAL_PREFIX, API_GLOBAL_PREFIX_OPTIONS);

  // 4b. METRICS: Prometheus scrape endpoint (outside /api/v1). When METRICS_TOKEN is set, require Bearer token.
  const metricsService = app.get(MetricsService);
  const metricsToken = config.get<string>('METRICS_TOKEN');
  if (!metricsToken && !devOrTest) {
    logger.warn(
      '[METRICS] METRICS_TOKEN is not set — /metrics endpoint is disabled outside development and test. Set METRICS_TOKEN to enable.',
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Express req/res types from getHttpAdapter().get() are untyped
  app.getHttpAdapter().get('/metrics', async (req: any, res: any) => {
    if (!metricsToken) {
      // Outside development and test, require a token. In dev, allow unauthenticated access.
      if (!devOrTest) {
        res.status(403).json({ message: 'METRICS_TOKEN not configured' });
        return;
      }
    } else {
      if (!metricsTokenMatches(req.headers?.['authorization'], metricsToken)) {
        res.status(403).end();
        return;
      }
    }
    res.setHeader('Content-Type', metricsService.registry.contentType);
    res.send(await metricsService.registry.metrics());
  });

  // 5. DOCUMENTATION: Swagger UI only in development and test (dynamic import — devDeps only)
  if (devOrTest) {
    const { DocumentBuilder, SwaggerModule } = await import('@nestjs/swagger');
    const config = new DocumentBuilder()
      .setTitle('EuroID API')
      .setDescription('The Sovereign Identity Platform API')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'jwt')
      .addTag('Identity')
      .addTag('Policy Engine')
      .addTag('Onboarding')
      .addTag('Connectors')
      .addTag('Entitlement Catalog')
      .addTag('Role Bundles')
      .addTag('Reconciliation')
      .addTag('Health')
      .addTag('Audit')
      .addTag('Dead Letter Queue')
      .addTag('Dev Tools')
      .addTag('Blueprints')
      .addTag('Batch Provisioning')
      .addTag('Bulk Provisioning')
      .addTag('Anomaly Detection')
      .addTag('Access Reviews')
      .addTag('Predictive Analytics')
      .addTag('SCIM Tokens')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);

    // AI JSON: Write OpenAPI spec for Frontend Agent (source of truth for endpoints, DTOs, validation)
    const specPath = resolve(backendDir, '..', 'swagger-spec.json');
    writeFileSync(specPath, JSON.stringify(document, null, 2));
  }

  const port = parseInt(config.get<string>('PORT') ?? '3001', 10);
  await app.listen(port);
  const url = await app.getUrl();
  logger.log(`Application is running on: ${url}/api/v1`);
  if (devOrTest) {
    logger.log(`Swagger Docs available at: ${url}/api/docs`);
  }
}
bootstrap();
