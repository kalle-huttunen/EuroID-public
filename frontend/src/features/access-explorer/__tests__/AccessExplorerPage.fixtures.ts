/**
 * Shared fixtures of the AccessExplorerPage tests, shaped like the controller's answers: nodes
 * keyed by the identity's `_id` or the entitlement's native id, their Neo4j properties as stored
 * (an identity has no name in the graph, so its label is its id; datetimes come as the driver's
 * { year: { low, high }, ... }), relationships with Neo4j element ids pointing at node ids.
 * Identities follow GET /identity/:id and GET /identity (profile flattened next to `_id`).
 */
import { createElement, type ReactElement } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { ConfigProvider } from 'antd';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '../../../test/test-utils';
import { AccessExplorerPage } from '../AccessExplorerPage';
import type {
  IAccessPathResult,
  IEntitlementHolders,
  IGraphNode,
  IGraphRelationship,
  IGraphResyncResult,
  IGraphSodViolations,
  IIdentityAccessGraph,
} from '../../../interfaces';

export const mockGet = vi.fn();
export const mockPost = vi.fn();

export const ADA_ID = '64b7f0c2a1b2c3d4e5f60101';
export const BOB_ID = '64b7f0c2a1b2c3d4e5f60102';
const TENANT = 'tenant-a';
const int = (low: number) => ({ low, high: 0 });
const neoDate = { year: int(2026), month: int(11), day: int(20), hour: int(9), minute: int(5) };

export function identityNode(id: string, email: string): IGraphNode {
  return {
    id,
    type: 'Identity',
    tenantId: TENANT,
    label: id,
    properties: {
      id,
      tenantId: TENANT,
      email,
      status: 'ACTIVE',
      syncRunId: 'run-1',
      createdAt: neoDate,
    },
  };
}

export function entitlementNode(id: string, name: string, entitlementType = 'Group'): IGraphNode {
  return {
    id,
    type: 'Entitlement',
    tenantId: TENANT,
    label: name,
    properties: {
      id,
      tenantId: TENANT,
      name,
      entitlementType,
      system: 'entra-id',
      syncRunId: 'run-1',
    },
  };
}

let relSeq = 0;
export function rel(
  type: IGraphRelationship['type'],
  sourceId: string,
  targetId: string,
  properties: Record<string, unknown> = {},
): IGraphRelationship {
  relSeq += 1;
  return { id: `5:4c1d:${relSeq}`, type, sourceId, targetId, properties };
}

export const ada = identityNode(ADA_ID, 'ada@corp.example');
export const bob = identityNode(BOB_ID, 'bob@corp.example');
export const allStaff = entitlementNode('grp-all', 'All staff');
export const finTeam = entitlementNode('grp-fin-team', 'Finance team');
export const finAdmin = entitlementNode('grp-fin-admin', 'Finance-Admin');
export const finAppr = entitlementNode('grp-fin-appr', 'Finance-Approver');

const toAll = rel('HAS_ACCESS', ADA_ID, 'grp-all', {
  grantedBy: 'policy',
  source: 'All staff policy',
  connector: 'entra-id',
  grantedAt: neoDate,
  syncRunId: 'run-1',
});
const toTeam = rel('MEMBER_OF', ADA_ID, 'grp-fin-team');
const teamToAdmin = rel('HAS_ACCESS', 'grp-fin-team', 'grp-fin-admin', {
  connector: 'entra-id',
  grantedAt: neoDate,
});
const toAppr = rel('HAS_ACCESS', ADA_ID, 'grp-fin-appr', {
  grantedBy: 'request',
  source: 'Access request REQ-7',
  connector: 'entra-id',
});

export const ADA_GRAPH: IIdentityAccessGraph = {
  identityId: ADA_ID,
  identityFound: true,
  nodes: [ada, allStaff, finTeam, finAdmin, finAppr],
  relationships: [toAll, toTeam, teamToAdmin, toAppr],
  nodeCount: 5,
  relationshipCount: 4,
  truncated: false,
  pathLimit: 2000,
};

