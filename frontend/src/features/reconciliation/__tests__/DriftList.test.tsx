import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { axiosInstance } from '@api/data';
import { fetchDriftsPaginated } from '@api/reconciliation-api';
import { DriftList } from '../DriftList';
import type { IDrift } from '../../../interfaces';

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn(), post: vi.fn() },
}));

// Drifts as GET /reconciliation/drifts sends them: `_id`, no `id`.
const apiDrift = (_id: string, userDisplayName: string, autoCorrectEligible: boolean) => ({
  _id,
  tenantId: 'dev-tenant',
  type: 'FIELD_MISMATCH',
  severity: 'medium',
  userId: `user-${_id}`,
  userDisplayName,
  userEmail: 'x•••@example.com',
  targetSystem: 'entra-id',
  field: 'jobTitle',
  hubValue: 'Senior Developer',
  targetValue: 'Developer',
  detectedAt: '2026-11-22T10:00:00.000Z',
  autoCorrectEligible,
  status: 'open',
  __v: 0,
});

const originalMatchMedia = window.matchMedia;

/** The Reconciliation page's drift list, loaded the way the page loads it. */
async function loadDrifts(): Promise<IDrift[]> {
  vi.mocked(axiosInstance.get).mockResolvedValue({
    data: {
      success: true,
      drifts: [
        apiDrift('6650a1b2c3d4e5f6a7b8c9d0', 'Matti Virtanen', true),
        apiDrift('6650a1b2c3d4e5f6a7b8c9d1', 'Juha Nieminen', true),
        apiDrift('6650a1b2c3d4e5f6a7b8c9d2', 'Anna Lindqvist', false),
      ],
      total: 3,
      page: 1,
      limit: 50,
      totalPages: 1,
    },
  });
  return (await fetchDriftsPaginated({ page: 1, limit: 50 })).drifts;
}

const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

