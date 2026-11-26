/**
 * The non-human identities page: the list and its filters (sent to GET /nhi), paging, the empty,
 * loading and error states, the detail modal re-read from GET /nhi/:agentId, and the role gates:
 * every role reads; only a super-admin is offered the changes and the signing status, and a
 * viewer's page sends no super-admin request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ADA_ID,
  LIST,
  ONE,
  SIGNING,
  agentsTable,
  apiError,
  callsTo,
  choose,
  dialog,
  expiredWorkload,
  killedBot,
  mockGet,
  mockPost,
  AGENTS,
  oldExporter,
  ownerlessBot,
  payrollBot,
  renderPage,
  rowOf,
  serve,
  shownIds,
} from './NhiPage.fixtures';

// Dev builds (VITE_AUTH_DISABLED) grant every role; the role tests set it explicitly.
let mockIsSuperAdmin = true;
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => (role === 'super-admin' ? mockIsSuperAdmin : true),
}));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const lastListParams = () => callsTo(LIST).at(-1)?.[1]?.params;

describe('NhiPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSuperAdmin = true;
    serve();
  });

  it('lists each agent with kind, owner, scope, status, risk and delegation', async () => {
    renderPage();
    const table = await agentsTable();

    expect(lastListParams()).toEqual({ page: 1, limit: 50 });
    const bot = rowOf(table, 'payroll-sync-bot');
    expect(within(bot).getByText('Payroll sync')).toBeInTheDocument();
    expect(within(bot).getByText('Service account')).toBeInTheDocument();
    expect(within(bot).getByText('ada.lovelace@corp.example')).toBeInTheDocument();
    expect(within(bot).getByText('hr:read')).toBeInTheDocument();
    expect(within(bot).getByText('+1')).toBeInTheDocument();
    expect(within(bot).getByText('Active')).toBeInTheDocument();
    expect(within(bot).getByText('High')).toBeInTheDocument();
    expect(
      within(bot).getByRole('link', { name: 'Open the owner of payroll-sync-bot' }),
    ).toHaveAttribute('href', `/identities/${ADA_ID}`);

    const reader = rowOf(table, 'payroll-reader-helper');
    expect(within(reader).getByText('Delegated from')).toBeInTheDocument();
    const killed = rowOf(table, 'chat-triage-bot');
    expect(within(killed).getByText('Revoked')).toBeInTheDocument();
    expect(within(killed).getByText('Kill switch')).toBeInTheDocument();
    expect(within(killed).getByText('Critical')).toBeInTheDocument();
    // The status is the API's: an expired agent shows as the API stored it.
    expect(within(rowOf(table, 'nightly-export')).getByText('Expired')).toBeInTheDocument();
  });

  it('sends each filter to GET /nhi and shows what it answers', { timeout: 15_000 }, async () => {
    renderPage();
    await agentsTable();

    await choose(screen.getByRole('combobox', { name: 'Status' }), 'Revoked');
    await waitFor(() =>
      expect(lastListParams()).toEqual({ status: 'revoked', page: 1, limit: 50 }),
    );
    await waitFor(async () =>
      expect(await shownIds()).toEqual([oldExporter.agentId, killedBot.agentId]),
    );

    await choose(screen.getByRole('combobox', { name: 'Kind' }), 'Workload');
    await waitFor(() =>
      expect(lastListParams()).toEqual({ kind: 'workload', status: 'revoked', page: 1, limit: 50 }),
    );
    await waitFor(async () => expect(await shownIds()).toEqual([oldExporter.agentId]));

    await choose(screen.getByRole('combobox', { name: 'Risk tier' }), 'Critical');
    expect(await screen.findByText('No agent matches these filters')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(lastListParams()).toEqual({ page: 1, limit: 50 }));
  });

  it('lists the ownerless agents apart, tagged', { timeout: 15_000 }, async () => {
    serve({ agents: [...AGENTS, ownerlessBot] });
    renderPage();
    const table = await agentsTable();
    expect(within(rowOf(table, 'invoice-bot')).getByText('Ownerless')).toBeInTheDocument();
    expect(within(rowOf(table, 'payroll-sync-bot')).queryByText('Ownerless')).toBeNull();

    await choose(screen.getByRole('combobox', { name: 'Ownership' }), 'Ownerless');
    await waitFor(() => expect(lastListParams()).toEqual({ ownerless: true, page: 1, limit: 50 }));
    await waitFor(async () => expect(await shownIds()).toEqual([ownerlessBot.agentId]));
  });

  it('filters by the owner picked by name', { timeout: 15_000 }, async () => {
    const user = userEvent.setup();
    renderPage();
    await agentsTable();

    const owner = screen.getByRole('combobox', { name: 'Owner' });
    await user.type(owner, 'grace');
    await choose(owner, 'Grace Hopper (grace.hopper@corp.example)');
    await waitFor(() =>
      expect(lastListParams()).toEqual({
        ownerIdentityId: killedBot.owner.identityId,
        page: 1,
        limit: 50,
      }),
    );
    await waitFor(async () => expect(await shownIds()).toEqual([killedBot.agentId]));
  });

  it('pages through the server’s pages', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      ...expiredWorkload,
      _id: `64b7f0c2a1b2c3d4e5f6${String(1000 + i)}`,
      agentId: `export-${String(i).padStart(2, '0')}`,
    }));
    serve({ agents: many });
    const user = userEvent.setup();
    renderPage();
    await agentsTable();
    expect((await shownIds()).length).toBe(50);

    await user.click(screen.getByTitle('2'));
    await waitFor(() => expect(lastListParams()).toEqual({ page: 2, limit: 50 }));
    await waitFor(async () => expect(await shownIds()).toEqual(['export-50']));
  });

  it('says when there is no agent yet and offers the first one to a super-admin', async () => {
    serve({ agents: [] });
    renderPage();

    expect(await screen.findByText('No non-human identities yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create the first agent/ })).toBeInTheDocument();
  });

  it('shows a loading state while the list loads', async () => {
    mockGet.mockImplementation((url: string) =>
      LIST.test(url) ? new Promise(() => {}) : Promise.resolve({ data: { enabled: true } }),
    );
    renderPage();

    const region = await screen.findByRole('region', { name: 'Agents' });
    expect(region.querySelector('.ant-skeleton')).not.toBeNull();
  });

  it('shows the API’s message when the list fails, with a retry', async () => {
    mockGet.mockImplementation((url: string) =>
      LIST.test(url)
        ? Promise.reject(
            apiError(400, 'Invalid enum value. Expected low | medium | high | critical'),
          )
        : Promise.resolve({ data: { enabled: true } }),
    );
    renderPage();

    expect(await screen.findByText('Could not load the non-human identities')).toBeInTheDocument();
    expect(
      screen.getByText('Invalid enum value. Expected low | medium | high | critical'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });

  it('opens an agent re-read by its agentId, with owner, scope and credential', async () => {
    const user = userEvent.setup();
    renderPage();
    await agentsTable();

    await user.click(screen.getByRole('button', { name: 'Open agent payroll-sync-bot' }));
    const modal = await dialog(/^Payroll sync/);
    await waitFor(() => expect(callsTo(ONE('payroll-sync-bot'))).toHaveLength(1));
    expect(within(modal).getByText('payroll-sync-bot')).toBeInTheDocument();
    expect(within(modal).getByText('entra:users:write')).toBeInTheDocument();
    expect(within(modal).getByRole('link', { name: 'ada.lovelace@corp.example' })).toHaveAttribute(
      'href',
      `/identities/${ADA_ID}`,
    );
    expect(within(modal).getByText(/Signature fingerprint 9f2c4b7e1a3d5f6c/)).toBeInTheDocument();
    // The API answers an agent past its expiry as expired: no note explains a stale status
    expect(within(modal).queryByText(/until the API next acts on it/)).toBeNull();
    expect(screen.queryByText(/Statuses are as stored/)).toBeNull();
    for (const name of [/Issue credential/, /Delegate/, /Revoke/, /Kill switch/]) {
      expect(within(modal).getByRole('button', { name })).toBeEnabled();
    }
  });

  it('offers a revoked agent only the kill switch, and says why', async () => {
    const user = userEvent.setup();
    renderPage();
    await agentsTable();

    await user.click(screen.getByRole('button', { name: `Open agent ${oldExporter.agentId}` }));
    const modal = await dialog(/^Payroll exporter/);
    expect(within(modal).getByText('Replaced by payroll-reader')).toBeInTheDocument();
    expect(within(modal).getByText(/^Revocation is terminal/)).toBeInTheDocument();
    expect(within(modal).getByText(/The kill switch can still be engaged/)).toBeInTheDocument();
    // The API engages it on a revoked agent (the page said it did not)
    expect(within(modal).queryByText(/does not engage the kill switch/)).toBeNull();
    for (const name of [/Issue credential/, /Delegate/, /Revoke/]) {
      expect(within(modal).getByRole('button', { name })).toBeDisabled();
    }
    expect(within(modal).getByRole('button', { name: /Kill switch/ })).toBeEnabled();
  });

  it('offers nothing once the kill switch is engaged', async () => {
    const user = userEvent.setup();
    renderPage();
    await agentsTable();

    await user.click(screen.getByRole('button', { name: `Open agent ${killedBot.agentId}` }));
    const modal = await dialog(/^Chat triage/);
    expect(
      within(modal).getByText('The kill switch is engaged: the agent is revoked for good.'),
    ).toBeInTheDocument();
    for (const name of [/Issue credential/, /Delegate/, /Revoke/, /Kill switch/]) {
      expect(within(modal).getByRole('button', { name })).toBeDisabled();
    }
  });

  it('allows revoke and the kill switch on an expired agent, but no credential or delegation', async () => {
    const user = userEvent.setup();
    renderPage();
    await agentsTable();

    await user.click(screen.getByRole('button', { name: 'Open agent nightly-export' }));
    const modal = await dialog(/^Nightly export/);
    expect(within(modal).getByRole('button', { name: /Issue credential/ })).toBeDisabled();
    expect(within(modal).getByRole('button', { name: /Delegate/ })).toBeDisabled();
    expect(within(modal).getByRole('button', { name: /Revoke/ })).toBeEnabled();
    expect(within(modal).getByRole('button', { name: /Kill switch/ })).toBeEnabled();
    expect(
      within(modal).getByText(/only an active agent can delegate; this one is expired/),
    ).toBeInTheDocument();
  });

  it('shows a super-admin the signing status and disables issuing when it is off', async () => {
    serve({ signing: false });
    const user = userEvent.setup();
    renderPage();
    await agentsTable();

    expect(await screen.findByText('Credential signing not configured')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New agent/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `Open agent ${payrollBot.agentId}` }));
    const modal = await dialog(/^Payroll sync/);
    expect(within(modal).getByRole('button', { name: /Issue credential/ })).toBeDisabled();
    expect(
      within(modal).getByText(/credential signing is not configured on the API/),
    ).toBeInTheDocument();
  });

  it('gives a role below super-admin the list and details only, and asks nothing it would refuse', async () => {
    mockIsSuperAdmin = false;
    serve({ agents: [] });
    renderPage();
    expect(await screen.findByText('No non-human identities yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create the first agent/ })).toBeNull();

    serve();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    await agentsTable();
    expect(screen.queryByRole('button', { name: /New agent/ })).toBeNull();
    expect(screen.queryByText(/Credential signing/)).toBeNull();
    expect(callsTo(SIGNING)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: `Open agent ${payrollBot.agentId}` }));
    const modal = await dialog(/^Payroll sync/);
    expect(within(modal).getByText(/need the super-admin role/)).toBeInTheDocument();
    for (const name of [/Issue credential/, /Delegate/, /Revoke/, /Kill switch/]) {
      expect(within(modal).queryByRole('button', { name })).toBeNull();
    }
    expect(mockPost).not.toHaveBeenCalled();
  });
});
