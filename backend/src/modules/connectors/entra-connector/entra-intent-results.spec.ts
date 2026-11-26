/**
 * What provision() reports for each group, directory role and license change of its intent:
 * applied, unchanged (already as requested) or failed with the reason and the status. Nothing
 * Graph refuses is passed over, a group name no group has is a failed change, and a license is
 * removed as well as added. The other changes of the call are still made.
 *
 * The real EntraClient, EntraProvisioningService and EntraEntitlementsService run against axios
 * mocks of the token endpoint and Graph, answering as Microsoft documents it (error bodies
 * `{ error: { code, message } }`). Not run against a live tenant.
 */
import axios from 'axios';
import type { ConfigService } from '@nestjs/config';
import type { Cache } from 'cache-manager';
import { EntraClient } from './entra.client';
import { EntraMapper } from './entra.mapper';
import { EntraDiscoveryService } from './entra-discovery.service';
import { EntraEntitlementsService } from './entra-entitlements.service';
import { EntraProvisioningService } from './entra-provisioning.service';
import type { ProvisioningIntent } from './entra.interface';
import type { ConnectorCircuitBreakerService } from '@infrastructure/resilience/connector-circuit-breaker';
import type { CredentialGenerationService } from '@infrastructure/secrets/credential-generation.service';
import { createMockUser } from '@testing/mock-factories';

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

const GRAPH = 'https://graph.microsoft.com/v1.0';
const USER = 'obj-1';
const FINANCE = '11111111-1111-1111-1111-111111111111';
const SALES = '22222222-2222-2222-2222-222222222222';
const E3 = 'sku-e3-0000';
const E5 = 'sku-e5-0000';
const HELPDESK = '729827e3-9c14-49f7-bb1b-9608f156bbb8';

type Answer = { status?: number; data?: unknown; error?: { code: string; message: string } };
type Route = { method: keyof typeof http; path: RegExp; answer: (body?: unknown) => Answer };

let routes: Route[];

function answerFor(method: keyof typeof http, url: string, body?: unknown) {
  if (url.includes('/oauth2/v2.0/token')) {
    return Promise.resolve({ data: { access_token: 'token', expires_in: 3600 } });
  }
  const path = decodeURIComponent(url.replace(GRAPH, ''));
  const route = routes.find((r) => r.method === method && r.path.test(path));
  if (!route) return Promise.reject(new Error(`unexpected Graph call: ${method} ${path}`));
  const { status = 200, data = {}, error } = route.answer(body);
  if (status < 400) return Promise.resolve({ status, data });
  // A Graph error answer as axios rejects with it
  return Promise.reject({
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: { status, data: { error }, headers: {} },
  });
}

/** A Graph answer: the data, or an error with Graph's code and message. */
const ok = (data: unknown = {}): Answer => ({ data });
const refused = (status: number, code: string, message: string) => (): Answer => ({
  status,
  error: { code, message },
});

function baseRoutes(): Route[] {
  return [
    // The account exists: provision() updates it, then runs the intent
    {
      method: 'get',
      path: /^\/users\/ada@corp\.test\?\$select=id$/,
      answer: () => ok({ id: USER }),
    },
    { method: 'patch', path: /^\/users\/obj-1$/, answer: () => ok() },
    {
      method: 'get',
      path: /^\/subscribedSkus$/,
      answer: () =>
        ok({
          value: [
            { skuPartNumber: 'ENTERPRISEPACK', skuId: E3, consumedUnits: 1 },
            { skuPartNumber: 'ENTERPRISEPREMIUM', skuId: E5, consumedUnits: 1 },
          ],
        }),
    },
  ];
}

function setup() {
  const env: Record<string, string> = {
    ENTRA_TENANT_ID: 'tenant',
    ENTRA_CLIENT_ID: 'client',
    ENTRA_CLIENT_SECRET: 'secret',
    ENTRA_DEFAULT_DOMAIN: 'corp.test',
  };
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  const client = new EntraClient(
    config,
    { get: async () => undefined, set: async () => undefined } as unknown as Cache,
    {
      execute: (_c: string, fn: () => Promise<unknown>) => fn(),
    } as unknown as ConnectorCircuitBreakerService,
  );
  const entitlements = new EntraEntitlementsService(client, config);
  const provisioning = new EntraProvisioningService(
    client,
    new EntraMapper(),
    config,
    new EntraDiscoveryService(client, config),
    entitlements,
    {} as CredentialGenerationService,
  );
  return { provisioning };
}

