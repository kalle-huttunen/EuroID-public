import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import dayjs from 'dayjs';
import { useAuditEvents } from '@api/audit-api';
import { renderWithProviders } from '../../../test/test-utils';
import { AuditDashboard } from '../AuditDashboard';

vi.mock('@api/audit-api', () => ({
  useAuditEvents: vi.fn().mockReturnValue({
    data: { events: [], total: 0 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useAuditStats: vi.fn().mockReturnValue({
    data: { totalEvents: 0, byAction: {}, bySeverity: {} },
    isLoading: false,
  }),
}));

// The Target system filter lists the registered connectors (GET /connectors/available).
vi.mock('@api/connectors-api', () => ({
  useAvailableConnectors: vi.fn().mockReturnValue({
    data: [
      { id: 'entra-id', name: 'Entra ID' },
      { id: 'okta', name: 'Okta' },
    ],
  }),
}));

vi.mock('@config/polling', () => ({
  POLL_INTERVALS: { AUDIT_LOG: 30000 },
}));

vi.mock('@shared/LiveBadge', () => ({
  LiveBadge: () => <span data-testid="live-badge">Live</span>,
}));

describe('AuditDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty state when no audit events', () => {
    renderWithProviders(<AuditDashboard />);
    const log = screen.getByRole('region', { name: 'Audit log' });
    expect(within(log).getByText('No audit events match your filters')).toBeInTheDocument();
    expect(
      within(log).getByText('Try adjusting your search criteria or date range'),
    ).toBeInTheDocument();
    // The file's first render loads the page and antd: it can take seconds on a loaded machine.
  }, 15_000);

  // The audit integrity page links a broken event's moment (its timestamp as both ends).
  it('starts filtered to the time window a link names, shown to the second', () => {
    const at = '2026-11-24T08:15:30.125Z';
    renderWithProviders(<AuditDashboard />, {
      initialRoute: `/audit?dateFrom=${encodeURIComponent(at)}&dateTo=${encodeURIComponent(at)}`,
    });

    expect(vi.mocked(useAuditEvents).mock.calls[0][0]).toEqual(
      expect.objectContaining({ dateFrom: at, dateTo: at, page: 1 }),
    );
    expect(screen.getAllByDisplayValue(dayjs(at).format('YYYY-MM-DD HH:mm:ss'))).toHaveLength(2);
  });

  // Clearing the range used to put null in the filter state and fail the page.
  it('drops the linked window when the range is cleared', () => {
    const at = '2026-11-24T08:15:30.125Z';
    renderWithProviders(<AuditDashboard />, {
      initialRoute: `/audit?dateFrom=${encodeURIComponent(at)}&dateTo=${encodeURIComponent(at)}`,
    });

    fireEvent.click(document.querySelector('.ant-picker-clear') as Element);

    const filter = vi.mocked(useAuditEvents).mock.calls.at(-1)?.[0];
    expect(filter?.dateFrom).toBeUndefined();
    expect(filter?.dateTo).toBeUndefined();
    expect(screen.getByRole('region', { name: 'Audit log' })).toBeInTheDocument();
  });

  it('starts unfiltered without a linked window', () => {
    renderWithProviders(<AuditDashboard />, { initialRoute: '/audit?dateFrom=not-a-time' });

    const filter = vi.mocked(useAuditEvents).mock.calls[0][0];
    expect(filter?.dateFrom).toBeUndefined();
    expect(filter?.dateTo).toBeUndefined();
  });

  // The options came from the events of the current page only, so a system that did not appear on
  // page 1 could not be chosen.
  it("offers every registered connector as a Target system, not only the page's systems", async () => {
    vi.mocked(useAuditEvents).mockReturnValue({
      data: {
        data: [
          {
            id: 'e1',
            action: 'PROVISIONING_EXECUTED',
            severity: 'info',
            timestamp: '2026-11-24T08:15:30.125Z',
            actor: 'Temporal Worker',
            resourceType: 'user',
            resourceId: 'id-1',
            resourceName: 'Ada',
            targetSystem: 'entra-id',
            description: 'Provisioned',
          },
        ],
        total: 1,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useAuditEvents>);
    renderWithProviders(<AuditDashboard />);

    const placeholder = Array.from(
      document.querySelectorAll('.ant-select-selection-placeholder'),
    ).find((el) => el.textContent === 'Target system') as HTMLElement;
    const select = placeholder.closest('.ant-select') as HTMLElement;
    fireEvent.mouseDown(select.querySelector('.ant-select-selector') as HTMLElement);

    await waitFor(() => {
      const options = Array.from(document.querySelectorAll('.ant-select-item-option')).map(
        (o) => o.textContent,
      );
      expect(options).toEqual(expect.arrayContaining(['Entra ID', 'Okta']));
    });
  });
});
