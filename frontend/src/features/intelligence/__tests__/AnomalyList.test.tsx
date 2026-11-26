import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { AnomalyList } from '../AnomalyList';
import type { Anomaly, AnomalyType, AnomalySeverity, AnomalyStatus } from '@api/intelligence-api';
import type { AcknowledgeMutationSlice } from '../hooks/useAnomalyData';
import type { IStandardUser } from '../../../interfaces';

// ── Module mocks ──────────────────────────────────────────────────────────────

// Dev builds (VITE_AUTH_DISABLED) grant every role; the role test sets it explicitly.
let mockIsOperator = true;
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => (role === 'viewer' ? true : mockIsOperator),
}));

vi.mock('@config/pagination', () => ({
  RISK_DASHBOARD_PAGE_SIZE: 50,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockAnomaly: Anomaly = {
  anomalyId: 'anomaly-1',
  identityId: 'user-1',
  type: 'TIME_BASED' as AnomalyType,
  severity: 'high' as AnomalySeverity,
  riskScore: 85,
  title: 'Unusual login time',
  description: 'Login detected outside normal working hours.',
  evidence: { events: ['login at 03:00 UTC'], pattern: 'off-hours', details: {} },
  status: 'open' as AnomalyStatus,
  detectedAt: '2026-01-15T10:00:00Z',
};

const defaultAcknowledgeMutation: AcknowledgeMutationSlice = {
  mutate: vi.fn(),
  isPending: false,
};

const defaultProps = {
  anomalies: [] as Anomaly[],
  totalAnomalies: 0,
  anomalyFilters: {} as { type?: AnomalyType; severity?: AnomalySeverity; status?: AnomalyStatus },
  setAnomalyFilters: vi.fn(),
  anomalyPage: 1,
  setAnomalyPage: vi.fn(),
  identityMap: new Map<string, IStandardUser>(),
  anomaliesLoading: false,
  acknowledgeMutation: defaultAcknowledgeMutation,
  handleDismiss: vi.fn(),
  setSelectedAnomalyId: vi.fn(),
};

/** Opens the filter whose placeholder is `placeholder` and clicks the option `option`. */
async function choose(placeholder: string, option: string) {
  const select = screen.getByText(placeholder).closest('.ant-select') as HTMLElement;
  fireEvent.mouseDown(select.querySelector('.ant-select-selector') as HTMLElement);
  const item = await waitFor(() => {
    const found = Array.from(document.querySelectorAll('.ant-select-item-option')).find(
      (o) => o.textContent === option,
    );
    if (!found) throw new Error(`no option "${option}" for ${placeholder}`);
    return found;
  });
  fireEvent.click(item);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AnomalyList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOperator = true;
  });

  it('renders without crashing', () => {
    renderWithProviders(<AnomalyList {...defaultProps} />);
    expect(screen.getByText('Anomalies')).toBeInTheDocument();
  });

  it('filters by type and severity, each time from the first page', async () => {
    // A filter keeps the page it was chosen on: from page 3 a filter with fewer matches asked
    // the API for an empty page 3, and the list said no anomalies were detected.
    const setAnomalyFilters = vi.fn();
    const setAnomalyPage = vi.fn();
    renderWithProviders(
      <ConfigProvider virtual={false}>
        <AnomalyList
          {...defaultProps}
          anomalyFilters={{ status: 'open' }}
          setAnomalyFilters={setAnomalyFilters}
          anomalyPage={3}
          setAnomalyPage={setAnomalyPage}
        />
      </ConfigProvider>,
    );

    await choose('Type', 'Time-based');
    await choose('Severity', 'High');

    // Each choice keeps the other filters (the setter gets an update of the current ones).
    const [byType, bySeverity] = setAnomalyFilters.mock.calls.map(([update]) => update);
    expect(byType({ status: 'open' })).toEqual({ status: 'open', type: 'TIME_BASED' });
    expect(bySeverity({ status: 'open', type: 'TIME_BASED' })).toEqual({
      status: 'open',
      type: 'TIME_BASED',
      severity: 'high',
    });
    expect(setAnomalyPage.mock.calls).toEqual([[1], [1]]);
  });

  it('shows empty state when no anomalies are present', () => {
    renderWithProviders(<AnomalyList {...defaultProps} />);
    expect(screen.getByText(/no anomalies detected/i)).toBeInTheDocument();
  });

  it('shows a loading skeleton when anomaliesLoading is true', () => {
    const { container } = renderWithProviders(<AnomalyList {...defaultProps} anomaliesLoading />);
    expect(container.querySelector('.ant-skeleton')).not.toBeNull();
    expect(screen.queryByText(/no anomalies detected/i)).not.toBeInTheDocument();
  });

  it('renders table with anomaly row data when anomalies are provided', () => {
    renderWithProviders(
      <AnomalyList {...defaultProps} anomalies={[mockAnomaly]} totalAnomalies={1} />,
    );
    // Title column
    expect(screen.getByText('Unusual login time')).toBeInTheDocument();
    // Type tag (mapped label)
    expect(screen.getByText('Time-based')).toBeInTheDocument();
    // Severity tag
    expect(screen.getByText('high')).toBeInTheDocument();
    // Status tag
    expect(screen.getByText('open')).toBeInTheDocument();
  });

  it('does not render Acknowledge/Dismiss for non-open anomalies', () => {
    const acknowledgedAnomaly: Anomaly = {
      ...mockAnomaly,
      anomalyId: 'anomaly-2',
      status: 'acknowledged' as AnomalyStatus,
    };
    renderWithProviders(
      <AnomalyList {...defaultProps} anomalies={[acknowledgedAnomaly]} totalAnomalies={1} />,
    );
    expect(screen.queryByRole('button', { name: /acknowledge/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
  });

  it('falls back to identityId when identity is not in the identityMap', () => {
    renderWithProviders(
      <AnomalyList {...defaultProps} anomalies={[mockAnomaly]} totalAnomalies={1} />,
    );
    // identityMap is empty, so the raw identityId should be displayed
    expect(screen.getByText('user-1')).toBeInTheDocument();
  });

  it('resolves display name from identityMap when available', () => {
    const identityMap = new Map<string, IStandardUser>();
    identityMap.set('user-1', {
      _id: 'user-1',
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Smith',
    } as IStandardUser);

    renderWithProviders(
      <AnomalyList
        {...defaultProps}
        anomalies={[mockAnomaly]}
        totalAnomalies={1}
        identityMap={identityMap}
      />,
    );
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
  });

  it(
    'opens and acts on an anomaly by its anomalyId, the public id the API routes take',
    { timeout: 20_000 },
    async () => {
      // The anomalyId is also what anomaly.detected / anomaly.resolved and notifications carry.
      const user = userEvent.setup();
      const anomalyId = '0b5e2c1d-7a43-4f0e-9d7a-2a1c3b4d5e6f';
      const listed: Anomaly = { ...mockAnomaly, anomalyId, _id: '665f1c2a1b2c3d4e5f607181' };
      const setSelectedAnomalyId = vi.fn();
      const acknowledgeMutation = { mutate: vi.fn(), isPending: false };
      const handleDismiss = vi.fn();
      renderWithProviders(
        <AnomalyList
          {...defaultProps}
          anomalies={[listed]}
          totalAnomalies={1}
          setSelectedAnomalyId={setSelectedAnomalyId}
          acknowledgeMutation={acknowledgeMutation}
          handleDismiss={handleDismiss}
        />,
      );

      await user.click(screen.getByRole('button', { name: /view/i }));
      await user.click(screen.getByRole('button', { name: /acknowledge/i }));
      await user.click(screen.getByRole('button', { name: /dismiss/i }));

      expect(setSelectedAnomalyId).toHaveBeenCalledWith(anomalyId);
      expect(acknowledgeMutation.mutate).toHaveBeenCalledWith(anomalyId);
      expect(handleDismiss).toHaveBeenCalledWith(anomalyId);
    },
  );

  it('offers a viewer only View, since acknowledge and dismiss need operator', () => {
    mockIsOperator = false;
    renderWithProviders(
      <AnomalyList {...defaultProps} anomalies={[mockAnomaly]} totalAnomalies={1} />,
    );
    expect(screen.getByRole('button', { name: /view/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /acknowledge/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
  });
});