/** 70 direct entitlements, and the API cut the answer. */
export function bigGraph(): IIdentityAccessGraph {
  const ents = Array.from({ length: 70 }, (_, k) =>
    entitlementNode(`grp-${String(k).padStart(2, '0')}`, `Group ${String(k).padStart(2, '0')}`),
  );
  return {
    ...ADA_GRAPH,
    nodes: [ada, ...ents],
    relationships: ents.map((e) => rel('HAS_ACCESS', ADA_ID, e.id, { connector: 'entra-id' })),
    nodeCount: 71,
    relationshipCount: 70,
    truncated: true,
  };
}

export const NOT_IN_GRAPH: IIdentityAccessGraph = {
  identityId: BOB_ID,
  identityFound: false,
  nodes: [],
  relationships: [],
  nodeCount: 0,
  relationshipCount: 0,
  truncated: false,
  pathLimit: 2000,
};

export const APPR_HOLDERS: IEntitlementHolders = {
  entitlementId: 'grp-fin-appr',
  entitlementFound: true,
  entitlement: finAppr,
  holders: [
    { identity: ada, pathDepth: 1, pathNodes: [ada, finAppr], pathRelationships: [toAppr] },
    {
      identity: bob,
      pathDepth: 2,
      pathNodes: [bob, finTeam, finAppr],
      pathRelationships: [
        rel('MEMBER_OF', BOB_ID, 'grp-fin-team'),
        rel('HAS_ACCESS', 'grp-fin-team', 'grp-fin-appr'),
      ],
    },
    {
      identity: bob,
      pathDepth: 1,
      pathNodes: [bob, finAppr],
      pathRelationships: [
        rel('HAS_ACCESS', BOB_ID, 'grp-fin-appr', { grantedBy: 'policy', source: 'Approvers' }),
      ],
    },
  ],
  count: 3,
  truncated: false,
  pathLimit: 1000,
};

export const PATH_FOUND: IAccessPathResult = {
  fromIdentity: ADA_ID,
  toEntitlement: 'grp-fin-admin',
  identityFound: true,
  entitlementFound: true,
  found: true,
  path: { nodes: [ada, finTeam, finAdmin], relationships: [toTeam, teamToAdmin], depth: 2 },
};

export const ADA_SOD: IGraphSodViolations = {
  identityId: ADA_ID,
  identityFound: true,
  policiesChecked: 2,
  violations: [
    {
      policyName: 'Finance SoD',
      severity: 'HIGH',
      action: 'BLOCK',
      entitlementA: finAdmin,
      entitlementB: finAppr,
      pathToA: PATH_FOUND.path!,
      pathToB: { nodes: [ada, finAppr], relationships: [toAppr], depth: 1 },
      conflictingEntitlements: [
        { entitlement: finAdmin, path: PATH_FOUND.path! },
        {
          entitlement: finAppr,
          path: { nodes: [ada, finAppr], relationships: [toAppr], depth: 1 },
        },
      ],
    },
  ],
  violationCount: 1,
};

export const RESYNC: IGraphResyncResult = {
  identities: 212,
  entitlements: 48,
  applications: 5,
  grants: { policy: 640, request: 31 },
  removed: { identities: 3, entitlements: 1, applications: 0, relationships: 12 },
  durationMs: 8420,
};

const IDENTITIES = [
  {
    _id: ADA_ID,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@corp.example',
    status: 'ACTIVE',
  },
  {
    _id: BOB_ID,
    firstName: 'Bob',
    lastName: 'Builder',
    email: 'bob@corp.example',
    status: 'ACTIVE',
  },
];

const CATALOG = [
  {
    nativeId: 'grp-fin-appr',
    name: 'Finance-Approver',
    type: 'Group',
    origin: 'EXTERNAL',
    governanceLevel: 'OPEN',
  },
  { name: 'Registered by name only', type: 'Group', origin: 'POLICY', governanceLevel: 'STRICT' },
];

export function apiError(status: number, message: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { statusCode: status, message } },
  });
}

export const UNAVAILABLE_MESSAGE =
  'The access graph is not available: Neo4j is not configured on the API (NEO4J_PASSWORD is empty). An administrator sets NEO4J_URL, NEO4J_USER and NEO4J_PASSWORD, restarts the API and then loads the graph from MongoDB with POST /api/v1/access-explorer/resync (super-admin).';

