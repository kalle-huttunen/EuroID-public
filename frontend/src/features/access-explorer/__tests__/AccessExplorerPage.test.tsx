/**
 * The access explorer page: an identity's access graph with how each entitlement was granted, the
 * holders of an entitlement, the access path and the SoD violations, each from its GET route; the
 * graph store's 503 shown with the API's message instead of an empty answer; a node the graph does
 * not have told apart from no access; the cuts said on the page; the resync for super-admins only,
 * confirmed in a modal, with every view read again after it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IAccessPathResult, IGraphSodViolations } from '../../../interfaces';
import {
  ADA_ID,
  BOB_ID,
  UNAVAILABLE_MESSAGE,
  apiError,
  bigGraph,
  callsTo,
  choose,
  defaultAnswers,
  location,
  mockGet,
  mockPost,
  openOptions,
  renderPage,
  serve,
} from './AccessExplorerPage.fixtures';

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

const GRAPH = new RegExp(`/access-explorer/identity/${ADA_ID}/graph$`);
const accessTable = () => screen.findByRole('table', { name: 'Access of ada@corp.example' });
const rowOf = (table: HTMLElement, name: string) =>
  within(table).getByText(name).closest('tr') as HTMLElement;

describe('AccessExplorerPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSuperAdmin = true;
    serve();
  });

  it("shows an identity's access with the way to each entitlement and how it was granted", async () => {
    renderPage(`?identity=${ADA_ID}`);
    const table = await accessTable();

    expect(callsTo(GRAPH)).toHaveLength(1);
    expect(
      screen.getByRole('region', { name: 'Access graph of ada@corp.example' }),
    ).toBeInTheDocument();
    const all = rowOf(table, 'All staff');
    expect(within(all).getByText('Direct')).toBeInTheDocument();
    expect(within(all).getByText('Policy: All staff policy')).toBeInTheDocument();
    expect(within(all).getByText('entra-id · Group')).toBeInTheDocument();
    const admin = rowOf(table, 'Finance-Admin');
    expect(within(admin).getByText('Via Finance team')).toBeInTheDocument();
    expect(within(admin).getByText('Provisioned in entra-id on 2026-11-20')).toBeInTheDocument();
    expect(
      within(rowOf(table, 'Finance team')).getByText('Member of the group'),
    ).toBeInTheDocument();
    expect(
      within(rowOf(table, 'Finance-Approver')).getByText('Access request REQ-7'),
    ).toBeInTheDocument();
    // Accounts are not in the graph: the page says so and links the entitlement map
    expect(
      screen.getByText(/Accounts in the target systems are not in the graph/),
    ).toBeInTheDocument();
    // No writer fills group nesting yet: the page does not let "through groups" imply otherwise
    expect(screen.getByText(/Nothing writes group nesting to the graph yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Entitlement map' })).toHaveAttribute(
      'href',
      `/identity/${ADA_ID}/map`,
    );
  });

  it('shows the 503 of a missing graph store with the API message, never "no access"', async () => {
    const answers = defaultAnswers();
    answers.graph[ADA_ID] = apiError(503, UNAVAILABLE_MESSAGE);
    serve(answers);
    renderPage(`?identity=${ADA_ID}`);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The access graph is not available')).toBeInTheDocument();
    expect(within(alert).getByText(UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    expect(within(alert).getByText(/How the graph is filled/)).toBeInTheDocument();
    expect(screen.queryByText(/No access in the graph/)).not.toBeInTheDocument();
    // Not retried on its own: one request until the user asks again
    expect(callsTo(GRAPH)).toHaveLength(1);
    await userEvent.setup().click(within(alert).getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(callsTo(GRAPH)).toHaveLength(2));
  });

  // Not a 503: retried twice (1 s, then 2 s) before the error shows
  it(
    'shows another failure with the API message as an error, not as a missing graph',
    { timeout: 15_000 },
    async () => {
      const answers = defaultAnswers();
      answers.graph[ADA_ID] = apiError(500, 'Internal server error');
      serve(answers);
      renderPage(`?identity=${ADA_ID}`);

      expect(
        await screen.findByText('Could not load the access graph', {}, { timeout: 8000 }),
      ).toBeInTheDocument();
      expect(callsTo(GRAPH)).toHaveLength(3);
      expect(screen.getByText('Internal server error')).toBeInTheDocument();
      expect(screen.queryByText('The access graph is not available')).not.toBeInTheDocument();
    },
  );

  it('tells an identity the graph does not have from one without access', async () => {
    renderPage(`?identity=${BOB_ID}`);

    expect(await screen.findByText('This identity is not in the access graph')).toBeInTheDocument();
    expect(screen.queryByText(/No access in the graph/)).not.toBeInTheDocument();
    // A super-admin can load it from there
    expect(screen.getAllByRole('button', { name: /Load graph from MongoDB/ })).toHaveLength(2);
  });

  it('says when the API cut the answer and when the canvas left nodes out', async () => {
    const answers = defaultAnswers();
    answers.graph[ADA_ID] = bigGraph();
    serve(answers);
    renderPage(`?identity=${ADA_ID}`);
    await accessTable();

    expect(
      screen.getByText('The graph has more than 2000 access paths for this identity'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The canvas shows the 60 nearest of 70 nodes; the table lists all 70/),
    ).toBeInTheDocument();
  });

  it('opens the holders of an entitlement from its row, each identity once with its shortest way', async () => {
    const user = userEvent.setup();
    renderPage(`?identity=${ADA_ID}`);
    const table = await accessTable();

    await user.click(
      within(table).getByRole('button', { name: 'Show who holds Finance-Approver' }),
    );

    const holders = await screen.findByRole('table', { name: 'Holders of Finance-Approver' });
    expect(location()).toBe(
      `/access-explorer?identity=${ADA_ID}&tab=holders&entitlement=grp-fin-appr`,
    );
    expect(screen.getByText(/2 identities hold it/)).toBeInTheDocument();
    const bobRow = within(holders).getByRole('link', { name: 'bob@corp.example' }).closest('tr')!;
    expect(within(bobRow).getByRole('link', { name: 'bob@corp.example' })).toHaveAttribute(
      'href',
      `/identities/${BOB_ID}`,
    );
    // Two ways for bob: the direct one is the shortest
    expect(within(bobRow).getByText('Direct')).toBeInTheDocument();
    expect(within(bobRow).getByText('Policy: Approvers')).toBeInTheDocument();
    expect(within(bobRow).getByText('2')).toBeInTheDocument();

    await user.click(within(bobRow).getByRole('button', { name: /Show the access graph of bob/ }));
    expect(await screen.findByText('This identity is not in the access graph')).toBeInTheDocument();
    expect(location()).toContain(`identity=${BOB_ID}`);
  });

  // Hunt 06 F3: the graph keys an entitlement by system and id (a native id can repeat in another
  // system), so the picker sends <system>::<id>, the typed id with the chosen kind's system.
  it('picks an entitlement from the catalog by its system and id there, or takes a typed id', async () => {
    const answers = defaultAnswers();
    answers.holders['entra-id::grp-fin-appr'] = {
      ...answers.holders['grp-fin-appr'],
      entitlementId: 'entra-id::grp-fin-appr',
    };
    answers.holders['entra-id::grp-unknown'] = {
      entitlementId: 'entra-id::grp-unknown',
      entitlementFound: false,
      entitlement: null,
      holders: [],
      count: 0,
      truncated: false,
      pathLimit: 1000,
    };
    serve(answers);
    const user = userEvent.setup();
    renderPage('?tab=holders');
    expect(await screen.findByText('Choose an entitlement')).toBeInTheDocument();
    // A typed id needs the kind first: it names the system
    expect(screen.getByRole('searchbox', { name: 'Entitlement id' })).toBeDisabled();

    await choose(
      screen.getByRole('combobox', { name: 'Kind of entitlement' }),
      'Microsoft Entra ID group',
    );
    const entitlement = screen.getByRole('combobox', { name: 'Entitlement' });
    await waitFor(() =>
      expect(entitlement.closest('.ant-select')).not.toHaveClass('ant-select-disabled'),
    );
    fireEvent.mouseDown(entitlement);
    await waitFor(() => expect(openOptions()).toContain('Finance-Approver'));
    // An entry without an id in its system is not in the graph and is not offered
    expect(openOptions()).toEqual(['Finance-Approver']);
    fireEvent.click(
      Array.from(document.querySelectorAll('.ant-select-item-option')).find(
        (o) => o.textContent === 'Finance-Approver',
      )!,
    );
    expect(
      await screen.findByRole('table', { name: 'Holders of Finance-Approver' }),
    ).toBeInTheDocument();
    expect(location()).toBe('/access-explorer?tab=holders&entitlement=entra-id%3A%3Agrp-fin-appr');

    await user.type(
      screen.getByRole('searchbox', { name: 'Entitlement id' }),
      'grp-unknown{Enter}',
    );
    expect(
      await screen.findByText('This entitlement is not in the access graph'),
    ).toBeInTheDocument();
    expect(callsTo(/\/entitlement\/entra-id%3A%3Agrp-unknown\/holders$/)).toHaveLength(1);
  });

  it('shows the access path step by step, and which end is missing when there is none', async () => {
    renderPage(`?tab=path&identity=${ADA_ID}&entitlement=grp-fin-admin`);

    expect(await screen.findByText('2 steps, through groups:')).toBeInTheDocument();
    expect(callsTo(/\/access-explorer\/path$/)[0][1]).toEqual({
      params: { fromIdentity: ADA_ID, toEntitlement: 'grp-fin-admin' },
    });
    expect(screen.getByText('Member of the group')).toBeInTheDocument();
    expect(screen.getByText('Provisioned in entra-id on 2026-11-20')).toBeInTheDocument();
  });

  it('says the graph lacks the identity, or that both ends are there without a path', async () => {
    const answers = defaultAnswers();
    const none: IAccessPathResult = {
      fromIdentity: BOB_ID,
      toEntitlement: 'x',
      identityFound: false,
      entitlementFound: true,
      found: false,
      path: null,
    };
    answers.path = none;
    serve(answers);
    const { unmount } = renderPage(`?tab=path&identity=${BOB_ID}&entitlement=x`);
    expect(
      await screen.findByText('The access graph does not have the identity'),
    ).toBeInTheDocument();
    unmount();

    answers.path = { ...none, identityFound: true };
    serve(answers);
    renderPage(`?tab=path&identity=${BOB_ID}&entitlement=x`);
    expect(await screen.findByText('No access path')).toBeInTheDocument();
  });

  it('lists the SoD violations with severity, action and the way to each entitlement', async () => {
    renderPage(`?tab=sod&identity=${ADA_ID}`);

    const card = await screen.findByRole('article', { name: 'Violation of Finance SoD' });
    expect(screen.getByText(/1 of 2 active policies are violated/)).toBeInTheDocument();
    expect(within(card).getByText('High')).toBeInTheDocument();
    expect(within(card).getByText('Block')).toBeInTheDocument();
    expect(within(card).getByText('Via Finance team. Member of the group')).toBeInTheDocument();
    expect(within(card).getByText('Direct. Access request REQ-7')).toBeInTheDocument();
  });

  it('says how many policies were checked, and when there is none to check', async () => {
    const answers = defaultAnswers();
    const clean: IGraphSodViolations = {
      identityId: ADA_ID,
      identityFound: true,
      policiesChecked: 3,
      violations: [],
      violationCount: 0,
    };
    answers.sod = clean;
    serve(answers);
    const { unmount } = renderPage(`?tab=sod&identity=${ADA_ID}`);
    expect(await screen.findByText('No SoD violation in the graph')).toBeInTheDocument();
    expect(screen.getByText(/Checked 3 active policies/)).toBeInTheDocument();
    unmount();

    answers.sod = { ...clean, policiesChecked: 0 };
    serve(answers);
    renderPage(`?tab=sod&identity=${ADA_ID}`);
    expect(await screen.findByText('No active SoD policy to check')).toBeInTheDocument();
  });

  it('loads the graph from MongoDB after a confirmation, shows the counts and reads the views again', async () => {
    const user = userEvent.setup();
    renderPage(`?identity=${ADA_ID}`);
    await accessTable();

    await user.click(screen.getByRole('button', { name: /Load graph from MongoDB/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Then removes what MongoDB no longer has/)).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /Load graph$/ }));

    expect(await within(dialog).findByText('The graph was loaded in 8.4 s')).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledWith(expect.stringMatching(/\/access-explorer\/resync$/));
    expect(within(dialog).getByText('212')).toBeInTheDocument();
    expect(
      within(dialog).getByText('3 identities, 1 entitlements, 0 applications, 12 links'),
    ).toBeInTheDocument();
    await waitFor(() => expect(callsTo(GRAPH)).toHaveLength(2));
  });

  it('keeps a refused resync in the modal with the API message', async () => {
    const answers = defaultAnswers();
    answers.resync = apiError(
      409,
      'A graph resync for this tenant is already running. Wait for it to finish.',
    );
    serve(answers);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Load graph from MongoDB/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Load graph$/ }));

    expect(await within(dialog).findByText('The graph was not loaded')).toBeInTheDocument();
    expect(within(dialog).getByText(/already running/)).toBeInTheDocument();
  });

  it('offers a viewer the views but not the resync, and sends no resync', async () => {
    mockIsSuperAdmin = false;
    renderPage(`?identity=${BOB_ID}`);

    expect(await screen.findByText('This identity is not in the access graph')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Load graph from MongoDB/ }),
    ).not.toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('picks an identity by name and keeps it in the address for the other views', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('Choose an identity')).toBeInTheDocument();

    const box = screen.getByRole('combobox', { name: 'Identity' });
    await user.type(box, 'ada');
    await choose(box, 'Ada Lovelace (ada@corp.example)');

    await accessTable();
    expect(location()).toBe(`/access-explorer?identity=${ADA_ID}`);
    await user.click(screen.getByRole('tab', { name: 'SoD violations' }));
    expect(
      await screen.findByRole('article', { name: 'Violation of Finance SoD' }),
    ).toBeInTheDocument();
    expect(location()).toBe(`/access-explorer?identity=${ADA_ID}&tab=sod`);
  });
});
