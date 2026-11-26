/**
 * POST /auth/login is rate limited across instances: its counters live in the security state
 * store (Redis in production), so a client spreading its password guesses over several API
 * instances meets one limit, not one per instance. While the store fails, login is refused with
 * 503 rather than let through unthrottled; routes without the shared key keep counting in
 * process. Two Nest apps over one MemorySecurityStateStore stand for two instances on one Redis.
 */
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import * as request from 'supertest';
import { authConfig } from '@infrastructure/config/auth.config';
import { RedisModule } from '@infrastructure/cache/redis.module';
import {
  MemorySecurityStateStore,
  SECURITY_STATE_STORE,
  type SecurityStateStore,
} from '@infrastructure/cache/security-state.store';
import { SharedThrottlerStorage } from '@infrastructure/cache/shared-throttler.storage';
import { createUnavailableSecurityStateStore } from '@testing/test-helpers';
import { AuthLocalController } from './auth-local.controller';
import { AuthLocalService } from './auth-local.service';
import { AdminUsersService } from './admin-users.service';

/** The throttlers app.module.ts registers; the login route overrides their limits. */
const THROTTLERS = [
  { name: 'short', ttl: 1000, limit: 10 },
  { name: 'medium', ttl: 60000, limit: 100 },
];

const authService = {
  login: jest.fn().mockRejectedValue(new UnauthorizedException('Invalid credentials')),
  getSetupStatus: jest.fn().mockResolvedValue({ hasAdminUsers: true }),
};

async function instanceOn(store: SecurityStateStore): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ThrottlerModule.forRoot({
        throttlers: THROTTLERS,
        storage: new SharedThrottlerStorage(store),
      }),
    ],
    controllers: [AuthLocalController],
    providers: [
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      { provide: AuthLocalService, useValue: authService },
      { provide: AdminUsersService, useValue: {} },
      { provide: authConfig.KEY, useValue: {} },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

const login = (app: INestApplication) =>
  request(app.getHttpServer()).post('/auth/login').send({ email: 'a@example.com', password: 'x' });

describe('POST /auth/login rate limit', () => {
  const apps: INestApplication[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    // One fixed moment: every request of a test falls in the same throttle window.
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-22T10:00:00Z'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('counts the attempts of a client on every instance against one limit', async () => {
    const store = new MemorySecurityStateStore();
    const instances = [await instanceOn(store), await instanceOn(store)];
    apps.push(...instances);

    const first = await login(instances[0]);
    const limit = Number(first.headers['x-ratelimit-limit-short']);
    expect(first.status).toBe(401);
    expect(limit).toBeGreaterThan(1);

    const second = await login(instances[1]);
    expect(second.status).toBe(401);
    // The other instance already counts the first attempt.
    expect(Number(second.headers['x-ratelimit-remaining-short'])).toBe(limit - 2);

    const statuses: number[] = [];
    for (let attempt = 3; attempt <= limit + 1; attempt++) {
      statuses.push((await login(instances[attempt % 2])).status);
    }
    expect(statuses.slice(0, -1).every((status) => status === 401)).toBe(true);
    expect(statuses[statuses.length - 1]).toBe(429);
    expect(authService.login).toHaveBeenCalledTimes(limit);
  });

  it('refuses login with 503 while the store fails, and other routes still answer', async () => {
    jest.spyOn(Date, 'now').mockRestore();
    const app = await instanceOn(createUnavailableSecurityStateStore());
    apps.push(app);

    const res = await login(app);

    expect(res.status).toBe(503);
    expect(authService.login).not.toHaveBeenCalled();
    await request(app.getHttpServer()).get('/auth/setup-status').expect(200);
  });

  it('gets the security state store into the throttler as app.module wires it', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({})] }),
        RedisModule,
        ThrottlerModule.forRootAsync({
          useFactory: (store: SecurityStateStore) => ({
            throttlers: THROTTLERS,
            storage: new SharedThrottlerStorage(store),
          }),
          inject: [SECURITY_STATE_STORE],
        }),
      ],
      controllers: [AuthLocalController],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: AuthLocalService, useValue: authService },
        { provide: AdminUsersService, useValue: {} },
        { provide: authConfig.KEY, useValue: {} },
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    apps.push(app);
    const store = moduleRef.get<SecurityStateStore>(SECURITY_STATE_STORE);
    const increment = jest.spyOn(store, 'increment');

    await login(app).expect(401);

    expect(increment).toHaveBeenCalledWith(expect.stringMatching(/^throttle:[0-9a-f]{64}$/), 1000);
  });
});