const user = createMockUser({ email: 'ada@corp.test', userPrincipalName: 'ada@corp.test' });
const run = (operations: ProvisioningIntent['operations']) =>
  setup().provisioning.provision(user, { operations });

/** The Graph calls made with this method, as path (without the base URL) and body. */
const calls = (method: keyof typeof http) =>
  http[method].mock.calls
    .map(([url, body]) => [decodeURIComponent(String(url).replace(GRAPH, '')), body])
    .filter(([path]) => !String(path).includes('/oauth2/'));

beforeEach(() => {
  routes = baseRoutes();
  for (const method of ['get', 'post', 'patch', 'delete'] as const) {
    http[method].mockReset();
    http[method].mockImplementation((url: string, ...rest: unknown[]) =>
      answerFor(method, url, method === 'get' || method === 'delete' ? undefined : rest[0]),
    );
  }
});

describe('provision() reports each group change', () => {
  it('reports a membership Graph refuses as failed and still makes the other changes', async () => {
    routes.push(
      {
        method: 'post',
        path: new RegExp(`^/groups/${FINANCE}/members/\\$ref$`),
        answer: refused(
          403,
          'Authorization_RequestDenied',
          'Insufficient privileges to complete the operation.',
        ),
      },
      {
        method: 'delete',
        path: new RegExp(`^/groups/${SALES}/members/obj-1/\\$ref$`),
        answer: () => ({ status: 204 }),
      },
    );

    const result = await run([
      { type: 'group', action: 'add', targetId: FINANCE },
      { type: 'group', action: 'remove', targetId: SALES },
    ]);

    expect(result.targetUserId).toBe(USER);
    expect(result.operations).toEqual([
      {
        type: 'group',
        action: 'add',
        targetId: FINANCE,
        outcome: 'failed',
        reason: expect.stringContaining('Authorization_RequestDenied'),
        status: 400,
      },
      { type: 'group', action: 'remove', targetId: SALES, outcome: 'applied' },
    ]);
  });

  it('reports a membership that already exists, or is already gone, as unchanged', async () => {
    routes.push(
      {
        method: 'post',
        path: /\/members\/\$ref$/,
        answer: refused(
          400,
          'Request_BadRequest',
          "One or more added object references already exist for the following modified properties: 'members'.",
        ),
      },
      {
        method: 'delete',
        path: /\/members\/obj-1\/\$ref$/,
        answer: refused(404, 'Request_ResourceNotFound', "Resource 'obj-1' does not exist."),
      },
    );

    const result = await run([
      { type: 'group', action: 'add', targetId: FINANCE },
      { type: 'group', action: 'remove', targetId: SALES },
    ]);

    expect(result.operations?.map((op) => op.outcome)).toEqual(['unchanged', 'unchanged']);
  });

  it('fails a group name no group has, with that reason, instead of skipping it', async () => {
    routes.push({ method: 'get', path: /^\/groups\?\$filter=/, answer: () => ok({ value: [] }) });

    const result = await run([{ type: 'group', action: 'add', targetId: 'Finance Team' }]);

    expect(result.operations).toEqual([
      {
        type: 'group',
        action: 'add',
        targetId: 'Finance Team',
        outcome: 'failed',
        reason: expect.stringContaining('Finance Team'),
        status: 422,
      },
    ]);
    expect(calls('post')).toEqual([]);
  });

  it('adds by a group name that resolves', async () => {
    routes.push(
      {
        method: 'get',
        path: /^\/groups\?\$filter=displayName eq 'Finance Team'&\$select=id$/,
        answer: () => ok({ value: [{ id: FINANCE }] }),
      },
      { method: 'post', path: /\/members\/\$ref$/, answer: () => ({ status: 204 }) },
    );

    const result = await run([{ type: 'group', action: 'add', targetId: 'Finance Team' }]);

    expect(result.operations?.[0].outcome).toBe('applied');
    expect(calls('post')).toEqual([
      [
        `/groups/${FINANCE}/members/$ref`,
        { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${USER}` },
      ],
    ]);
  });

  it('fails the change when Graph cannot be asked for the group (retryable status)', async () => {
    routes.push({
      method: 'get',
      path: /^\/groups\?\$filter=/,
      answer: refused(503, 'serviceNotAvailable', 'The service is temporarily unavailable.'),
    });

    const result = await run([{ type: 'group', action: 'remove', targetId: 'Sales' }]);

    expect(result.operations).toEqual([
      expect.objectContaining({ outcome: 'failed', status: 502 }),
    ]);
  });
});

describe('provision() reports each license change', () => {
  const assigned = (...skuIds: string[]): Route => ({
    method: 'get',
    path: /^\/users\/obj-1\?\$select=assignedLicenses$/,
    answer: () => ok({ assignedLicenses: skuIds.map((skuId) => ({ disabledPlans: [], skuId })) }),
  });
  const assignLicense: Route = {
    method: 'post',
    path: /^\/users\/obj-1\/assignLicense$/,
    answer: () => ok({ id: USER }),
  };

  it('removes a license the user has (removeLicenses) and adds one it lacks', async () => {
    routes.push(assigned(E3), assignLicense);

    const result = await run([
      { type: 'license', action: 'remove', targetId: 'ENTERPRISEPACK' },
      { type: 'license', action: 'add', targetId: 'ENTERPRISEPREMIUM' },
    ]);

    expect(result.operations?.map((op) => op.outcome)).toEqual(['applied', 'applied']);
    expect(calls('post')).toEqual([
      ['/users/obj-1/assignLicense', { addLicenses: [], removeLicenses: [E3] }],
      [
        '/users/obj-1/assignLicense',
        { addLicenses: [{ skuId: E5, disabledPlans: [] }], removeLicenses: [] },
      ],
    ]);
  });

  it('reports a license already as requested as unchanged, without calling assignLicense', async () => {
    routes.push(assigned(E5), assignLicense);

    const result = await run([
      { type: 'license', action: 'remove', targetId: 'ENTERPRISEPACK' },
      { type: 'license', action: 'add', targetId: 'ENTERPRISEPREMIUM' },
    ]);

    expect(result.operations?.map((op) => op.outcome)).toEqual(['unchanged', 'unchanged']);
    expect(calls('post')).toEqual([]);
  });

  it('fails a removal Graph refuses and a SKU the tenant does not have', async () => {
    routes.push(assigned(E3), {
      method: 'post',
      path: /^\/users\/obj-1\/assignLicense$/,
      answer: refused(
        400,
        'Request_BadRequest',
        'User license is inherited from a group membership and it cannot be removed directly from the user.',
      ),
    });

    const result = await run([
      { type: 'license', action: 'remove', targetId: 'ENTERPRISEPACK' },
      { type: 'license', action: 'add', targetId: 'NO_SUCH_SKU' },
    ]);

    expect(result.operations).toEqual([
      expect.objectContaining({
        action: 'remove',
        outcome: 'failed',
        reason: expect.stringContaining('inherited from a group membership'),
        status: 400,
      }),
      expect.objectContaining({
        action: 'add',
        outcome: 'failed',
        reason: 'License SKU "NO_SUCH_SKU" not found',
        status: 400,
      }),
    ]);
  });
});

describe('provision() reports each directory role change', () => {
  it('reports assignments made, already there, refused and removed', async () => {
    routes.push(
      {
        method: 'post',
        path: /^\/roleManagement\/directory\/roleAssignments$/,
        answer: (body) =>
          (body as { roleDefinitionId: string }).roleDefinitionId === HELPDESK
            ? ok({ id: 'assignment-1' })
            : refused(
                403,
                'Authorization_RequestDenied',
                'Insufficient privileges to complete the operation.',
              )(),
      },
      {
        method: 'get',
        path: /^\/roleManagement\/directory\/roleAssignments\?\$filter=/,
        answer: () =>
          ok({ value: [{ id: 'assignment-9', principalId: USER, roleDefinitionId: 'old-role' }] }),
      },
      {
        method: 'delete',
        path: /^\/roleManagement\/directory\/roleAssignments\/assignment-9$/,
        answer: () => ({ status: 204 }),
      },
    );

    const result = await run([
      { type: 'role', action: 'add', targetId: HELPDESK },
      { type: 'role', action: 'add', targetId: 'global-admin' },
      { type: 'role', action: 'remove', targetId: 'old-role' },
    ]);

    expect(result.operations?.map(({ targetId, outcome }) => [targetId, outcome])).toEqual([
      [HELPDESK, 'applied'],
      ['global-admin', 'failed'],
      ['old-role', 'applied'],
    ]);
  });

  it('reports a role assignment that is not there as unchanged on removal', async () => {
    routes.push({
      method: 'get',
      path: /^\/roleManagement\/directory\/roleAssignments\?\$filter=/,
      answer: () => ok({ value: [] }),
    });

    const result = await run([{ type: 'role', action: 'remove', targetId: 'old-role' }]);

    expect(result.operations?.[0].outcome).toBe('unchanged');
    expect(calls('delete')).toEqual([]);
  });
});

describe('provision() with an operation type Entra ID has no handling for', () => {
  it('reports it as failed instead of ignoring it', async () => {
    const result = await run([
      { type: 'directoryrole' as 'role', action: 'add', targetId: HELPDESK },
    ]);

    expect(result.operations).toEqual([
      expect.objectContaining({ outcome: 'failed', status: 400, targetId: HELPDESK }),
    ]);
  });
});

// HX-E2: an access request's expiry removes a license the tenant may no longer subscribe to; a
// user cannot hold a license of a SKU the tenant does not have, so the removal is already done
describe('provision() removing a license of a SKU the tenant does not have', () => {
  it('reports the removal unchanged, without calling assignLicense', async () => {
    routes.push({
      method: 'get',
      path: /^\/users\/obj-1\?\$select=assignedLicenses$/,
      answer: () => ok({ assignedLicenses: [{ disabledPlans: [], skuId: E3 }] }),
    });

    const result = await run([{ type: 'license', action: 'remove', targetId: 'RETIRED_SKU' }]);

    expect(result.operations).toEqual([
      { type: 'license', action: 'remove', targetId: 'RETIRED_SKU', outcome: 'unchanged' },
    ]);
    expect(calls('post')).toEqual([]);
  });
});

// HX-E2: access request fulfilment and expiry change the entitlement on the account and nothing
// else; provision() PATCHed the profile attributes it was given and could create the account
describe('changeEntitlements() on an account', () => {
  it('runs the group and license changes and writes no attribute and no account', async () => {
    routes.push(
      { method: 'post', path: /\/members\/\$ref$/, answer: () => ({ status: 204 }) },
      {
        method: 'get',
        path: /^\/users\/obj-1\?\$select=assignedLicenses$/,
        answer: () => ok({ assignedLicenses: [{ disabledPlans: [], skuId: E3 }] }),
      },
      {
        method: 'post',
        path: /^\/users\/obj-1\/assignLicense$/,
        answer: () => ok({ id: USER }),
      },
    );

    const operations = await setup().provisioning.changeEntitlements(USER, {
      operations: [
        { type: 'group', action: 'add', targetId: FINANCE },
        { type: 'license', action: 'remove', targetId: 'ENTERPRISEPACK' },
      ],
    });

    expect(operations.map((op) => op.outcome)).toEqual(['applied', 'applied']);
    expect(calls('patch')).toEqual([]);
    expect(calls('post')).toEqual([
      [
        `/groups/${FINANCE}/members/$ref`,
        { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${USER}` },
      ],
      ['/users/obj-1/assignLicense', { addLicenses: [], removeLicenses: [E3] }],
    ]);
    // No lookup by UPN either: the caller names the account
    expect(calls('get').map(([path]) => path)).not.toContainEqual(
      expect.stringContaining('ada@corp.test'),
    );
  });
});
