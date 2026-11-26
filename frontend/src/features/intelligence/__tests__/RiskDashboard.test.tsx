import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { RiskDashboard } from '../RiskDashboard';
import { useAnomalyData } from '../hooks/useAnomalyData';
import { fetchRiskScoreDistribution, fetchRiskScores, type Anomaly } from '@api/intelligence-api';
import { useSocket } from '@api/realtime';

const mockAnalyze = vi.fn();

// Dev builds (VITE_AUTH_DISABLED) grant every role; the role tests set it explicitly.
let mockIsSuperAdmin = true;
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => (role === 'super-admin' ? mockIsSuperAdmin : true),
}));

// ── API mocks ────────────────────────────────────────────────────────────────

vi.mock('@api/intelligence-api', () => ({
  fetchRiskScores: vi.fn().mockResolvedValue([]),
  fetchRiskScoresFull: vi.fn().mockResolvedValue([]),
  fetchRiskScoreDistribution: vi.fn().mockResolvedValue(null),
  intelligenceKeys: {
    riskScores: () => ['intelligence', 'risk-scores'],
    riskScoresFull: (params?: object) => ['intelligence', 'risk-scores-full', params],
    riskScoreDistribution: () => ['intelligence', 'risk-score-distribution'],
    anomalies: (params?: object) => ['intelligence', 'anomalies', params],
    anomaly: (id: string) => ['intelligence', 'anomaly', id],
  },
  useAnalyzeAnomalies: () => ({ mutateAsync: mockAnalyze, isPending: false }),
}));

vi.mock('@api/realtime', () => ({
  useSocket: vi.fn().mockReturnValue({ socket: null, status: 'disconnected' }),
}));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

// ── Sub-component mocks ───────────────────────────────────────────────────────

vi.mock('../RiskScoreTable', () => ({
  RiskScoreTable: () => <div data-testid="risk-score-table">RiskScoreTable</div>,
}));

vi.mock('../AnomalyList', () => ({
  AnomalyList: () => <div data-testid="anomaly-list">AnomalyList</div>,
}));

// The modal is tested on its own; here only what the dashboard hands it.
const modalProps = vi.fn();
vi.mock('../AnomalyDetailModal', () => ({
  AnomalyDetailModal: (props: unknown) => {
    modalProps(props);
    return null;
  },
}));

// ── Hook mocks ────────────────────────────────────────────────────────────────

vi.mock('../hooks/useRiskScoreEnrichment', () => ({
  getDisplayName: (u?: { firstName?: string; lastName?: string }) =>
    [u?.firstName, u?.lastName].filter(Boolean).join(' '),
  useRiskScoreEnrichment: vi.fn().mockReturnValue({
    identityMap: new Map([
      [
        '64b7f0c2a1b2c3d4e5f60001',
        { _id: '64b7f0c2a1b2c3d4e5f60001', firstName: 'Maija', lastName: 'M' },
      ],
    ]),
    enrichedRiskScores: [],
    openAnomaliesByIdentity: new Map(),
    useFullScores: false,
  }),
}));

vi.mock('../hooks/useAnomalyData', () => ({ useAnomalyData: vi.fn() }));

const baseAnomalyData = {
  anomalies: [] as Anomaly[],
  totalAnomalies: 0,
  allOpenAnomalies: [] as Anomaly[],
  totalOpenAnomalies: 0,
  anomalyFilters: {},
  setAnomalyFilters: vi.fn(),
  anomalyPage: 1,
  setAnomalyPage: vi.fn(),
  selectedAnomalyId: null as string | null,
  setSelectedAnomalyId: vi.fn(),
  acknowledgeMutation: { mutate: vi.fn(), isPending: false },
  dismissMutation: { mutate: vi.fn(), isPending: false },
  anomaliesLoading: false,
};

const listedAnomaly: Anomaly = {
  _id: '665f1c2a1b2c3d4e5f607181',
  anomalyId: '0b5e2c1d-7a43-4f0e-9d7a-2a1c3b4d5e6f',
  identityId: '64b7f0c2a1b2c3d4e5f60001',
  type: 'VELOCITY',
  severity: 'medium',
  riskScore: 20,
  title: 'Many changes',
  description: 'Many provisioning operations.',
  evidence: { events: [], pattern: 'burst', details: {} },
  status: 'open',
  detectedAt: '2026-11-22T10:00:00.000Z',
};

// ── Recharts mock (not testable in jsdom) ────────────────────────────────────

