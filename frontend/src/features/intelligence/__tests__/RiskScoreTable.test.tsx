import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { RiskScoreTable } from '../RiskScoreTable';
import type { EnrichedRiskScore } from '../hooks/useRiskScoreEnrichment';
import type { RiskFactorId } from '@api/intelligence-api';

// ── Recharts mock (not testable in jsdom) ─────────────────────────────────────

vi.mock('recharts', () => ({
  LineChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="line-chart">{children}</div>
  ),
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockEnrichedScore: EnrichedRiskScore = {
  identityId: 'user-1',
  score: 72,
  name: 'Alice Smith',
  email: 'alice@example.com',
  department: 'Engineering',
  openAnomalies: 2,
  trend: 'INCREASING',
  topFactors: 'High-risk: 3, Anomalies: 2',
  history: [],
  factors: [],
};

const highRiskScore: EnrichedRiskScore = {
  identityId: 'user-2',
  score: 90,
  name: 'Bob Jones',
  email: 'bob@example.com',
  department: 'Finance',
  openAnomalies: 5,
  trend: 'STABLE',
  topFactors: 'SoD: 4, Admin tier: 3',
  history: [],
  factors: [],
};

const defaultProps = {
  enrichedRiskScores: [] as EnrichedRiskScore[],
  riskScoresLoading: false,
  riskScoresFullLoading: false,
  useFullScores: false,
};

/** The cell of the row of `identityId` under the column titled `column`. */
function cellOf(identityId: string, column: string): HTMLElement {
  const titles = screen.getAllByRole('columnheader').map((h) => h.textContent);
  const row = document.querySelector(`tr[data-row-key="${identityId}"]`) as HTMLElement;
  return within(row).getAllByRole('cell')[titles.indexOf(column)];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RiskScoreTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    renderWithProviders(<RiskScoreTable {...defaultProps} />);
    expect(screen.getByText('Top 20 Risky Users')).toBeInTheDocument();
  });

  it('shows legacy empty state message when useFullScores is false and no data', () => {
    renderWithProviders(<RiskScoreTable {...defaultProps} />);
    expect(screen.getByText(/no risk scores yet/i)).toBeInTheDocument();
    expect(screen.getByText(/run anomaly analysis to get started/i)).toBeInTheDocument();
  });

  it('shows composite empty state message when useFullScores is true and no data', () => {
    renderWithProviders(<RiskScoreTable {...defaultProps} useFullScores />);
    expect(screen.getByText(/no risk scores yet/i)).toBeInTheDocument();
    expect(screen.getByText(/nightly calculation runs at 2 am/i)).toBeInTheDocument();
  });

  it('renders a loading skeleton when riskScoresLoading is true and no full scores', () => {
    renderWithProviders(<RiskScoreTable {...defaultProps} riskScoresLoading />);
    // During skeleton loading the empty-state message must not be visible
    expect(screen.queryByText(/no risk scores yet/i)).not.toBeInTheDocument();
  });

  it('renders table column headers when data is provided', () => {
    renderWithProviders(
      <RiskScoreTable {...defaultProps} enrichedRiskScores={[mockEnrichedScore]} />,
    );
    // The header cells: the table scrolls sideways, and its hidden measure row repeats the titles.
    for (const name of [
      'Name',
      'Email',
      'Department',
      /Risk Score/,
      'Trend',
      'Top Factors',
      'Open Anomalies',
    ]) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
  });

  it('renders enriched score row data correctly', () => {
    renderWithProviders(
      <RiskScoreTable {...defaultProps} enrichedRiskScores={[mockEnrichedScore]} />,
    );
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    // Risk score is rendered as a Tag containing the numeric value
    expect(screen.getByText('72')).toBeInTheDocument();
    // Top factors text
    expect(screen.getByText('High-risk: 3, Anomalies: 2')).toBeInTheDocument();
    // Open anomalies badge
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders a dash in an empty Top Factors cell and an Open Anomalies cell of zero', () => {
    // Two rows, so each dash is checked in its own column: one empty cell must not hide another.
    const noFactors: EnrichedRiskScore = {
      ...mockEnrichedScore,
      identityId: 'user-4',
      topFactors: '',
      openAnomalies: 2,
    };
    const noAnomalies: EnrichedRiskScore = {
      ...highRiskScore,
      identityId: 'user-3',
      openAnomalies: 0,
    };
    renderWithProviders(
      <RiskScoreTable {...defaultProps} enrichedRiskScores={[noFactors, noAnomalies]} />,
    );

    expect(cellOf('user-4', 'Top Factors')).toHaveTextContent(/^-$/);
    expect(cellOf('user-4', 'Open Anomalies')).toHaveTextContent(/^2$/);
    expect(cellOf('user-3', 'Top Factors')).toHaveTextContent(/^SoD: 4, Admin tier: 3$/);
    expect(cellOf('user-3', 'Open Anomalies')).toHaveTextContent(/^-$/);
  });

  it('labels every factor in the factor breakdown, an unknown one by its id', async () => {
    const user = userEvent.setup();
    const withFactors: EnrichedRiskScore = {
      ...mockEnrichedScore,
      factors: [
        { factor: 'peer_deviation', rawValue: 0.4, contribution: 10 },
        { factor: 'anomaly_count', rawValue: 3, contribution: 25 },
        // A factor id the frontend has no label for.
        { factor: 'login_velocity' as RiskFactorId, rawValue: 7, contribution: 12 },
      ],
    };
    renderWithProviders(<RiskScoreTable {...defaultProps} enrichedRiskScores={[withFactors]} />);

    await user.click(screen.getByRole('button', { name: /expand row/i }));

    expect(await screen.findByText(/^Peer deviation:/)).toBeInTheDocument();
    expect(screen.getByText(/^Anomalies:/)).toBeInTheDocument();
    expect(screen.getByText(/^Login velocity:/)).toBeInTheDocument();
    expect(screen.queryByText(/^undefined:/)).not.toBeInTheDocument();
  });
});
