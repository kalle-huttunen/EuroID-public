/**
 * A revocation (revokeAllSessions; a password change and a deactivation work the same way) bumps
 * the admin's tokenVersion in the database. JwtAuthGuard reads isActive and tokenVersion from the
 * database on every request and caches nothing, so the old token is refused from the next request
 * on, on every instance. Two windows the former 30 s admin cache left open stay closed:
 * - a request that read the admin just before the revocation committed cannot re-cache the old
 *   tokenVersion for the requests after it;
 * - when the revoking instance cannot reach Redis, the other instances do not keep reading an old
 *   cached copy from it.
 */
import { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { SignJWT } from 'jose';
import { JwtAuthGuard } from '@infrastructure/auth/jwt-auth.guard';
import {
  RedisSecurityStateStore,
  type SecurityStateRedisClient,
} from '@infrastructure/cache/security-state.store';
import { AuthLocalService } from './auth-local.service';

const SECRET = 'test-secret';
const config = {
  get: (key: string) => (key === 'JWT_SECRET' ? SECRET : undefined),
} as unknown as ConfigService;

/** A Redis server (a map) shared by its clients; each client can lose its connection alone. */
function fakeRedisServer() {
  const data = new Map<string, string>();
  const client = (): SecurityStateRedisClient & { reachable: boolean } => {
    const self = {
      reachable: true,
      call: <T>(fn: () => T): Promise<T> =>
        self.reachable
          ? Promise.resolve(fn())
          : Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379')),
    };
    return Object.assign(self, {
      get: (key: string) => self.call(() => data.get(key) ?? null),
      set: (key: string, value: string) =>
        self.call(() => {
          data.set(key, value);
          return 'OK';
        }),
      del: (key: string) => self.call(() => (data.delete(key) ? 1 : 0)),
      eval: () => self.call(() => null),
      quit: () => Promise.resolve('OK'),
    }) as unknown as SecurityStateRedisClient & { reachable: boolean };
  };
  return { data, client };
}

/**
 * The admin collection. `pauseReads` holds every findById answer until `releaseReads`, with the
 * document as it was when the guard asked: a read that started before a revocation committed.
 */
function setup() {
  const admin = { _id: 'admin-1', tenantId: 'tenant-a', isActive: true, tokenVersion: 0 };
  let paused: Array<() => void> | null = null;
  const adminModel = {
    findById: jest.fn(() => {
      const snapshot = { ...admin };
      return {
        lean: () =>
          new Promise((resolve) => {
            if (paused) paused.push(() => resolve(snapshot));
            else resolve(snapshot);
          }),
      };
    }),
    updateOne: jest.fn(async (_filter: unknown, update: { $inc: { tokenVersion: number } }) => {
      admin.tokenVersion += update.$inc.tokenVersion;
      return { matchedCount: 1 };
    }),
  };
  const server = fakeRedisServer();
  const instance = () => {
    const client = server.client();
    const store = new RedisSecurityStateStore(client);
    return {
      client,
      store,
      guard: new JwtAuthGuard(config, new Reflector(), adminModel as never, {} as never, store, {
        assertActive: async () => undefined,
      } as never),
      auth: new AuthLocalService(
        adminModel as never,
        {} as never,
        config,
        {} as never,
        {} as never,
        {} as never,
        store,
      ),
    };
  };
  return {
    admin,
    adminModel,
    server,
    instance,
    pauseReads: () => {
      paused = [];
    },
    releaseReads: () => {
      const pending = paused ?? [];
      paused = null;
      pending.forEach((release) => release());
    },
  };
}

function tokenFor(tokenVersion: number): Promise<string> {
  return new SignJWT({ sub: 'admin-1', roles: ['super-admin'], tenantId: 'tenant-a', tokenVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('euroid-local')
    .setAudience('euroid-api')
    .sign(new TextEncoder().encode(SECRET));
}

function requestWith(token: string): ExecutionContext {
  const request = { headers: { authorization: `Bearer ${token}` } };
  return {
    getHandler: () => () => undefined,
    getClass: () => class Probe {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('session revocation', () => {
  it('a request that read the admin before the revocation leaves nothing that lets the old token in', async () => {
    const { adminModel, pauseReads, releaseReads, instance, server } = setup();
    const node = instance();
    const oldToken = await tokenFor(0);

    // The request reads the admin (tokenVersion 0), the revocation commits, then the read returns.
    pauseReads();
    const inFlight = node.guard.canActivate(requestWith(oldToken));
    while (adminModel.findById.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await expect(node.auth.revokeAllSessions('admin-1', 'tenant-a')).resolves.toBe(true);
    releaseReads();
    await expect(inFlight).resolves.toBe(true); // it started before the revocation

    expect(server.data.size).toBe(0); // no copy of tokenVersion 0 was cached
    await expect(node.guard.canActivate(requestWith(oldToken))).rejects.toThrow(
      'Token revoked or user deactivated',
    );
    await expect(node.guard.canActivate(requestWith(await tokenFor(1)))).resolves.toBe(true);
    await node.store.onModuleDestroy();
  });

  it('another instance refuses the old token at once while the revoking instance cannot reach Redis', async () => {
    const { instance, server } = setup();
    const revoking = instance();
    const other = instance();
    const oldToken = await tokenFor(0);
    await expect(other.guard.canActivate(requestWith(oldToken))).resolves.toBe(true);
    // Worst case: Redis still holds an active tokenVersion-0 entry in the former cache's format.
    server.data.set(
      'admincache:admin-1',
      JSON.stringify({ isActive: true, tokenVersion: 0, expiresAt: Date.now() + 30_000 }),
    );

    revoking.client.reachable = false;
    await expect(revoking.auth.revokeAllSessions('admin-1', 'tenant-a')).resolves.toBe(true);

    // No resend of a delete and no 30 s expiry to wait for: the next request is refused.
    await expect(other.guard.canActivate(requestWith(oldToken))).rejects.toThrow(
      'Token revoked or user deactivated',
    );
    await expect(revoking.guard.canActivate(requestWith(oldToken))).rejects.toThrow(
      'Token revoked or user deactivated',
    );
    await expect(other.guard.canActivate(requestWith(await tokenFor(1)))).resolves.toBe(true);
    await revoking.store.onModuleDestroy();
    await other.store.onModuleDestroy();
  });

  it('a deactivated admin is refused on the next request too', async () => {
    const { admin, instance } = setup();
    const node = instance();
    const token = await tokenFor(0);
    await expect(node.guard.canActivate(requestWith(token))).resolves.toBe(true);

    admin.isActive = false;

    await expect(node.guard.canActivate(requestWith(token))).rejects.toThrow(
      'Token revoked or user deactivated',
    );
    await node.store.onModuleDestroy();
  });
});
