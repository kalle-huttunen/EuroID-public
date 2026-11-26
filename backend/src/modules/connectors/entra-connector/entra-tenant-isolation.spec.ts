/**
 * Tenant isolation of the Entra ID connector. One worker runs, interleaved: tenant A's onboarding
 * (provision with groups, a license and a directory role, on A's canvas config), tenant B's
 * offboarding (delete by email, which falls back to a lookup by mail, on B's canvas config), and
 * calls that name no config: tenant C's access-review revocation and drift correction (on C's
 * installed Entra ID connector config) and tenant D's revocation (D has installed none: the
 * ENTRA_* environment config). Every token request must carry the credentials of the flow that
 * made it, and every Graph call that flow's token: a config set by one activity must never reach
 * another's calls, and a call without a config gets its own tenant's installed one.
 *
 * The real EntraClient and services run against axios mocks of the token endpoint and Graph that
 * answer on the next turn of the event loop, so the flows take turns call by call. The test tags
 * each flow with an AsyncLocalStorage store to know which flow made each request.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import axios from 'axios';
import { ApplicationFailure } from '@temporalio/common';
import type { ConfigService } from '@nestjs/config';
import type { Cache } from 'cache-manager';
import { EntraClient } from './entra.client';
import { EntraMapper } from './entra.mapper';
import { EntraService } from './entra.service';
import { EntraDiscoveryService } from './entra-discovery.service';
import { EntraEntitlementsService } from './entra-entitlements.service';
import { EntraProvisioningService } from './entra-provisioning.service';
import { EntraTenantConfigService } from './entra-tenant-config.service';
import type { EntraConfig } from './entra.interface';
import { EntraActivities } from '../../../activities/entra.activities';
import { ReviewTargetAccessService } from '../../access-review/review-target-access.service';
import type { ConnectorCircuitBreakerService } from '@infrastructure/resilience/connector-circuit-breaker';
import type { CredentialGenerationService } from '@infrastructure/secrets/credential-generation.service';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import type { EntitlementCatalogService } from '../../entitlement-catalog/entitlement-catalog.service';
import type { ConfigActivities } from '../../../activities/config.activities';
import type { AdService } from '../ad-connector/ad.service';
import type { OktaService } from '../okta-connector/okta.service';
import type { SCIMService } from '../scim-connector/scim.service';
import {
  CorrelationConfigRegistry,
  CONNECTOR_CONFIG_PROVIDER_KEY,
} from '../../correlation-config/correlation-config.registry';
import type { IConnectorConfigProvider } from '../../correlation-config/correlation-config.interface';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { createMockUser } from '@testing/mock-factories';
import type { IdentityService } from '../../identity/identity.service';

jest.mock('axios', () => {
  const actual = jest.requireActual<typeof import('axios')>('axios');
  return {
    __esModule: true,
    default: {
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
      isAxiosError: actual.isAxiosError,
    },
  };
});
const http = axios as unknown as Record<'get' | 'post' | 'patch' | 'delete', jest.Mock>;

type Flow = 'tenant-a' | 'tenant-b' | 'tenant-c' | 'environment';
type Credentials = { tenantId: string; clientId: string; clientSecret: string };

const CONFIG_A: EntraConfig = {
  tenantId: 'entra-tenant-a',
  clientId: 'app-a',
  clientSecret: 'secret-a',
  defaultDomain: 'a.test',
};
const CONFIG_B: EntraConfig = {
  tenantId: 'entra-tenant-b',
  clientId: 'app-b',
  clientSecret: 'secret-b',
  defaultDomain: 'b.test',
};
/** Tenant C's installed Entra ID connector config (ConnectorConfigService), as stored. */
const INSTALLED_C: Record<string, string> = {
  tenantId: 'entra-tenant-c',
  clientId: 'app-c',
  clientSecret: 'secret-c',
  defaultDomain: 'c.test',
  syncIntervalHours: '0',
};
const ENV: Record<string, string> = {
  ENTRA_TENANT_ID: 'entra-tenant-env',
  ENTRA_CLIENT_ID: 'app-env',
  ENTRA_CLIENT_SECRET: 'secret-env',
};
const EXPECTED: Record<Flow, Credentials> = {
  'tenant-a': CONFIG_A,
  'tenant-b': CONFIG_B,
  'tenant-c': {
    tenantId: INSTALLED_C.tenantId,
    clientId: INSTALLED_C.clientId,
    clientSecret: INSTALLED_C.clientSecret,
  },
  environment: {
    tenantId: ENV.ENTRA_TENANT_ID,
    clientId: ENV.ENTRA_CLIENT_ID,
    clientSecret: ENV.ENTRA_CLIENT_SECRET,
  },
};

