import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '../../../test/test-utils';
import { ReconciliationDashboard } from '../ReconciliationDashboard';
import { fetchDriftStats, fetchDriftsPaginated } from '@api/reconciliation-api';
import { axiosInstance } from '@api/data';
import { useConnectorStore } from '@stores/connector-store';

vi.mock('@api/reconciliation-api', () => ({
  fetchDriftsPaginated: vi.fn().mockResolvedValue({ drifts: [], total: 0 }),
  fetchConnectorHealth: vi.fn().mockResolvedValue([]),
  fetchDriftStats: vi
    .fn()
    .mockResolvedValue({ total: 0, critical: 0, autoFixEligible: 0, pending: 0 }),
  reconciliationKeys: {
    driftsPaginated: () => ['driftsPaginated'],
    connectorHealth: () => ['connectorHealth'],
    drifts: () => ['drifts'],
    driftStats: () => ['driftStats'],
  },
}));

vi.mock('@api/identity-api', () => ({
  uncorrelatedKeys: { count: () => ['uncorrelated-count'] },
}));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: vi.fn().mockResolvedValue({ data: { count: 0 } }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('@api/constants', () => ({
  API_BASE: '/api/v1',
}));

vi.mock('../../auth', () => ({
  usePermission: vi.fn().mockReturnValue(true),
}));

vi.mock('../../auth/token-store', () => ({
  getTenantId: vi.fn().mockReturnValue('default'),
}));

vi.mock('../DriftList', () => ({
  DriftList: ({
    onUserClick,
    onAutoFix,
    onIgnore,
  }: {
    onUserClick?: (userId: string) => void;
    onAutoFix?: (driftIds: string[]) => void;
    onIgnore?: (driftIds: string[]) => void;
  }) => (
    <div data-testid="drift-list">
      <button onClick={() => onUserClick?.('64b7f0c2a1b2c3d4e5f60001')}>Open drift user</button>
      <button onClick={() => onAutoFix?.(['d1', 'd2'])}>Auto-Fix two drifts</button>
      <button onClick={() => onIgnore?.(['d3'])}>Ignore one drift</button>
      <button onClick={() => onIgnore?.(['d4', 'd5'])}>Ignore two drifts</button>
    </div>
  ),
}));

vi.mock('../OrphanedAccountsList', () => ({
  OrphanedAccountsList: () => <div data-testid="orphaned-list">OrphanedAccounts</div>,
}));

vi.mock('../ConnectorHealth', () => ({
  ConnectorHealth: () => <div data-testid="connector-health">ConnectorHealth</div>,
}));

vi.mock('@shared/LiveBadge', () => ({
  LiveBadge: () => <span data-testid="live-badge">Live</span>,
}));

/** Clicks OK in the open confirmation titled `title`, after checking nothing was posted yet. */
async function confirm(user: ReturnType<typeof userEvent.setup>, title: string, ok: string) {
  // antd also puts the confirm's title in a hidden modal title; match the visible one.
  const dialog = (await screen.findByText(title, { selector: '.ant-modal-confirm-title' })).closest(
    '.ant-modal',
  ) as HTMLElement;
  expect(axiosInstance.post).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: ok }));
}

function LocationProbe() {
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  return <div data-testid="location">{`${location.pathname}${location.search} from ${from}`}</div>;
}