vi.mock('recharts', () => ({
  BarChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="bar-chart">{children}</div>
  ),
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// ── @api/resource-hooks mock ─────────────────────────────────────────────────

vi.mock('@api/resource-hooks', () => ({
  useList: vi.fn().mockReturnValue({ data: { data: [], total: 0 }, isLoading: false }),
}));

/** The value under a key figure's label. */
const kpi = (label: string) =>
  within(screen.getByRole('group', { name: 'Key figures' })).getByText(label)
    .nextElementSibling as HTMLElement;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RiskDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSuperAdmin = true;
    vi.mocked(useSocket).mockReturnValue({ socket: null, status: 'disconnected' });
    vi.mocked(useAnomalyData).mockReturnValue(
      baseAnomalyData as unknown as ReturnType<typeof useAnomalyData>,
    );
  });

  it('renders without crashing', () => {
    renderWithProviders(<RiskDashboard />);
    expect(screen.getByText('Risk dashboard')).toBeInTheDocument();
  });

  it('renders the page subtitle', () => {
    renderWithProviders(<RiskDashboard />);
    expect(
      screen.getByText(/monitor access anomalies and identity risk scores/i),
    ).toBeInTheDocument();
  });

  it('sums the open anomalies, critical ones, high-risk identities and the average score', async () => {
    vi.mocked(useAnomalyData).mockReturnValue({
      ...baseAnomalyData,
      allOpenAnomalies: [
        { ...listedAnomaly, severity: 'critical' },
        { ...listedAnomaly, anomalyId: 'a-2', severity: 'critical' },
        { ...listedAnomaly, anomalyId: 'a-3', severity: 'high' },
      ],
      totalOpenAnomalies: 7,
    } as unknown as ReturnType<typeof useAnomalyData>);
    // No distribution yet: the average is that of the listed scores; 76 and above is high risk.
    vi.mocked(fetchRiskScores).mockResolvedValueOnce(
      [80, 76, 40, 24].map((riskScore, i) => ({
        identityId: `id-${i}`,
        riskScore,
        updatedAt: '2026-11-22T10:00:00.000Z',
      })),
    );
    renderWithProviders(<RiskDashboard />);

    await waitFor(() => expect(kpi('High-risk identities')).toHaveTextContent(/^2$/));
    expect(kpi('Total open anomalies')).toHaveTextContent(/^7$/);
    expect(kpi('Critical')).toHaveTextContent(/^2$/);
    expect(kpi('Avg risk score')).toHaveTextContent(/^55\.0$/);
  });

  it("shows the distribution's average once the backend has one", async () => {
    vi.mocked(fetchRiskScoreDistribution).mockResolvedValueOnce({
      buckets: [],
      average: 61.5,
      median: 58,
    });
    renderWithProviders(<RiskDashboard />);

    await waitFor(() => expect(kpi('Avg risk score')).toHaveTextContent(/^61\.5$/));
  });

  it('renders the mocked RiskScoreTable sub-component', () => {
    renderWithProviders(<RiskDashboard />);
    expect(screen.getByTestId('risk-score-table')).toBeInTheDocument();
  });

  it('renders the mocked AnomalyList sub-component', () => {
    renderWithProviders(<RiskDashboard />);
    expect(screen.getByTestId('anomaly-list')).toBeInTheDocument();
  });

  it('shows the "Live" tag only while the socket is connected', () => {
    const { rerender } = renderWithProviders(<RiskDashboard />);
    expect(screen.queryByText('Live')).not.toBeInTheDocument();

    vi.mocked(useSocket).mockReturnValue({ socket: null, status: 'connected' });
    rerender(<RiskDashboard />);
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('hands the modal the selected list row, found by its anomalyId, and the identity name', () => {
    vi.mocked(useAnomalyData).mockReturnValue({
      ...baseAnomalyData,
      anomalies: [listedAnomaly],
      selectedAnomalyId: listedAnomaly.anomalyId,
    } as unknown as ReturnType<typeof useAnomalyData>);
    renderWithProviders(<RiskDashboard />);

    expect(modalProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        anomalyId: listedAnomaly.anomalyId,
        row: listedAnomaly,
        identityLabel: 'Maija M',
      }),
    );
  });

  it(
    'lets a super-admin run the anomaly analysis and says how many identities it covered of how many',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      mockAnalyze.mockResolvedValue({
        analyzed: 50,
        totalIdentities: 312,
        anomaliesCreated: 3,
        identityIds: [],
        ruleFailures: { rules: 0, identities: 0, byRule: {} },
      });
      renderWithProviders(<RiskDashboard />);

      await user.click(screen.getByRole('button', { name: /Run anomaly analysis$/ }));

      expect(
        await screen.findByText('Analysed 50 of 312 identities: 3 new anomalies.'),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/The other 262 are analysed when they are provisioned/),
      ).toBeInTheDocument();
      expect(screen.queryByText(/failed/)).toBeNull();
      expect(mockAnalyze).toHaveBeenCalledWith(undefined);
    },
  );

  it(
    'says which rules failed for how many identities instead of reporting a clean run',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      mockAnalyze.mockResolvedValue({
        analyzed: 40,
        totalIdentities: 40,
        anomaliesCreated: 0,
        identityIds: [],
        ruleFailures: { rules: 2, identities: 37, byRule: { TIME_BASED: 1, ORPHAN_ACCESS: 36 } },
      });
      renderWithProviders(<RiskDashboard />);

      await user.click(screen.getByRole('button', { name: /Run anomaly analysis$/ }));

      expect(
        await screen.findByText(
          'Analysed 40 of 40 identities: no new anomalies. 2 rules failed for 37 identities.',
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Failed: Time-based \(1 identity\), Orphan Access \(36 identities\)\./),
      ).toBeInTheDocument();
      expect(screen.queryByText(/The other/)).toBeNull();
      expect(document.querySelector('.ant-alert-warning')).not.toBeNull();
    },
  );

  it('reports a failed analysis with the API reason', async () => {
    const user = userEvent.setup();
    mockAnalyze.mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        response: { data: { message: 'Requires one of: super-admin' } },
      }),
    );
    renderWithProviders(<RiskDashboard />);

    await user.click(screen.getByRole('button', { name: /Run anomaly analysis$/ }));

    expect(
      await screen.findByText('Analysis failed: Requires one of: super-admin'),
    ).toBeInTheDocument();
  });

  it('does not offer the analysis below super-admin, like POST /anomalies/analyze', () => {
    mockIsSuperAdmin = false;
    renderWithProviders(<RiskDashboard />);
    expect(screen.queryByRole('button', { name: /Run anomaly analysis$/ })).toBeNull();
  });
});