const GROUP_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ROLE_A = '62e90394-69f5-4237-9190-012177145e10';
const TOKEN_URL = /\/([^/]+)\/oauth2\/v2\.0\/token$/;

/** The access token the mocked token endpoint issues for a set of credentials. */
const tokenFor = (c: Credentials) => `token(${c.tenantId}|${c.clientId}|${c.clientSecret})`;

const flow = new AsyncLocalStorage<Flow>();
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const notFound = () => ({ isAxiosError: true, response: { status: 404, data: {} } });

interface TokenRequest {
  flow?: Flow;
  credentials: Credentials;
}
interface GraphCall {
  flow?: Flow;
  call: string;
  token: string;
}

function mockHttp() {
  const tokenRequests: TokenRequest[] = [];
  const graphCalls: GraphCall[] = [];

  const graph = async (method: string, url: string, headers: Record<string, string>) => {
    const call = `${method} ${url.replace(/^https?:\/\/[^/]+\/v1\.0/, '')}`;
    graphCalls.push({ flow: flow.getStore(), call, token: headers.Authorization });
    await nextTurn();
    return call;
  };

  http.post.mockImplementation(
    async (url: string, body: unknown, options?: { headers: Record<string, string> }) => {
      const tokenUrl = TOKEN_URL.exec(url);
      if (tokenUrl) {
        const form = body as URLSearchParams;
        const credentials = {
          tenantId: decodeURIComponent(tokenUrl[1]),
          clientId: form.get('client_id') ?? '',
          clientSecret: form.get('client_secret') ?? '',
        };
        tokenRequests.push({ flow: flow.getStore(), credentials });
        await nextTurn();
        return { data: { access_token: tokenFor(credentials), expires_in: 3600 } };
      }
      const call = await graph('POST', url, options?.headers ?? {});
      if (call === 'POST /users') {
        const upn = (body as { userPrincipalName: string }).userPrincipalName;
        return { data: { id: 'obj-a', userPrincipalName: upn, mail: upn } };
      }
      return { data: {} };
    },
  );

  http.get.mockImplementation(async (url: string, options: { headers: Record<string, string> }) => {
    const call = await graph('GET', url, options.headers);
    if (call.startsWith('GET /organization')) {
      return { data: { value: [{ verifiedDomains: [{ name: 'a.test' }, { name: 'b.test' }] }] } };
    }
    if (call === 'GET /subscribedSkus') {
      return { data: { value: [{ skuPartNumber: 'E3', skuId: 'sku-e3' }] } };
    }
    if (call.startsWith('GET /users?$filter=')) {
      return {
        data: { value: [{ id: 'obj-b', userPrincipalName: 'robert@b.test', mail: 'bob@b.test' }] },
      };
    }
    if (call.startsWith('GET /users/obj-env/memberOf')) {
      return { data: { value: [{ id: 'g-env', '@odata.type': '#microsoft.graph.group' }] } };
    }
    if (call.startsWith('GET /users/obj-c/memberOf')) {
      return { data: { value: [{ id: 'g-c', '@odata.type': '#microsoft.graph.group' }] } };
    }
    if (call === 'GET /users/carol%40c.test?$select=id') return { data: { id: 'obj-c' } };
    // The new account's licenses, read before the license change: none yet
    if (call === 'GET /users/obj-a?$select=assignedLicenses')
      return { data: { assignedLicenses: [] } };
    throw notFound(); // the UPN lookups: no such user yet
  });

  http.patch.mockImplementation(
    async (url: string, _body: unknown, options: { headers: Record<string, string> }) => {
      await graph('PATCH', url, options.headers);
      return { data: {} };
    },
  );

  http.delete.mockImplementation(
    async (url: string, options: { headers: Record<string, string> }) => {
      const call = await graph('DELETE', url, options.headers);
      if (call === 'DELETE /users/bob%40b.test') throw notFound(); // the email is not the UPN
      return { data: {} };
    },
  );

  return { tokenRequests, graphCalls };
}

/** The Nest cache as an in-memory store whose reads and writes also take a turn. */
function memoryCache(): Cache {
  const store = new Map<string, unknown>();
  return {
    get: jest.fn(async (key: string) => {
      await nextTurn();
      return store.get(key);
    }),
    set: jest.fn(async (key: string, value: unknown) => {
      await nextTurn();
      store.set(key, value);
    }),
    del: jest.fn(async (key: string) => {
      await nextTurn();
      store.delete(key);
    }),
  } as unknown as Cache;
}