describe('ReconciliationDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    renderWithProviders(<ReconciliationDashboard />);
    expect(screen.getByRole('heading', { name: 'Reconciliation' })).toBeInTheDocument();
  });

  it('renders drift tab', async () => {
    renderWithProviders(<ReconciliationDashboard />);
    expect(screen.getByText('Drift dashboard')).toBeInTheDocument();
  });

  it("opens a drift's user on the identity page's Drift tab, with Back returning here", async () => {
    // 3.dn: the identity drawer became the page /identities/:id.
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <ReconciliationDashboard />
        <LocationProbe />
      </>,
      { initialRoute: '/reconciliation' },
    );

    await user.click(await screen.findByRole('button', { name: 'Open drift user' }));

    expect(screen.getByTestId('location')).toHaveTextContent(
      '/identities/64b7f0c2a1b2c3d4e5f60001?tab=drift from /reconciliation',
    );
  });

  it('reads the drift page and filters from the URL, so Back from an identity restores them', async () => {
    renderWithProviders(<ReconciliationDashboard />, {
      initialRoute: '/reconciliation?severity=high&search=maija&page=2',
    });

    await screen.findByTestId('drift-list');
    expect(fetchDriftsPaginated).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, severity: 'high', search: 'maija' }),
    );
  });
  // 2.0dh: these confirmations used the static Modal.confirm, which renders nothing under
  // React 19, so none of them opened and their actions never ran from the UI.
  /** The tenant's installed connectors, as GET /connectors listed them this session. */
  function installed(...names: string[]) {
    useConnectorStore.setState({
      installed: names.map((connectorName) => ({ connectorName, config: {}, installedAt: '' })),
      syncedFromBackend: true,
    });
  }

  // 09 F6: the button sent 'entra-id' and 'active-directory' (a name reconciliation cannot read;
  // AD is 'ad') whatever the tenant had, and always auto-corrected.
  it('starts the daily reconciliation once its confirmation is accepted', async () => {
    installed('ad', 'okta');
    const user = userEvent.setup();
    renderWithProviders(<ReconciliationDashboard />);

    await user.click(await screen.findByRole('button', { name: /Run daily reconciliation$/ }));
    expect(await screen.findByText(/Scans Entra ID, Active Directory against/)).toBeInTheDocument();
    await confirm(user, 'Run daily reconciliation?', 'Yes, Run');

    await waitFor(() =>
      expect(axiosInstance.post).toHaveBeenCalledWith(
        '/api/v1/reconciliation/start-daily',
        expect.objectContaining({
          targetSystems: ['entra-id', 'ad'],
          autoCorrect: true,
          autoCorrectTypes: ['MISSING_USER', 'STATUS_MISMATCH'],
        }),
      ),
    );
    // A run starts on request: the API refuses a cronSchedule or enabled: false (400), so the
    // button sends neither
    const [, body] = vi
      .mocked(axiosInstance.post)
      .mock.calls.find(([url]) => url === '/api/v1/reconciliation/start-daily')!;
    expect(body).not.toHaveProperty('cronSchedule');
    expect(body).not.toHaveProperty('enabled');
  });

  it('starts a report-only run when the operator turns auto-correct off', async () => {
    installed();
    const user = userEvent.setup();
    renderWithProviders(<ReconciliationDashboard />);

    await user.click(await screen.findByRole('button', { name: /Run daily reconciliation$/ }));
    await user.click(await screen.findByRole('checkbox', { name: /Auto-correct/ }));
    await confirm(user, 'Run daily reconciliation?', 'Yes, Run');

    await waitFor(() =>
      expect(axiosInstance.post).toHaveBeenCalledWith(
        '/api/v1/reconciliation/start-daily',
        expect.objectContaining({
          targetSystems: ['entra-id'],
          autoCorrect: false,
          autoCorrectTypes: [],
        }),
      ),
    );
  });

  it("shows the API's reason when a run cannot start", async () => {
    installed();
    vi.mocked(axiosInstance.post).mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 409'), {
        response: {
          status: 409,
          data: { message: 'A daily reconciliation of this tenant is already running' },
        },
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<ReconciliationDashboard />);

    await user.click(await screen.findByRole('button', { name: /Run daily reconciliation$/ }));
    await confirm(user, 'Run daily reconciliation?', 'Yes, Run');

    expect(
      await screen.findByText('A daily reconciliation of this tenant is already running'),
    ).toBeInTheDocument();
  });

  // Final review FE4: the button's loading covered only the confirmation's OK, so a double click
  // while the connector list loaded opened two confirmations; and a failed GET /connectors left
  // AD and SCIM out of the run without a word
  describe('while the installed connectors load', () => {
    const notSynced = () =>
      useConnectorStore.setState({ installed: [], syncedFromBackend: false, syncError: null });

    afterEach(() => {
      vi.mocked(axiosInstance.get).mockImplementation(() =>
        Promise.resolve({ data: { count: 0 } }),
      );
    });

    it('opens one confirmation for a double click, with the button loading meanwhile', async () => {
      notSynced();
      let answer!: (value: unknown) => void;
      vi.mocked(axiosInstance.get).mockImplementation((url: string) =>
        url === '/api/v1/connectors'
          ? new Promise((resolve) => (answer = resolve))
          : Promise.resolve({ data: { count: 0 } }),
      );
      const user = userEvent.setup();
      renderWithProviders(<ReconciliationDashboard />);

      const button = await screen.findByRole('button', { name: /Run daily reconciliation$/ });
      await user.click(button);
      await user.click(button);
      await waitFor(() => expect(button).toHaveClass('ant-btn-loading'));
      answer({ data: [{ connectorName: 'ad', config: {}, installedAt: '' }] });

      await screen.findByText('Run daily reconciliation?', {
        selector: '.ant-modal-confirm-title',
      });
      expect(
        screen.getAllByText('Run daily reconciliation?', { selector: '.ant-modal-confirm-title' }),
      ).toHaveLength(1);
    });

    it('shows why the connectors could not be read, and starts nothing', async () => {
      notSynced();
      vi.mocked(axiosInstance.get).mockImplementation((url: string) =>
        url === '/api/v1/connectors'
          ? Promise.reject(
              Object.assign(new Error('Request failed with status code 503'), {
                response: {
                  status: 503,
                  data: { message: 'The stored config of connector "ad" could not be decrypted' },
                },
              }),
            )
          : Promise.resolve({ data: { count: 0 } }),
      );
      const user = userEvent.setup();
      renderWithProviders(<ReconciliationDashboard />);

      await user.click(await screen.findByRole('button', { name: /Run daily reconciliation$/ }));

      expect(
        await screen.findByText(/The stored config of connector "ad" could not be decrypted/),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('Run daily reconciliation?', { selector: '.ant-modal-confirm-title' }),
      ).toBeNull();
      expect(axiosInstance.post).not.toHaveBeenCalled();
    });
  });

  it('auto-fixes the chosen drifts once the confirmation is accepted', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReconciliationDashboard />);

    await user.click(await screen.findByRole('button', { name: 'Auto-Fix two drifts' }));
    await confirm(user, 'Auto-Fix Drifts?', 'Yes, Auto-Fix');

    await waitFor(() =>
      expect(axiosInstance.post).toHaveBeenCalledWith(
        '/api/v1/reconciliation/drifts/bulk-correct',
        { driftIds: ['d1', 'd2'] },
      ),
    );
  });

  // 2.0dt: the toast said "Auto-Fix applied to 0 drift(s)." as a success when every correction
  // failed; the reasons were only in the server log.
  it('warns with the counts and the reason when Auto-Fix could not correct every drift', async () => {
    const reason = 'The user was not found in entra-id';
    vi.mocked(axiosInstance.post).mockResolvedValueOnce({
      data: {
        success: false,
        corrected: 0,
        failed: 2,
        failures: [
          { driftId: 'd1', error: reason },
          { driftId: 'd2', error: reason },
        ],
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<ReconciliationDashboard />);

    await user.click(await screen.findByRole('button', { name: 'Auto-Fix two drifts' }));
    await confirm(user, 'Auto-Fix Drifts?', 'Yes, Auto-Fix');

    const toast = await screen.findByText(
      'Auto-Fix corrected 0 of 2 drifts. Not corrected: 2. Reason: The user was not found in entra-id.',
    );
    expect(toast.closest('.ant-message-warning')).not.toBeNull();
  });

  it('reports a success only when every chosen drift was corrected', async () => {
    vi.mocked(axiosInstance.post).mockResolvedValueOnce({
      data: { success: true, corrected: 2, failed: 0, failures: [] },
    });
    const user = userEvent.setup();
    renderWithProviders(<ReconciliationDashboard />);

    await user.click(await screen.findByRole('button', { name: 'Auto-Fix two drifts' }));
    await confirm(user, 'Auto-Fix Drifts?', 'Yes, Auto-Fix');

    const toast = await screen.findByText('Auto-Fix corrected 2 drifts.');
    expect(toast.closest('.ant-message-success')).not.toBeNull();
  });

  // One row's Ignore takes the single route, which also takes a quarantined orphan drift (and
  // stops its cleanup); the bulk route ignores open drifts only, so it answered "Ignored 0".
  it("ignores one row's drift through its own route once the confirmation is accepted", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReconciliationDashboard />);

    await user.click(await screen.findByRole('button', { name: 'Ignore one drift' }));
    expect(
      await screen.findByText(
        'This marks 1 drift as ignored. It stays in the list with the status Ignored and offers no further action. Continue?',
      ),
    ).toBeInTheDocument();
    await confirm(user, 'Ignore Drifts?', 'Yes, Ignore');

    await waitFor(() =>
      expect(axiosInstance.post).toHaveBeenCalledWith('/api/v1/reconciliation/drifts/d3/ignore'),
    );
    expect(await screen.findByText('Ignored 1 drift.')).toBeInTheDocument();
  });

  it('ignores the selected drifts through the bulk route once the confirmation is accepted', async () => {
    const user = userEvent.setup();
    vi.mocked(axiosInstance.post).mockResolvedValueOnce({ data: { ignored: 2 } });
    renderWithProviders(<ReconciliationDashboard />);

    await user.click(await screen.findByRole('button', { name: 'Ignore two drifts' }));
    await confirm(user, 'Ignore Drifts?', 'Yes, Ignore');

    await waitFor(() =>
      expect(axiosInstance.post).toHaveBeenCalledWith('/api/v1/reconciliation/drifts/bulk-ignore', {
        driftIds: ['d4', 'd5'],
      }),
    );
    expect(await screen.findByText('Ignored 2 drifts.')).toBeInTheDocument();
  });

  // The stats count open drifts only (GET /reconciliation/drifts/stats), the list every status
  it('names the count of open drifts as such', async () => {
    renderWithProviders(<ReconciliationDashboard />);

    expect(await screen.findByText('Open drifts')).toBeInTheDocument();
    expect(screen.queryByText('Total drifts')).toBeNull();
  });

  // A failed stats call showed the list's total (every status) as the open drifts
  it('shows no figure, and says so, when the drift stats cannot be loaded', async () => {
    vi.mocked(fetchDriftsPaginated).mockResolvedValueOnce({ drifts: [], total: 7 });
    vi.mocked(fetchDriftStats).mockRejectedValueOnce(new Error('Network Error'));
    renderWithProviders(<ReconciliationDashboard />);

    const retry = await screen.findByRole('button', { name: /Drift figures could not be loaded/ });
    expect(within(retry).getByText('—')).toBeInTheDocument();
    await waitFor(() => expect(fetchDriftsPaginated).toHaveBeenCalled());
    expect(screen.queryByText('7')).toBeNull();
  });
});
