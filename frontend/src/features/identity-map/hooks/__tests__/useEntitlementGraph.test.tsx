import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { useIdentityEntitlements } from '../useIdentityEntitlements';
import { useEntitlementGraph } from '../useEntitlementGraph';

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn(), post: vi.fn() },
}));

const get = vi.mocked(axiosInstance.get);

const ID = '6650aaaaaaaaaaaaaaaaaaaa';
const API = '/api/v1';

const profile = {
  firstName: 'Matti',
  lastName: 'Virtanen',
  displayName: 'Matti Virtanen',
  email: 'm•••@example.com',
  departmentName: 'Engineering',
  jobTitle: 'Senior Developer',
  status: 'ACTIVE',
};

// The API responses the map reads, shaped as the backend sends them.
const responses: Record<string, unknown> = {
  // GET /identity/:id: the flat projection; it has no provisioning.
  [`${API}/identity/${ID}`]: { ...profile, _id: ID, tenantId: 'dev-tenant', metadata: {} },
  // GET /identity/v2/:id: the whole identity document, provisioning included. Onboarding
  // records Entra ID as 'entra'; policies, drifts and the catalogue say 'entra-id'.
  [`${API}/identity/v2/${ID}`]: {
    found: true,
    identity: {
      _id: ID,
      tenantId: 'dev-tenant',
      profile,
      sources: [{ sourceName: 'hr-csv', externalId: 'E1001', rawData: {} }],
      controls: { isLoginDisabled: false },
      provisioning: [
        { targetSystem: 'entra', status: 'SYNCED', lastSync: '2026-11-22T04:00:00.000Z' },
        { targetSystem: 'active-directory', status: 'SYNCED' },
        { targetSystem: 'github', status: 'ERROR', errorMsg: 'GitHub API returned 502' },
        { targetSystem: 'okta', status: 'DEPROVISIONED' },
      ],
      metadata: {},
    },
  },
  // GET /identity/:id/entitlements: what policies and access requests grant this identity.
  [`${API}/identity/${ID}/entitlements`]: {
    identityId: ID,
    entitlements: [
      {
        id: 'policy:Engineering baseline:entra-id:group:SG-Engineering',
        entitlement: 'SG-Engineering',
        type: 'group',
        source: 'Engineering baseline',
        targetSystem: 'entra-id',
        grantedBy: 'policy',
        status: 'Active',
      },
      {
        id: 'policy:Engineering baseline:entra-id:license:M365-E3',
        entitlement: 'M365-E3',
        type: 'license',
        source: 'Engineering baseline',
        targetSystem: 'entra-id',
        grantedBy: 'policy',
        status: 'Active',
      },
      {
        id: 'policy:Engineering baseline:active-directory:group:CN=Developers',
        entitlement: 'CN=Developers',
        type: 'group',
        source: 'Engineering baseline',
        targetSystem: 'active-directory',
        grantedBy: 'policy',
        status: 'Active',
      },
      {
        id: 'request:Access request REQ-7:github:group:example/engineering',
        entitlement: 'example/engineering',
        type: 'group',
        source: 'Access request REQ-7',
        targetSystem: 'github',
        grantedBy: 'request',
        status: 'Pending',
        expiresAt: '2027-06-01T00:00:00.000Z',
      },
    ],
  },
  [`${API}/policy/evaluate/${ID}`]: {
    operations: [
      {
        type: 'group',
        action: 'add',
        target: 'entra-id',
        targetId: 'SG-Engineering',
        sourcePolicy: 'Engineering baseline',
      },
      {
        type: 'license',
        action: 'add',
        target: 'entra-id',
        targetId: 'M365-E3',
        sourcePolicy: 'Engineering baseline',
      },
      {
        type: 'group',
        action: 'add',
        target: 'active-directory',
        targetId: 'CN=Developers',
        sourcePolicy: 'Engineering baseline',
      },
    ],
  },
  // The catalogue lists every entitlement of a system, also ones this identity does not have.
  [`${API}/entitlement-catalog?system=entra-id`]: {
    entitlements: [
      {
        nativeId: 'SG-Engineering',
        name: 'SG-Engineering',
        type: 'Group',
        origin: 'POLICY',
        governanceLevel: 'STRICT',
      },
      {
        nativeId: 'M365-E3',
        name: 'Microsoft 365 E3',
        type: 'License',
        origin: 'POLICY',
        governanceLevel: 'OPEN',
      },
      {
        nativeId: 'Global-Reader',
        name: 'Global Reader',
        type: 'DirectoryRole',
        origin: 'EXTERNAL',
        governanceLevel: 'STRICT',
      },
      {
        nativeId: 'SG-HR-Payroll',
        name: 'SG-HR-Payroll',
        type: 'Group',
        origin: 'POLICY',
        governanceLevel: 'STRICT',
      },
    ],
    count: 4,
  },
  [`${API}/entitlement-catalog?system=active-directory`]: {
    entitlements: [
      {
        nativeId: 'CN=Developers',
        name: 'CN=Developers',
        type: 'Group',
        origin: 'POLICY',
        governanceLevel: 'OPEN',
      },
      {
        nativeId: 'CN=Domain Admins',
        name: 'CN=Domain Admins',
        type: 'Group',
        origin: 'EXTERNAL',
        governanceLevel: 'STRICT',
      },
    ],
    count: 2,
  },
  [`${API}/entitlement-catalog?system=github`]: {
    entitlements: [
      {
        nativeId: 'example/engineering',
        name: 'example/engineering',
        type: 'Group',
        origin: 'EXTERNAL',
        governanceLevel: 'OPEN',
      },
    ],
    count: 1,
  },
  [`${API}/entitlement-catalog?system=entra`]: { entitlements: [], count: 0 },
  [`${API}/entitlement-catalog?system=okta`]: { entitlements: [], count: 0 },
  [`${API}/privileged-access/${ID}/admin-accounts`]: [],
};