/**
 * ConnectorConfigService as the registry hands it out: the installed Entra ID config of the
 * tenant in the request context (`installed` by tenant id), read after a turn like a DB query.
 * `lookups`: the tenant of each read.
 */
function connectorConfigs(installed: Record<string, Record<string, string>>) {
  const lookups: string[] = [];
  const getConfig = jest.fn(async (name: string) => {
    const tenantId = getRequestContext()?.tenantId ?? '';
    lookups.push(tenantId);
    await nextTurn();
    const config = name === 'entra-id' ? installed[tenantId] : undefined;
    return config ? { config } : null;
  });
  const registry = new CorrelationConfigRegistry();
  registry.register(CONNECTOR_CONFIG_PROVIDER_KEY, {
    getConfig,
  } as unknown as IConnectorConfigProvider);
  return { registry, getConfig, lookups };
}

function setup(installed: Record<string, Record<string, string>> = { 'tenant-c': INSTALLED_C }) {
  const config = { get: jest.fn((key: string) => ENV[key]) } as unknown as ConfigService;
  const { registry, getConfig, lookups } = connectorConfigs(installed);
  const breaker = {
    execute: (_connector: string, fn: () => Promise<unknown>) => fn(),
  } as unknown as ConnectorCircuitBreakerService;
  const client = new EntraClient(config, memoryCache(), breaker);
  const discovery = new EntraDiscoveryService(client, config);
  const entitlements = new EntraEntitlementsService(client, config);
  const provisioning = new EntraProvisioningService(
    client,
    new EntraMapper(),
    config,
    discovery,
    entitlements,
    { generatePassword: () => 'Generated-Passw0rd!' } as unknown as CredentialGenerationService,
  );
  const entra = new EntraService(
    discovery,
    provisioning,
    entitlements,
    client,
    new EntraTenantConfigService(registry),
  );
  const activities = new EntraActivities(
    entra,
    { emit: jest.fn() } as unknown as DomainEventEmitterService,
    { absorbDiscovered: jest.fn() } as unknown as EntitlementCatalogService,
    { findIdentityById: jest.fn().mockResolvedValue(null) } as unknown as IdentityService,
  );
  const reviewAccess = new ReviewTargetAccessService(
    {} as ConfigActivities,
    entra,
    {} as AdService,
    {} as OktaService,
    {} as SCIMService,
  );
  return { activities, reviewAccess, getConfig, lookups };
}

