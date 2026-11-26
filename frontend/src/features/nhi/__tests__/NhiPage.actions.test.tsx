/**
 * The super-admin actions of the non-human identities page: create and delegate with the
 * backend's rules shown before submit, revoke and the kill switch with the agents their dry run
 * says they reach and their confirmation, a credential shown once and gone after close, the API's
 * refusal shown in place, and the list reloading after each change.
 */
import { createElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ACTION,
  AGENTS,
  ADA_ID,
  LIST,
  SIGNATURE,
  agentsTable,
  apiError,
  callsTo,
  choose,
  dialog,
  dryRuns,
  fill,
  killedBot,
  mockGet,
  mockPost,
  oldExporter,
  onRealPost,
  ownerlessBot,
  payrollBot,
  payrollReader,
  previewAnswer,
  queryDialog,
  realPosts,
  renderPage,
  serve,
} from './NhiPage.fixtures';

vi.mock('../../../auth/usePermission', () => ({ usePermission: () => true }));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const listCalls = () => callsTo(LIST).filter(([, config]) => config?.params?.limit === 50).length;

async function openAgent(agentId: string, title: RegExp) {
  const user = userEvent.setup();
  renderPage();
  await agentsTable();
  await user.click(screen.getByRole('button', { name: `Open agent ${agentId}` }));
  return { user, modal: await dialog(title) };
}

