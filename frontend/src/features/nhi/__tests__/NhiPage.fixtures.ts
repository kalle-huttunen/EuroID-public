/**
 * Shared fixtures of the NhiPage tests. Agents follow what the API answers: lean
 * `agent_identities` documents (`_id`, the `agentId` slug every route takes, `owner` with the
 * identity's `_id` and email, timestamps, `__v`) inside `{ data, total }` for GET /nhi, the same
 * document for GET /nhi/:agentId and the POST routes, the dry run of revoke and the kill switch
 * (`?dryRun=true`), and the credential envelope of POST /nhi/:agentId/credentials. Identities
 * follow GET /identity (profile flattened next to `_id`). Dates are relative to now. Each test file
 * mocks `@api/data` with the request mocks below and `usePermission`.
 */
import { createElement, type ReactElement } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { vi } from 'vitest';
import { ConfigProvider } from 'antd';
import dayjs from 'dayjs';
import { renderWithProviders } from '../../../test/test-utils';
import { NhiPage } from '../NhiPage';
import type { IAgentCredential, IAgentIdentity } from '../../../interfaces';

export const mockGet = vi.fn();
export const mockPost = vi.fn();

export const at = (days: number) => dayjs().add(days, 'day').toISOString();

export const ADA_ID = '64b7f0c2a1b2c3d4e5f60112';
export const GRACE_ID = '64b7f0c2a1b2c3d4e5f60113';
const ADA_EMAIL = 'ada.lovelace@corp.example';

type Doc = IAgentIdentity & { __v: number };

function agent(fields: Partial<Doc> & Pick<Doc, '_id' | 'agentId' | 'displayName' | 'kind'>): Doc {
  return {
    tenantId: 'tenant-a',
    owner: { identityId: ADA_ID, email: ADA_EMAIL },
    scope: ['hr:read'],
    expiresAt: at(30),
    status: 'active',
    killSwitchEngaged: false,
    riskTier: 'low',
    createdBy: 'admin@euroid.local',
    metadata: {},
    createdAt: at(-10),
    updatedAt: at(-10),
    __v: 0,
    ...fields,
  };
}

/** A top-level service account with two active descendants and one revoked child. */
export const payrollBot = agent({
  _id: '64b7f0c2a1b2c3d4e5f60b01',
  agentId: 'payroll-sync-bot',
  displayName: 'Payroll sync',
  kind: 'service-account',
  scope: ['hr:read', 'hr:write', 'entra:users:write'],
  riskTier: 'high',
  expiresAt: at(60),
  lastRotatedAt: at(-1),
  credentialFingerprint: '9f2c4b7e1a3d5f6c8b9a0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b',
});

export const payrollReader = agent({
  _id: '64b7f0c2a1b2c3d4e5f60b02',
  agentId: 'payroll-reader',
  displayName: 'Payroll reader',
  kind: 'ai-agent',
  parentAgentId: 'payroll-sync-bot',
});

/** A grandchild of payrollBot: the cascade reaches it through payrollReader. */
export const readerHelper = agent({
  _id: '64b7f0c2a1b2c3d4e5f60b03',
  agentId: 'payroll-reader-helper',
  displayName: 'Payroll reader helper',
  kind: 'bot',
  parentAgentId: 'payroll-reader',
});

/** A revoked child of payrollBot: the cascade skips it. */
export const oldExporter = agent({
  _id: '64b7f0c2a1b2c3d4e5f60b04',
  agentId: 'payroll-exporter',
  displayName: 'Payroll exporter',
  kind: 'workload',
  parentAgentId: 'payroll-sync-bot',
  status: 'revoked',
  riskTier: 'medium',
  revokedAt: at(-2),
  revokedBy: 'admin@euroid.local',
  revocationReason: 'Replaced by payroll-reader',
});

export const killedBot = agent({
  _id: '64b7f0c2a1b2c3d4e5f60b05',
  agentId: 'chat-triage-bot',
  displayName: 'Chat triage',
  kind: 'ai-agent',
  owner: { identityId: GRACE_ID, email: 'grace.hopper@corp.example' },
  scope: ['tickets:read:*'],
  status: 'revoked',
  killSwitchEngaged: true,
  riskTier: 'critical',
  revokedAt: at(-1),
  revokedBy: 'admin@euroid.local',
  revocationReason: 'Prompt injection',
});

export const expiredWorkload = agent({
  _id: '64b7f0c2a1b2c3d4e5f60b06',
  agentId: 'nightly-export',
  displayName: 'Nightly export',
  kind: 'workload',
  status: 'expired',
  riskTier: 'medium',
  expiresAt: at(-3),
});

/** An agent whose owner was offboarded: no new credential until re-owned or revoked. */
export const ownerlessBot = agent({
  _id: '64b7f0c2a1b2c3d4e5f60b09',
  agentId: 'invoice-bot',
  displayName: 'Invoice bot',
  kind: 'bot',
  owner: { identityId: GRACE_ID, email: 'grace.hopper@corp.example' },
  ownerlessSince: at(-1),
  ownerlessReason: 'offboarded',
});