describe('Entra ID connector: tenant isolation of concurrent activities', () => {
  beforeEach(() => jest.clearAllMocks());

  it("gives every token request and Graph call the credentials of its own tenant's config", async () => {
    const { tokenRequests, graphCalls } = mockHttp();
    const { activities, reviewAccess, getConfig, lookups } = setup();
    const ada = createMockUser({
      email: 'ada@a.test',
      userPrincipalName: 'ada@a.test',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    const [onboarded, offboarded, revoked, revokedC, disabledC] = await Promise.all([
      flow.run('tenant-a', () =>
        activities.provisionUserToEntra(
          ada,
          {
            operations: [
              { type: 'group', action: 'add', targetId: GROUP_A },
              { type: 'license', action: 'add', targetId: 'E3' },
              { type: 'role', action: 'add', targetId: ROLE_A },
            ],
          },
          CONFIG_A,
          'tenant-a',
          'corr-a',
        ),
      ),
      flow.run('tenant-b', () =>
        activities.deleteUser('bob@b.test', CONFIG_B, 'identity-b', 'tenant-b', 'corr-b', true),
      ),
      // The access-review revocation activity runs the service in its tenant's context
      flow.run('environment', () =>
        withTenantContext('tenant-d', () =>
          reviewAccess.revoke(
            'entra',
            { nativeId: 'g-env', accountId: 'obj-env' },
            { email: 'eve@env.test' },
            'tenant-d',
          ),
        ),
      ),
      flow.run('tenant-c', () =>
        withTenantContext('tenant-c', () =>
          reviewAccess.revoke(
            'entra',
            { nativeId: 'g-c', accountId: 'obj-c' },
            { email: 'carol@c.test' },
            'tenant-c',
          ),
        ),
      ),
      // Drift correction: no config named, the activity sets the tenant context
      flow.run('tenant-c', () => activities.disableEntraUser('carol@c.test', 'tenant-c', 'corr-c')),
    ]);

    // The flows did their work, so the checks below cover all of their calls
    expect(onboarded).toMatchObject({ success: true, objectId: 'obj-a' });
    expect(offboarded).toEqual({ success: true, outcome: 'deprovisioned' });
    expect(revoked).toMatchObject({ outcome: 'removed' });
    expect(revokedC).toMatchObject({ outcome: 'removed' });
    expect(disabledC).toBe(true);
    // Calls without a config looked up their own tenant's installed config; canvas configs none
    expect(getConfig).toHaveBeenCalledWith('entra-id');
    expect(new Set(lookups)).toEqual(new Set(['tenant-c', 'tenant-d']));
    const callsOf = (f: Flow) => graphCalls.filter((c) => c.flow === f).map((c) => c.call);
    expect(callsOf('tenant-a')).toEqual(
      expect.arrayContaining([
        'GET /organization?$select=verifiedDomains',
        'POST /users',
        `POST /groups/${GROUP_A}/members/$ref`,
        'GET /users/obj-a?$select=assignedLicenses',
        'GET /subscribedSkus',
        'POST /users/obj-a/assignLicense',
        'POST /roleManagement/directory/roleAssignments',
      ]),
    );
    expect(callsOf('tenant-b')).toEqual(
      expect.arrayContaining([
        'DELETE /users/bob%40b.test',
        expect.stringMatching(/^GET \/users\?\$filter=/),
        'DELETE /users/obj-b',
      ]),
    );
    expect(callsOf('environment')).toEqual([
      'GET /users/obj-env/memberOf?$select=id,displayName',
      'DELETE /groups/g-env/members/obj-env/$ref',
    ]);
    expect(callsOf('tenant-c')).toEqual(
      expect.arrayContaining([
        'GET /users/obj-c/memberOf?$select=id,displayName',
        'DELETE /groups/g-c/members/obj-c/$ref',
        'GET /users/carol%40c.test?$select=id',
        'PATCH /users/obj-c',
      ]),
    );

    // Each flow authenticated with its own config only
    expect(tokenRequests.length).toBeGreaterThanOrEqual(4);
    expect(
      tokenRequests.filter(
        (r) => !r.flow || tokenFor(r.credentials) !== tokenFor(EXPECTED[r.flow]),
      ),
    ).toEqual([]);
    // ... and every Graph call carried that flow's token
    expect(
      graphCalls.filter((c) => !c.flow || c.token !== `Bearer ${tokenFor(EXPECTED[c.flow])}`),
    ).toEqual([]);
  });

  it("never signs a tenant's call in with ENTRA_* when its installed config is incomplete", async () => {
    const { tokenRequests, graphCalls } = mockHttp();
    const { activities, reviewAccess } = setup({
      'tenant-c': { ...INSTALLED_C, clientSecret: '' },
    });

    const revocation = withTenantContext('tenant-c', () =>
      reviewAccess.revoke(
        'entra',
        { nativeId: 'g-c', accountId: 'obj-c' },
        { email: 'carol@c.test' },
        'tenant-c',
      ),
    );
    const err = await Promise.resolve(revocation).catch((e: unknown) => e);
    const disable = await activities
      .disableEntraUser('carol@c.test', 'tenant-c', 'corr-c')
      .catch((e: unknown) => e);

    // A configuration error (400) naming the empty field, which the activity fails without retry
    expect(err).toBeInstanceOf(ConnectorException);
    expect((err as ConnectorException).getStatus()).toBe(400);
    expect(disable).toBeInstanceOf(ApplicationFailure);
    expect((disable as ApplicationFailure).nonRetryable).toBe(true);
    for (const e of [err, disable]) expect((e as Error).message).toContain('clientSecret');
    expect(tokenRequests).toEqual([]);
    expect(graphCalls).toEqual([]);
  });

  it('rejects a canvas config with an empty client secret instead of using ENTRA_CLIENT_SECRET', async () => {
    const { tokenRequests } = mockHttp();
    const { activities } = setup();
    const ada = createMockUser({ email: 'ada@a.test', firstName: 'Ada', lastName: 'Lovelace' });

    const err = await activities
      .provisionUserToEntra(ada, undefined, { ...CONFIG_A, clientSecret: '' }, 'tenant-a', 'c')
      .catch((e: unknown) => e);

    // The configuration error (400) fails the activity without retry
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
    expect((err as Error).message).toContain('empty: clientSecret');
    expect((err as Error).message).toContain('(HTTP 400)');
    expect(tokenRequests).toEqual([]);
  });
});