// Nested modals render in jsdom: these take seconds each. Fields are filled by paste (fill),
// except the owner search, where a typed letter is what starts the search.
describe('NhiPage actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serve();
  });

  it(
    'creates an agent with the rules shown first, and reloads the list',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      renderPage();
      await agentsTable();
      const before = listCalls();

      await user.click(screen.getByRole('button', { name: /New agent/ }));
      const form = await dialog('New agent');
      expect(within(form).getByText(/An active person in the identity hub/)).toBeInTheDocument();
      expect(
        within(form).getByText(/At most 90 days from now; the API shortens/),
      ).toBeInTheDocument();
      expect(
        within(form).getByText(/capabilities like hr:read or entra:users:write/),
      ).toBeInTheDocument();

      await fill(user, within(form).getByLabelText('Agent id'), 'Payroll Bot');
      await user.click(within(form).getByRole('button', { name: 'Create agent' }));
      expect(await within(form).findByText(/a letter first, no hyphen last/)).toBeInTheDocument();
      expect(mockPost).not.toHaveBeenCalled();

      await user.clear(within(form).getByLabelText('Agent id'));
      await fill(user, within(form).getByLabelText('Agent id'), 'hr-sync');
      await fill(user, within(form).getByLabelText('Display name'), 'HR sync');
      await choose(within(form).getByRole('combobox', { name: 'Kind' }), 'Workload');
      const owner = within(form).getByRole('combobox', { name: 'Owner' });
      await user.type(owner, 'o');
      // A suspended person is listed but cannot own an agent.
      const suspended = await choose(
        owner,
        'Grace Hopper (grace.hopper@corp.example), not active (SUSPENDED)',
      );
      expect(suspended).toHaveClass('ant-select-item-option-disabled');
      await choose(owner, 'Ada Lovelace (ada.lovelace@corp.example)');
      await fill(
        user,
        within(form).getByRole('combobox', { name: 'Scope' }),
        'hr:read,entra:users:read,',
      );
      await user.click(within(form).getByRole('button', { name: 'Create agent' }));

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      const [url, body] = mockPost.mock.calls[0];
      expect(url).toMatch(LIST);
      expect(body).toEqual({
        agentId: 'hr-sync',
        displayName: 'HR sync',
        kind: 'workload',
        ownerIdentityId: ADA_ID,
        scope: ['hr:read', 'entra:users:read'],
        expiresAt: expect.any(String),
      });
      const days = (Date.parse(body.expiresAt) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(0);
      expect(days).toBeLessThanOrEqual(90);
      expect(
        await screen.findByText('Agent "hr-sync" created, risk tier medium'),
      ).toBeInTheDocument();
      await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
      await waitFor(() => expect(queryDialog('New agent')).toBeUndefined());
    },
  );

  it('keeps the form open with the API’s refusal', { timeout: 30_000 }, async () => {
    mockPost.mockRejectedValue(apiError(400, "Agent 'payroll-sync-bot' already exists"));
    const user = userEvent.setup();
    renderPage();
    await agentsTable();

    await user.click(screen.getByRole('button', { name: /New agent/ }));
    const form = await dialog('New agent');
    await fill(user, within(form).getByLabelText('Agent id'), 'payroll-sync-bot');
    await fill(user, within(form).getByLabelText('Display name'), 'Payroll sync');
    const owner = within(form).getByRole('combobox', { name: 'Owner' });
    await fill(user, owner, 'ada');
    await choose(owner, 'Ada Lovelace (ada.lovelace@corp.example)');
    await fill(user, within(form).getByRole('combobox', { name: 'Scope' }), 'hr:read,');
    await user.click(within(form).getByRole('button', { name: 'Create agent' }));

    expect(
      await within(form).findByText(
        "Could not create the agent: Agent 'payroll-sync-bot' already exists",
      ),
    ).toBeInTheDocument();
    expect(queryDialog('New agent')).toBeDefined();
  });

  it(
    'delegates a sub-agent within the parent’s scope and expiry',
    { timeout: 30_000 },
    async () => {
      const { user, modal } = await openAgent('payroll-sync-bot', /^Payroll sync/);
      const before = listCalls();

      await user.click(within(modal).getByRole('button', { name: /Delegate/ }));
      const form = await dialog('Delegate from "payroll-sync-bot"');
      expect(
        within(form).getByText(
          "A subset of the parent's scope: hr:read, hr:write, entra:users:write.",
        ),
      ).toBeInTheDocument();
      expect(within(form).getByText(/No later than the parent's expiry/)).toBeInTheDocument();
      // The parent's owner is preselected.
      expect(within(form).getAllByText(/ada\.lovelace@corp\.example/).length).toBeGreaterThan(0);

      await fill(user, within(form).getByLabelText('Agent id'), 'payroll-auditor');
      await fill(user, within(form).getByLabelText('Display name'), 'Payroll auditor');
      await choose(within(form).getByRole('combobox', { name: 'Scope' }), 'hr:read');
      await user.click(within(form).getByRole('button', { name: 'Delegate agent' }));

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      const [url, body] = mockPost.mock.calls[0];
      expect(url).toMatch(ACTION('payroll-sync-bot', 'delegate'));
      expect(body).toMatchObject({
        agentId: 'payroll-auditor',
        displayName: 'Payroll auditor',
        kind: 'service-account',
        ownerIdentityId: ADA_ID,
        scope: ['hr:read'],
      });
      expect(Date.parse(body.expiresAt)).toBeLessThanOrEqual(Date.parse(payrollBot.expiresAt));
      expect(
        await screen.findByText('Agent "payroll-auditor" delegated from "payroll-sync-bot"'),
      ).toBeInTheDocument();
      await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    },
  );

  it(
    'revokes after naming every delegated agent it reaches, and reloads',
    { timeout: 20_000 },
    async () => {
      const { user, modal } = await openAgent('payroll-sync-bot', /^Payroll sync/);
      const before = listCalls();

      await user.click(within(modal).getByRole('button', { name: /Revoke/ }));
      const confirm = await dialog('Revoke "payroll-sync-bot"?');
      expect(within(confirm).getByText('This cannot be undone.')).toBeInTheDocument();
      const reached = await within(confirm).findByRole('list', { name: 'Agents reached' });
      const ids = within(reached)
        .getAllByRole('listitem')
        .map((li) => li.querySelector('code')?.textContent);
      // The API's dry run of the same call; the revoked payroll-exporter is not reached.
      expect(ids).toEqual(['payroll-reader', 'payroll-reader-helper']);
      expect(
        within(confirm).getByText(/and 2 delegated agents, each revoked:/),
      ).toBeInTheDocument();
      expect(within(confirm).getByText(/stops verifying at EuroID at once/)).toBeInTheDocument();
      expect(dryRuns()).toEqual([
        [
          expect.stringMatching(ACTION('payroll-sync-bot', 'revoke')),
          {},
          { params: { dryRun: true } },
        ],
      ]);
      // The browser no longer builds the preview from the list of active agents.
      expect(callsTo(LIST).some(([, c]) => c?.params?.status === 'active')).toBe(false);

      const revoke = within(confirm).getByRole('button', { name: /Revoke agent/ });
      expect(revoke).toBeDisabled();
      await fill(user, within(confirm).getByLabelText('Reason'), 'Owner left the company');
      expect(realPosts()).toHaveLength(0);
      await user.click(revoke);

      await waitFor(() => expect(realPosts()).toHaveLength(1));
      expect(realPosts()[0][0]).toMatch(ACTION('payroll-sync-bot', 'revoke'));
      expect(realPosts()[0][1]).toEqual({ reason: 'Owner left the company' });
      expect(await screen.findByText('Agent "payroll-sync-bot" revoked')).toBeInTheDocument();
      await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    },
  );

  it(
    'lists the agents the dry run answers, ones the page never loaded included',
    { timeout: 20_000 },
    async () => {
      // The browser no longer reads the list (capped at 2000 agents) to find them
      const reached = ['worker-a', 'worker-b', 'worker-c'].map((agentId) => ({
        ...payrollReader,
        agentId,
        parentAgentId: 'payroll-sync-bot',
      }));
      const base = mockPost.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
      mockPost.mockImplementation((url: string, body: unknown, config?: { params?: object }) =>
        config?.params
          ? Promise.resolve({
              data: { ...previewAnswer([], 'payroll-sync-bot', false), changes: true, reached },
            })
          : base(url, body, config),
      );
      const { user, modal } = await openAgent('payroll-sync-bot', /^Payroll sync/);

      await user.click(within(modal).getByRole('button', { name: /Revoke/ }));
      const confirm = await dialog('Revoke "payroll-sync-bot"?');
      const list = await within(confirm).findByRole('list', { name: 'Agents reached' });
      expect(
        within(list)
          .getAllByRole('listitem')
          .map((li) => li.querySelector('code')?.textContent),
      ).toEqual(['worker-a', 'worker-b', 'worker-c']);
      expect(
        within(confirm).getByText(/and 3 delegated agents, each revoked:/),
      ).toBeInTheDocument();
      expect(within(confirm).queryByText(/may miss some/)).toBeNull();
    },
  );

  it('keeps the revoke dialog open with the API’s refusal', { timeout: 20_000 }, async () => {
    onRealPost(() => Promise.reject(apiError(404, "Agent 'payroll-sync-bot' not found")));
    const { user, modal } = await openAgent('payroll-sync-bot', /^Payroll sync/);

    await user.click(within(modal).getByRole('button', { name: /Revoke/ }));
    const confirm = await dialog('Revoke "payroll-sync-bot"?');
    await fill(user, within(confirm).getByLabelText('Reason'), 'Unused');
    await user.click(within(confirm).getByRole('button', { name: /Revoke agent/ }));

    expect(
      await within(confirm).findByText("Revoke failed: Agent 'payroll-sync-bot' not found"),
    ).toBeInTheDocument();
  });

  it('engages the kill switch only after the agent id is typed', { timeout: 20_000 }, async () => {
    const { user, modal } = await openAgent('payroll-reader', /^Payroll reader/);

    await user.click(within(modal).getByRole('button', { name: /Kill switch/ }));
    const confirm = await dialog('Engage the kill switch on "payroll-reader"?');
    expect(
      within(confirm).getByText('The kill switch is permanent. It cannot be undone.'),
    ).toBeInTheDocument();
    const reached = await within(confirm).findByRole('list', { name: 'Agents reached' });
    expect(within(reached).getByText('payroll-reader-helper')).toBeInTheDocument();
    expect(
      within(confirm).getByText(/1 delegated agent, each revoked with the kill switch engaged/),
    ).toBeInTheDocument();

    expect(dryRuns()[0][0]).toMatch(ACTION(payrollReader.agentId, 'kill'));

    const engage = within(confirm).getByRole('button', { name: /Engage kill switch/ });
    await fill(user, within(confirm).getByLabelText('Reason'), 'Leaked credential');
    expect(engage).toBeDisabled();
    await fill(user, within(confirm).getByLabelText('Agent id to confirm'), 'payroll-read');
    expect(engage).toBeDisabled();
    await fill(user, within(confirm).getByLabelText('Agent id to confirm'), 'er');
    expect(engage).toBeEnabled();
    await user.click(engage);

    await waitFor(() => expect(realPosts()).toHaveLength(1));
    expect(realPosts()[0][0]).toMatch(ACTION(payrollReader.agentId, 'kill'));
    expect(realPosts()[0][1]).toEqual({ reason: 'Leaked credential' });
    expect(await screen.findByText('Kill switch engaged on "payroll-reader"')).toBeInTheDocument();
  });

  it(
    'does not claim the kill switch engaged when the API says otherwise',
    { timeout: 20_000 },
    async () => {
      onRealPost(() => Promise.resolve({ data: { ...payrollReader, status: 'revoked' } }));
      const { user, modal } = await openAgent('payroll-reader', /^Payroll reader/);

      await user.click(within(modal).getByRole('button', { name: /Kill switch/ }));
      const confirm = await dialog('Engage the kill switch on "payroll-reader"?');
      await fill(user, within(confirm).getByLabelText('Reason'), 'Leaked credential');
      await fill(user, within(confirm).getByLabelText('Agent id to confirm'), 'payroll-reader');
      await user.click(within(confirm).getByRole('button', { name: /Engage kill switch/ }));

      expect(
        await screen.findByText('The API did not engage the kill switch on "payroll-reader".'),
      ).toBeInTheDocument();
    },
  );

  it(
    'keeps the kill switch available when the preview cannot load',
    { timeout: 20_000 },
    async () => {
      const base = mockPost.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
      mockPost.mockImplementation((url: string, body: unknown, config?: { params?: object }) =>
        config?.params
          ? Promise.reject(apiError(503, 'Service Unavailable'))
          : base(url, body, config),
      );
      const { user, modal } = await openAgent('payroll-reader', /^Payroll reader/);

      await user.click(within(modal).getByRole('button', { name: /Kill switch/ }));
      const confirm = await dialog('Engage the kill switch on "payroll-reader"?');
      expect(
        await within(confirm).findByText(
          'Could not load the delegated agents: Service Unavailable',
        ),
      ).toBeInTheDocument();
      expect(
        within(confirm).getByText(/revokes every active delegated agent anyway/),
      ).toBeInTheDocument();
      await fill(user, within(confirm).getByLabelText('Reason'), 'Leaked credential');
      await fill(user, within(confirm).getByLabelText('Agent id to confirm'), 'payroll-reader');
      expect(within(confirm).getByRole('button', { name: /Engage kill switch/ })).toBeEnabled();
    },
  );

  // The page refused it with "the API does not engage the kill switch on a revoked agent"
  it(
    'engages the kill switch on a revoked agent, with the delegated agents it still reaches',
    { timeout: 20_000 },
    async () => {
      const exportHelper = {
        ...payrollReader,
        _id: '64b7f0c2a1b2c3d4e5f60b07',
        agentId: 'export-helper',
        displayName: 'Export helper',
        parentAgentId: oldExporter.agentId,
      };
      serve({ agents: [...AGENTS, exportHelper] });
      const { user, modal } = await openAgent(oldExporter.agentId, /^Payroll exporter/);
      expect(within(modal).getByRole('button', { name: /Revoke/ })).toBeDisabled();

      await user.click(within(modal).getByRole('button', { name: /Kill switch/ }));
      const confirm = await dialog('Engage the kill switch on "payroll-exporter"?');
      expect(
        within(confirm).getByText(/is already revoked: it keeps its first revocation/),
      ).toBeInTheDocument();
      const reached = await within(confirm).findByRole('list', { name: 'Agents reached' });
      expect(within(reached).getByText('export-helper')).toBeInTheDocument();
      // The detail modal asks the revoke's dry run first (a cascade to finish); this is the kill's
      expect(dryRuns().map(([url]) => url)).toContainEqual(
        expect.stringMatching(ACTION(oldExporter.agentId, 'kill')),
      );
      expect(
        within(confirm).getByText(/the agent keeps the reason of its revocation/),
      ).toBeInTheDocument();

      await fill(user, within(confirm).getByLabelText('Reason'), 'Key leaked');
      await fill(user, within(confirm).getByLabelText('Agent id to confirm'), oldExporter.agentId);
      await user.click(within(confirm).getByRole('button', { name: /Engage kill switch/ }));

      await waitFor(() => expect(realPosts()).toHaveLength(1));
      expect(realPosts()[0][0]).toMatch(ACTION(oldExporter.agentId, 'kill'));
      expect(realPosts()[0][1]).toEqual({ reason: 'Key leaked' });
      expect(
        await screen.findByText('Kill switch engaged on "payroll-exporter"'),
      ).toBeInTheDocument();
    },
  );

  // HX-G follow-up: a revoke or kill switch that failed part way through left delegated agents
  // active, and calling it again (which completes it) was API-only: the modal offered a revoked
  // agent only the kill switch and a killed one nothing.
  it(
    'finishes the cascade a revoke left part way, from the revoked agent',
    { timeout: 20_000 },
    async () => {
      const exportHelper = {
        ...payrollReader,
        _id: '64b7f0c2a1b2c3d4e5f60b07',
        agentId: 'export-helper',
        displayName: 'Export helper',
        parentAgentId: oldExporter.agentId,
      };
      serve({ agents: [...AGENTS, exportHelper] });
      const { user, modal } = await openAgent(oldExporter.agentId, /^Payroll exporter/);
      expect(
        await within(modal).findByText(/1 delegated agent is still active/),
      ).toBeInTheDocument();

      await user.click(within(modal).getByRole('button', { name: /Finish cascade/ }));
      const confirm = await dialog('Finish the cascade of "payroll-exporter"?');
      const reached = await within(confirm).findByRole('list', { name: 'Agents reached' });
      expect(within(reached).getByText('export-helper')).toBeInTheDocument();
      expect(
        within(confirm).getByText(/revokes the 1 delegated agent still active/),
      ).toBeInTheDocument();
      const finish = within(confirm).getByRole('button', { name: /Revoke delegated agents/ });
      expect(finish).toBeDisabled();
      await fill(user, within(confirm).getByLabelText('Reason'), 'Owner left');
      await user.click(finish);

      await waitFor(() => expect(realPosts()).toHaveLength(1));
      expect(realPosts()[0][0]).toMatch(ACTION(oldExporter.agentId, 'revoke'));
      expect(realPosts()[0][1]).toEqual({ reason: 'Owner left' });
      expect(await screen.findByText('Cascade of "payroll-exporter" finished')).toBeInTheDocument();
    },
  );

  it(
    'finishes the cascade of a killed agent with the kill switch, after the id is typed',
    { timeout: 20_000 },
    async () => {
      const triageHelper = {
        ...payrollReader,
        _id: '64b7f0c2a1b2c3d4e5f60b08',
        agentId: 'triage-helper',
        displayName: 'Triage helper',
        parentAgentId: killedBot.agentId,
      };
      serve({ agents: [...AGENTS, triageHelper] });
      const { user, modal } = await openAgent(killedBot.agentId, /^Chat triage/);

      await user.click(await within(modal).findByRole('button', { name: /Finish cascade/ }));
      const confirm = await dialog('Finish the cascade of "chat-triage-bot"?');
      expect(
        await within(confirm).findByText(
          /revokes the 1 delegated agent still active, with the kill switch engaged/,
        ),
      ).toBeInTheDocument();
      await fill(user, within(confirm).getByLabelText('Reason'), 'Prompt injection');
      const finish = within(confirm).getByRole('button', {
        name: /Engage kill switch on delegated agents/,
      });
      expect(finish).toBeDisabled();
      await fill(user, within(confirm).getByLabelText('Agent id to confirm'), killedBot.agentId);
      await user.click(finish);

      await waitFor(() => expect(realPosts()).toHaveLength(1));
      expect(realPosts()[0][0]).toMatch(ACTION(killedBot.agentId, 'kill'));
    },
  );

  it('offers no cascade to finish when no delegated agent is left active', async () => {
    const { modal } = await openAgent(killedBot.agentId, /^Chat triage/);

    await waitFor(() => expect(dryRuns()).toHaveLength(1));
    expect(dryRuns()[0][0]).toMatch(ACTION(killedBot.agentId, 'kill'));
    expect(within(modal).queryByRole('button', { name: /Finish cascade/ })).toBeNull();
    expect(within(modal).queryByText(/still active/)).toBeNull();
  });

  // HX-G follow-up: an agent whose owner was offboarded or erased gets no new credential until
  // a super-admin gives it a new owner (or revokes it); credentials issued before keep working
  it(
    'gives an ownerless agent a new owner, after saying why it gets no credential',
    { timeout: 30_000 },
    async () => {
      serve({ agents: [...AGENTS, ownerlessBot] });
      const { user, modal } = await openAgent(ownerlessBot.agentId, /^Invoice bot/);
      expect(within(modal).getByText('No owner')).toBeInTheDocument();
      expect(within(modal).getByText(/The owner was offboarded on/)).toBeInTheDocument();
      expect(
        within(modal).getByText(/Credentials issued before keep working until/),
      ).toBeInTheDocument();
      expect(within(modal).getByRole('button', { name: /Issue credential/ })).toBeDisabled();
      expect(
        within(modal).getByText(/Issue credential is not available: the agent has no owner/),
      ).toBeInTheDocument();

      await user.click(within(modal).getByRole('button', { name: /Change owner/ }));
      const form = await dialog('Change the owner of "invoice-bot"');
      const save = within(form).getByRole('button', { name: 'Save owner' });
      expect(save).toBeDisabled();
      const owner = within(form).getByRole('combobox', { name: 'New owner' });
      await user.type(owner, 'o');
      await choose(owner, 'Ada Lovelace (ada.lovelace@corp.example)');
      await user.click(save);

      await waitFor(() => expect(realPosts()).toHaveLength(1));
      expect(realPosts()[0][0]).toMatch(ACTION(ownerlessBot.agentId, 'owner'));
      expect(realPosts()[0][1]).toEqual({ ownerIdentityId: ADA_ID });
      expect(
        await screen.findByText('"invoice-bot" is now owned by ada.lovelace@corp.example'),
      ).toBeInTheDocument();
    },
  );

  it('shows an issued credential once and forgets it on close', { timeout: 20_000 }, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    renderPage((page) => createElement(QueryClientProvider, { client }, page));
    await agentsTable();
    await user.click(screen.getByRole('button', { name: 'Open agent payroll-sync-bot' }));
    const modal = await dialog(/^Payroll sync/);

    await user.click(within(modal).getByRole('button', { name: /Issue credential/ }));
    let issue = await dialog('Issue a credential for "payroll-sync-bot"?');
    expect(within(issue).getByText(/POST \/api\/v1\/nhi\/credentials\/verify/)).toBeInTheDocument();
    expect(within(issue).getByText(/GET \/api\/v1\/nhi\/_\/public-key/)).toBeInTheDocument();
    expect(within(issue).getByLabelText('Valid for (minutes)')).toHaveValue('15');
    await user.click(within(issue).getByRole('button', { name: /Issue credential/ }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0][0]).toMatch(ACTION('payroll-sync-bot', 'credentials'));
    expect(mockPost.mock.calls[0][1]).toEqual({ ttlSeconds: 900 });
    const shown = await dialog('Credential for "payroll-sync-bot"');
    expect(
      within(shown).getByText('Copy the credential now: it is shown only once.'),
    ).toBeInTheDocument();
    expect(within(shown).getByLabelText('Issued credential')).toHaveTextContent(SIGNATURE);
    expect(
      within(shown).getByText('spiffe://euroid.local/tenants/tenant-a/agents/payroll-sync-bot'),
    ).toBeInTheDocument();
    expect(within(shown).getByRole('button', { name: /Copy/ })).toBeInTheDocument();

    // Nothing outside the modal holds it: no query or mutation cache, no browser storage.
    const cached = JSON.stringify([
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
      client
        .getMutationCache()
        .getAll()
        .map((m) => m.state.data),
    ]);
    expect(cached).not.toContain(SIGNATURE);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(SIGNATURE);

    await user.click(within(shown).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(document.body.textContent).not.toContain(SIGNATURE));
    await user.click(within(modal).getByRole('button', { name: /Issue credential/ }));
    issue = await dialog('Issue a credential for "payroll-sync-bot"?');
    expect(within(issue).queryByLabelText('Issued credential')).toBeNull();
    expect(document.body.textContent).not.toContain(SIGNATURE);
  });

  it('shows why a credential was refused', { timeout: 20_000 }, async () => {
    mockPost.mockRejectedValue(apiError(409, 'Agent payroll-sync-bot is expired'));
    const { user, modal } = await openAgent('payroll-sync-bot', /^Payroll sync/);

    await user.click(within(modal).getByRole('button', { name: /Issue credential/ }));
    const issue = await dialog('Issue a credential for "payroll-sync-bot"?');
    await user.click(within(issue).getByRole('button', { name: /Issue credential/ }));

    expect(
      await within(issue).findByText(
        'Could not issue a credential: Agent payroll-sync-bot is expired',
      ),
    ).toBeInTheDocument();
  });
});