export const AGENTS = [
  payrollBot,
  payrollReader,
  readerHelper,
  oldExporter,
  killedBot,
  expiredWorkload,
];

/** GET /identity rows: the profile flattened next to `_id`. */
const IDENTITIES = [
  {
    _id: ADA_ID,
    email: ADA_EMAIL,
    firstName: 'Ada',
    lastName: 'Lovelace',
    status: 'ACTIVE',
    tenantId: 'tenant-a',
  },
  {
    _id: GRACE_ID,
    email: 'grace.hopper@corp.example',
    firstName: 'Grace',
    lastName: 'Hopper',
    status: 'SUSPENDED',
    tenantId: 'tenant-a',
  },
];

export const SIGNATURE = 'c0ffee'.repeat(21) + 'ab';
export const CREDENTIAL: IAgentCredential = {
  payload: {
    spiffeId: 'spiffe://euroid.local/tenants/tenant-a/agents/payroll-sync-bot',
    agentId: 'payroll-sync-bot',
    tenantId: 'tenant-a',
    scope: ['entra:users:write', 'hr:read', 'hr:write'],
    issuedAt: '2026-11-24T10:00:00.000Z',
    expiresAt: '2026-11-24T10:15:00.000Z',
  },
  signature: SIGNATURE,
  keyFingerprint: 'ab12'.repeat(16),
  algorithm: 'ed25519',
};

export const LIST = /\/nhi$/;
export const SIGNING = /\/nhi\/_\/credential-signing-status$/;
export const ONE = (agentId: string) => new RegExp(`/nhi/${agentId}$`);
export const ACTION = (agentId: string, action: string) => new RegExp(`/nhi/${agentId}/${action}$`);
const DETAIL = /\/nhi\/([a-z0-9-]+)$/;
const IDENTITY = /\/identity$/;

type Params = Record<string, string | number | undefined>;

/** GET /nhi as the service answers it: filtered, newest first, one page of `limit`. */
function listAnswer(agents: Doc[], params: Params) {
  const matches = agents.filter(
    (a) =>
      (!params.status || a.status === params.status) &&
      (!params.kind || a.kind === params.kind) &&
      (!params.riskTier || a.riskTier === params.riskTier) &&
      (!params.ownerIdentityId || a.owner.identityId === params.ownerIdentityId) &&
      (params.ownerless === undefined ||
        !!a.ownerlessSince === (String(params.ownerless) === 'true')),
  );
  const page = Number(params.page ?? 1);
  const limit = Number(params.limit ?? 50);
  return { data: matches.slice((page - 1) * limit, page * limit), total: matches.length };
}

/**
 * POST /nhi/:agentId/revoke or /kill with ?dryRun=true as the service answers it: whether the
 * call would change anything, and the delegated agents stored as active it reaches, depth first.
 * The walk goes on below a revoked or expired agent (a cascade that failed part way through can
 * leave its delegates active), also when the agent itself is already ended.
 */
export function previewAnswer(agents: Doc[], agentId: string, killSwitch: boolean) {
  const root = agents.find((a) => a.agentId === agentId);
  const reached: Doc[] = [];
  const walk = (parentAgentId: string) => {
    for (const child of agents) {
      if (child.parentAgentId !== parentAgentId) continue;
      if (child.status === 'active') reached.push(child);
      walk(child.agentId);
    }
  };
  if (root) walk(agentId);
  const changes =
    !!root &&
    (root.status !== 'revoked' || (killSwitch && !root.killSwitchEngaged) || reached.length > 0);
  return {
    dryRun: true,
    agentId,
    killSwitch,
    changes,
    reached: reached.map(
      ({ agentId, displayName, kind, owner, parentAgentId, status, expiresAt }) => ({
        agentId,
        displayName,
        kind,
        owner,
        parentAgentId,
        status,
        expiresAt,
      }),
    ),
  };
}

type PostConfig = { params?: Record<string, unknown> };
const isDryRun = (config?: PostConfig) => config?.params?.dryRun === true;

/** The POSTs that change something: every one but the dry runs. */
export const realPosts = () => mockPost.mock.calls.filter(([, , config]) => !isDryRun(config));

/** The dry-run POSTs, as [url, body, config]. */
export const dryRuns = () => mockPost.mock.calls.filter(([, , config]) => isDryRun(config));

/** Answers the POSTs that change something with `answer`; the dry runs keep their answer. */
export function onRealPost(answer: () => Promise<unknown>) {
  const base = mockPost.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
  mockPost.mockImplementation((url: string, body: unknown, config?: PostConfig) =>
    isDryRun(config) ? base(url, body, config) : answer(),
  );
}

/** An API refusal as axios rejects it. */
export function apiError(status: number, message: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { statusCode: status, message } },
  });
}