describe('DriftList actions use the ids the API sent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Desktop width: the table with row selection, not the mobile cards.
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('row Auto-Fix and Ignore pass that drift id', { timeout: 20_000 }, async () => {
    const onAutoFix = vi.fn();
    const onIgnore = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DriftList drifts={await loadDrifts()} onAutoFix={onAutoFix} onIgnore={onIgnore} />,
    );

    await user.click(within(rowOf('Juha Nieminen')).getByRole('button', { name: /Auto-Fix/ }));
    await user.click(within(rowOf('Anna Lindqvist')).getByRole('button', { name: /Ignore/ }));

    expect(onAutoFix).toHaveBeenCalledWith(['6650a1b2c3d4e5f6a7b8c9d1']);
    expect(onIgnore).toHaveBeenCalledWith(['6650a1b2c3d4e5f6a7b8c9d2']);
  });

  it('bulk Auto-Fix and Ignore pass the selected drift ids', { timeout: 20_000 }, async () => {
    const onAutoFix = vi.fn();
    const onIgnore = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DriftList drifts={await loadDrifts()} onAutoFix={onAutoFix} onIgnore={onIgnore} />,
    );

    await user.click(within(rowOf('Matti Virtanen')).getByRole('checkbox'));
    await user.click(within(rowOf('Anna Lindqvist')).getByRole('checkbox'));
    const bar = screen.getByRole('toolbar', { name: '2 items selected' });
    // Bulk Auto-Fix sends only the auto-correctable drifts of the selection.
    await user.click(within(bar).getByRole('button', { name: /Auto-Fix/ }));
    expect(onAutoFix).toHaveBeenCalledWith(['6650a1b2c3d4e5f6a7b8c9d0']);

    await user.click(within(rowOf('Matti Virtanen')).getByRole('checkbox'));
    await user.click(within(rowOf('Juha Nieminen')).getByRole('checkbox'));
    await user.click(
      within(screen.getByRole('toolbar', { name: '2 items selected' })).getByRole('button', {
        name: /Ignore/,
      }),
    );
    expect(onIgnore).toHaveBeenCalledWith(['6650a1b2c3d4e5f6a7b8c9d0', '6650a1b2c3d4e5f6a7b8c9d1']);
  });

  // The list holds every status (GET /reconciliation/drifts), and the actions were offered on
  // each row: Ignore on a corrected drift ended "Ignored 0 drift(s)." (browser check 2026-11-25).
  // The API takes Auto-Fix and Ignore on an open drift, and Ignore on a quarantined orphan drift.
  it('offers each action only where the API takes it, and shows the status', async () => {
    const user = userEvent.setup();
    const onAutoFix = vi.fn();
    const onIgnore = vi.fn();
    const drift = (id: string, name: string, status: string, type = 'FIELD_MISMATCH') => ({
      ...apiDrift(id, name, true),
      status,
      type,
    });
    vi.mocked(axiosInstance.get).mockResolvedValue({
      data: {
        success: true,
        drifts: [
          drift('6650a1b2c3d4e5f6a7b8c9e0', 'Olli Open', 'open'),
          drift('6650a1b2c3d4e5f6a7b8c9e1', 'Riikka Salminen', 'corrected'),
          drift('6650a1b2c3d4e5f6a7b8c9e2', 'Lauri Virtanen', 'ignored'),
          drift('6650a1b2c3d4e5f6a7b8c9e3', 'svc-orphan', 'quarantined', 'ORPHAN_ACCOUNT'),
        ],
        total: 4,
        page: 1,
        limit: 50,
        totalPages: 1,
      },
    });
    const { drifts } = await fetchDriftsPaginated({ page: 1, limit: 50 });
    renderWithProviders(<DriftList drifts={drifts} onAutoFix={onAutoFix} onIgnore={onIgnore} />);

    const actions = (name: string) =>
      within(rowOf(name))
        .getAllByRole('button')
        .map((b) => b.textContent?.trim())
        .filter(Boolean);
    expect(actions('Olli Open')).toEqual(['Auto-Fix', 'Ignore', 'View']);
    expect(actions('Riikka Salminen')).toEqual(['View']);
    expect(actions('Lauri Virtanen')).toEqual(['View']);
    expect(actions('svc-orphan')).toEqual(['Ignore', 'View']);

    expect(within(rowOf('Olli Open')).getByText('Open')).toBeInTheDocument();
    expect(within(rowOf('Riikka Salminen')).getByText('Corrected')).toBeInTheDocument();
    expect(within(rowOf('Lauri Virtanen')).getByText('Ignored')).toBeInTheDocument();
    expect(within(rowOf('svc-orphan')).getByText('Quarantined')).toBeInTheDocument();

    // The bulk routes act on open drifts only: a closed or quarantined row cannot be selected
    expect(within(rowOf('Olli Open')).getByRole('checkbox')).toBeEnabled();
    for (const name of ['Riikka Salminen', 'Lauri Virtanen', 'svc-orphan']) {
      expect(within(rowOf(name)).getByRole('checkbox')).toBeDisabled();
    }

    await user.click(within(rowOf('svc-orphan')).getByRole('button', { name: /Ignore/ }));
    expect(onIgnore).toHaveBeenCalledWith(['6650a1b2c3d4e5f6a7b8c9e3']);
    expect(onAutoFix).not.toHaveBeenCalled();
  });

  // View had only e.stopPropagation(): clicking it did nothing
  it("View opens and closes that drift's details", { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    renderWithProviders(<DriftList drifts={await loadDrifts()} canOperate={false} />);
    const view = within(rowOf('Juha Nieminen')).getByRole('button', { name: /View/ });
    expect(view).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Full drift details')).not.toBeInTheDocument();

    await user.click(view);

    expect(view).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByText('Full drift details')).toHaveLength(1);
    const details = screen.getByText(/"id": "6650a1b2c3d4e5f6a7b8c9d1"/);
    expect(details).toHaveTextContent('"userDisplayName": "Juha Nieminen"');

    await user.click(view);

    expect(view).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Full drift details')).not.toBeVisible();
  });
});