const driftsResponse = {
  success: true,
  drifts: [
    {
      _id: '6650a1b2c3d4e5f6a7b8c9d0',
      tenantId: 'dev-tenant',
      type: 'FIELD_MISMATCH',
      severity: 'medium',
      userId: ID,
      userDisplayName: 'Matti Virtanen',
      userEmail: 'm•••@example.com',
      targetSystem: 'entra-id',
      field: 'jobTitle',
      hubValue: 'Senior Developer',
      targetValue: 'Developer',
      detectedAt: '2026-11-22T10:00:00.000Z',
      autoCorrectEligible: true,
      status: 'open',
    },
  ],
  total: 1,
  page: 1,
  limit: 50,
  totalPages: 1,
};

function routeGet(failing?: string) {
  get.mockImplementation(async (url: string) => {
    if (failing && url === failing) throw Object.assign(new Error('500'), { status: 500 });
    if (url.startsWith(`${API}/reconciliation/drifts?`)) return { data: driftsResponse };
    if (url === `${API}/risk-scores/${ID}`) throw Object.assign(new Error('404'), { status: 404 });
    if (url in responses) return { data: responses[url] };
    throw new Error(`unexpected GET ${url}`);
  });
}

function renderMap() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(
    () => {
      const { data, isLoading, isError } = useIdentityEntitlements(ID);
      return { graph: useEntitlementGraph(data), isLoading, isError };
    },
    { wrapper },
  );
}

type GraphNode = ReturnType<typeof useEntitlementGraph>['nodes'][number];
type Graph = ReturnType<typeof useEntitlementGraph>;

const targets = (graph: Graph) => graph.nodes.filter((n) => n.type === 'targetSystemNode');
const target = (graph: Graph, system: string) =>
  targets(graph).find((n) => n.data.systemName === system) as GraphNode;
/** The entitlement chips drawn under a target system node. */
const chipsOf = (graph: Graph, system: string) => {
  const ids = graph.edges.filter((e) => e.source === `target-${system}`).map((e) => e.target);
  return graph.nodes.filter((n) => ids.includes(n.id));
};

describe('identity map data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeGet();
  });

  it('draws the systems the identity is provisioned to', async () => {
    const { result } = renderMap();
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const graph = result.current.graph;
    expect(targets(graph).map((n) => n.data.systemName)).toEqual([
      'entra',
      'active-directory',
      'github',
    ]);
    expect(target(graph, 'entra').data).toMatchObject({ syncStatus: 'DRIFT', driftCount: 1 });
    expect(target(graph, 'github').data).toMatchObject({ syncStatus: 'ERROR', driftCount: 0 });
    expect(graph.nodes.find((n) => n.type === 'identityNode')?.data).toMatchObject({
      displayName: 'Matti Virtanen',
      jobTitle: 'Senior Developer',
      status: 'ACTIVE',
    });
  });

  it("lists only the identity's own entitlements, not the system's catalogue", async () => {
    const { result } = renderMap();
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const graph = result.current.graph;
    expect(chipsOf(graph, 'entra').map((n) => n.data.name)).toEqual(['SG-Engineering', 'M365-E3']);
    expect(chipsOf(graph, 'active-directory').map((n) => n.data.name)).toEqual(['CN=Developers']);
    expect(chipsOf(graph, 'github').map((n) => n.data.name)).toEqual(['example/engineering']);
    expect(target(graph, 'entra').data.entitlementCount).toBe(2);
    expect(target(graph, 'active-directory').data.entitlementCount).toBe(1);

    const names = graph.nodes.map((n) => n.data.name);
    expect(names).not.toContain('SG-HR-Payroll');
    expect(names).not.toContain('Global Reader');
    expect(names).not.toContain('CN=Domain Admins');
  });

  it('shows how each entitlement was granted and whether it is provisioned', async () => {
    const { result } = renderMap();
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const graph = result.current.graph;
    const [group, license] = chipsOf(graph, 'entra');
    expect(group.data).toMatchObject({
      name: 'SG-Engineering',
      type: 'Group',
      origin: 'POLICY',
      sourcePolicy: 'Engineering baseline',
      governanceLevel: 'STRICT',
      isProvisioned: true,
    });
    expect(license.data).toMatchObject({ type: 'License', governanceLevel: 'OPEN' });

    const [requested] = chipsOf(graph, 'github');
    expect(requested.data).toMatchObject({ origin: 'REQUEST', isProvisioned: false });
    expect(requested.data.sourcePolicy).toBeUndefined();
  });

  it("takes a request's end date from this identity's entitlements, not the viewer's requests", async () => {
    const { result } = renderMap();
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const [requested] = chipsOf(result.current.graph, 'github');
    expect(requested.data.expiresAt).toBe('2027-06-01T00:00:00.000Z');
    // GET /access-requests lists the viewer's own requests: never read for another identity
    const urls = get.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.startsWith(`${API}/access-requests`))).toBe(false);
  });

  it('reports an error instead of empty systems when the entitlements cannot be read', async () => {
    routeGet(`${API}/identity/${ID}/entitlements`);
    const { result } = renderMap();

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