export function serve({
  agents = AGENTS,
  signing = true,
}: { agents?: Doc[]; signing?: boolean } = {}) {
  mockGet.mockImplementation((url: string, config?: { params?: Params }) => {
    if (SIGNING.test(url)) return Promise.resolve({ data: { enabled: signing } });
    if (LIST.test(url)) return Promise.resolve({ data: listAnswer(agents, config?.params ?? {}) });
    if (IDENTITY.test(url)) {
      const q = String(config?.params?.q ?? '').toLowerCase();
      const rows = IDENTITIES.filter((i) =>
        `${i.firstName} ${i.lastName} ${i.email}`.toLowerCase().includes(q),
      );
      return Promise.resolve({ data: rows, headers: { 'x-total-count': String(rows.length) } });
    }
    const id = DETAIL.exec(url)?.[1];
    const found = agents.find((a) => a.agentId === id);
    return found
      ? Promise.resolve({ data: found })
      : Promise.reject(apiError(404, `Agent '${id}' not found`));
  });
  mockPost.mockImplementation((url: string, body: Record<string, unknown>, config?: PostConfig) => {
    const target = agents.find((a) => url.includes(`/nhi/${a.agentId}/`));
    if (isDryRun(config) && target) {
      return Promise.resolve({
        data: previewAnswer(agents, target.agentId, url.endsWith('/kill')),
      });
    }
    if (url.endsWith('/credentials')) return Promise.resolve({ data: CREDENTIAL });
    if (url.endsWith('/owner') && target) {
      const owned: Doc = {
        ...target,
        owner: { identityId: body.ownerIdentityId as string, email: ADA_EMAIL },
      };
      delete owned.ownerlessSince;
      delete owned.ownerlessReason;
      return Promise.resolve({ data: owned });
    }
    if (url.endsWith('/revoke') && target) {
      return Promise.resolve({
        data: { ...target, status: 'revoked', revocationReason: body.reason },
      });
    }
    if (url.endsWith('/kill') && target) {
      return Promise.resolve({
        data: {
          ...target,
          status: 'revoked',
          killSwitchEngaged: true,
          revocationReason: body.reason,
        },
      });
    }
    const created = agent({
      _id: '64b7f0c2a1b2c3d4e5f60b99',
      agentId: body.agentId as string,
      displayName: body.displayName as string,
      kind: body.kind as Doc['kind'],
      scope: body.scope as string[],
      expiresAt: body.expiresAt as string,
      riskTier: 'medium',
      ...(target ? { parentAgentId: target.agentId } : {}),
    });
    return Promise.resolve({ data: created });
  });
}

export const callsTo = (pattern: RegExp) =>
  mockGet.mock.calls.filter(([url]) => pattern.test(url as string));

/** The page without virtual scrolling, so jsdom renders every option of a dropdown. */
export function renderPage(wrap: (page: ReactElement) => ReactElement = (p) => p) {
  return renderWithProviders(
    wrap(createElement(ConfigProvider, { virtual: false }, createElement(NhiPage))),
    { initialRoute: '/nhi' },
  );
}

export const agentsTable = () => screen.findByRole('table', { name: 'Non-human identities' });

/** The agent id of a row: the first code element (a delegated row names its parent after it). */
const rowAgentId = (tr: Element) => tr.querySelector('code')?.textContent;

/** The row of the agent with this id. */
export const rowOf = (table: HTMLElement, agentId: string) =>
  Array.from(table.querySelectorAll('tbody tr')).find((tr) => rowAgentId(tr) === agentId) as
    | HTMLElement
    | undefined;

/** The agent ids the table shows now, in order (the table is looked up afresh). */
export async function shownIds(): Promise<string[]> {
  const table = await agentsTable();
  return Array.from(table.querySelectorAll('tbody tr.ant-table-row')).map(
    (tr) => rowAgentId(tr) ?? '',
  );
}

/**
 * Puts the text into the field as one paste (at the caret, as a person pastes it). user.type
 * sends a key event per character, and each re-renders the open modals: seconds per field in
 * jsdom. For fields where typing itself is not what the test checks.
 */
export async function fill(user: UserEvent, field: HTMLElement, text: string) {
  field.focus();
  await user.paste(text);
}

/**
 * Opens the select box and clicks the option with this text. In tests every rc-select shares one
 * list id, so the option is looked up in the dropdown that is open, not through aria-controls.
 */
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

/**
 * The open modal with this title. In tests every rc-dialog shares one aria-labelledby id, so a
 * role query by name would always read the first modal's title.
 */
export function queryDialog(title: string | RegExp): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find((d) => {
    const text = d.querySelector('.ant-modal-title')?.textContent ?? '';
    return typeof title === 'string' ? text === title : title.test(text);
  });
}

export const dialog = (title: string | RegExp) =>
  waitFor(() => {
    const found = queryDialog(title);
    if (!found) throw new Error(`no dialog titled ${String(title)}`);
    return found;
  });