export interface Answers {
  graph: Record<string, IIdentityAccessGraph | Error>;
  holders: Record<string, IEntitlementHolders | Error>;
  path: IAccessPathResult | Error;
  sod: IGraphSodViolations | Error;
  resync: IGraphResyncResult | Error;
}

export const defaultAnswers = (): Answers => ({
  graph: { [ADA_ID]: ADA_GRAPH, [BOB_ID]: NOT_IN_GRAPH },
  holders: { 'grp-fin-appr': APPR_HOLDERS },
  path: PATH_FOUND,
  sod: ADA_SOD,
  resync: RESYNC,
});

const answer = <T>(value: T | Error | undefined, what: string) =>
  value instanceof Error
    ? Promise.reject(value)
    : value
      ? Promise.resolve({ data: value })
      : Promise.reject(apiError(404, `no fixture for ${what}`));

export function serve(answers: Answers = defaultAnswers()) {
  mockGet.mockImplementation((url: string, config?: { params?: Record<string, string> }) => {
    const params = config?.params ?? {};
    let m = /\/access-explorer\/identity\/([^/]+)\/graph$/.exec(url);
    if (m) return answer(answers.graph[decodeURIComponent(m[1])], url);
    m = /\/access-explorer\/entitlement\/([^/]+)\/holders$/.exec(url);
    if (m) return answer(answers.holders[decodeURIComponent(m[1])], url);
    if (/\/access-explorer\/path$/.test(url)) return answer(answers.path, url);
    if (/\/sod-violations$/.test(url)) return answer(answers.sod, url);
    if (/\/entitlement-catalog$/.test(url)) {
      return Promise.resolve({ data: { entitlements: params.type === 'Group' ? CATALOG : [] } });
    }
    m = /\/identity\/([0-9a-f]{24})$/.exec(url);
    if (m)
      return answer(
        IDENTITIES.find((i) => i._id === m![1]),
        url,
      );
    if (/\/identity$/.test(url)) {
      const q = (params.q ?? '').toLowerCase();
      const rows = IDENTITIES.filter((i) =>
        `${i.firstName} ${i.lastName} ${i.email}`.toLowerCase().includes(q),
      );
      return Promise.resolve({ data: rows, headers: { 'x-total-count': String(rows.length) } });
    }
    return Promise.reject(apiError(404, `unexpected GET ${url}`));
  });
  mockPost.mockImplementation((url: string) =>
    /\/access-explorer\/resync$/.test(url)
      ? answer(answers.resync, url)
      : Promise.reject(apiError(404, `unexpected POST ${url}`)),
  );
}

export const callsTo = (pattern: RegExp) =>
  mockGet.mock.calls.filter(([url]) => pattern.test(url as string));

function LocationProbe() {
  const location = useLocation();
  return createElement('div', { 'data-testid': 'location' }, location.pathname + location.search);
}

export const location = () => screen.getByTestId('location').textContent;

/** The page without virtual scrolling, so jsdom renders every option of a dropdown. */
export function renderPage(search = '', wrap: (page: ReactElement) => ReactElement = (p) => p) {
  return renderWithProviders(
    wrap(
      createElement(
        ConfigProvider,
        { virtual: false },
        createElement(AccessExplorerPage),
        createElement(LocationProbe),
      ),
    ),
    { initialRoute: `/access-explorer${search}` },
  );
}

/** Opens the select box and clicks the option with this text (the dropdown that is open). */
export async function choose(box: HTMLElement, optionText: string) {
  fireEvent.mouseDown(box);
  const option = await waitFor(() => {
    const open = document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
    const found = Array.from(open)
      .flatMap((d) => Array.from(d.querySelectorAll('.ant-select-item-option')))
      .find((o) => o.textContent === optionText);
    if (!found) throw new Error(`no option "${optionText}"`);
    return found as HTMLElement;
  });
  fireEvent.click(option);
  return option;
}

/** Texts of the options the open dropdown offers. */
export function openOptions(): string[] {
  const open = document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
  return Array.from(open).flatMap((d) =>
    Array.from(d.querySelectorAll('.ant-select-item-option')).map((o) => o.textContent ?? ''),
  );
}
