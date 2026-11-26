/**
 * Deleting a quarantined orphaned account asks first, with the simulated impact, and only then
 * signals the delete. The list used antd's static Modal.confirm and message, which render nothing
 * under React 19 without the app's patch and stand outside the app's theme: the confirmation and
 * its toast now come from App.useApp().
 *
 * Adopt and Delete on the orphaned accounts list show the API's own message when they fail: a
 * drift already corrected or ignored answers 409 with the reason, an unreachable Temporal says
 * so. Before, both showed a fixed "Failed to send ... signal". A failed Adopt stops loading at
 * once: onError returned the toast, which React Query awaited, so the dialog kept loading until
 * the toast closed 3 s later (FOLLOWUPS 2026-11-25).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { OrphanedAccountsList } from '../OrphanedAccountsList';
import { axiosInstance } from '@api/data';

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn(), post: vi.fn() },
}));

const mockGet = vi.mocked(axiosInstance.get);
const mockPost = vi.mocked(axiosInstance.post);

vi.mock('@api/constants', () => ({
  API_BASE: '/api/v1',
}));

vi.mock('@api/identity-api', () => ({
  fetchIdentitiesForSelect: vi
    .fn()
    .mockResolvedValue([
      { id: 'identity-1', displayName: 'Ada Lovelace', email: 'ada@corp.example' },
    ]),
  identityKeys: { listForSelect: () => ['identities', 'select'] },
}));

const DRIFT_ID = '6650aaaaaaaaaaaaaaaaaaaa';

/** GET /reconciliation/drifts?type=ORPHAN_ACCOUNT as the API answers it (`_id`, no `id`). */
const orphansPage = {
  success: true,
  drifts: [
    {
      _id: DRIFT_ID,
      type: 'ORPHAN_ACCOUNT',
      severity: 'high',
      status: 'quarantined',
      userId: 'ext-1',
      userDisplayName: 'Orphan Account',
      userEmail: 'orphan@corp.example',
      targetSystem: 'entra-id',
      detectedAt: '2026-11-20T10:00:00.000Z',
      orphanDetails: { targetSystem: 'entra-id', externalId: 'ext-1' },
    },
  ],
  total: 1,
  page: 1,
  limit: 50,
  totalPages: 1,
};

/** An axios error carrying the API's answer. */
function apiError(status: number, message: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { statusCode: status, message } },
  });
}

const CONFLICT =
  'Orphan drift 6650aaaaaaaaaaaaaaaaaaaa is ignored and its cleanup has ended: nothing to adopt or delete';

/** [Delete] on the orphan's row, then Delete in the confirmation (its simulated impact). */
async function confirmDelete(user: ReturnType<typeof userEvent.setup>) {
  const row = (await screen.findByText('Orphan Account')).closest('tr')!;
  await user.click(within(row).getByRole('button', { name: /delete/i }));
  const heading = await screen.findByText('Delete orphaned account?', {
    selector: '.ant-modal-confirm-title',
  });
  const dialog = heading.closest('.ant-modal') as HTMLElement;
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
}

describe('OrphanedAccountsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(axiosInstance.get).mockImplementation(async (url: string) => {
      if (url.includes('/orphans/stats')) {
        return { data: { success: true, total: 1, quarantined: 1, disabled: 0, resolved: 0 } };
      }
      if (url.includes('/simulate-delete')) {
        return { data: { success: true, impact: 'Account "Orphan Account" will be removed.' } };
      }
      return { data: orphansPage };
    });
  });

  it("shows the API's reason when Delete fails", async () => {
    vi.mocked(axiosInstance.post).mockRejectedValue(apiError(409, CONFLICT));
    const user = userEvent.setup();
    renderWithProviders(<OrphanedAccountsList />);

    await confirmDelete(user);

    expect(await screen.findByText(CONFLICT)).toBeInTheDocument();
    expect(axiosInstance.post).toHaveBeenCalledWith(
      `/api/v1/reconciliation/orphans/${DRIFT_ID}/signal`,
      { action: 'DELETE', identityId: undefined },
    );
    expect(screen.queryByText('Failed to send delete signal')).not.toBeInTheDocument();
  });

  it("shows the API's reason when Adopt fails", async () => {
    const unreachable =
      'Temporal is not connected. Start the Temporal server (e.g. temporal server start-dev) and restart the backend.';
    vi.mocked(axiosInstance.post).mockRejectedValue(apiError(500, unreachable));
    const user = userEvent.setup();
    renderWithProviders(<OrphanedAccountsList />);

    const row = (await screen.findByText('Orphan Account')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: /adopt/i }));
    const modal = (await screen.findByText('Adopt orphaned account')).closest(
      '.ant-modal-content',
    ) as HTMLElement;
    await user.click(within(modal).getByRole('combobox'));
    const option = await waitFor(() => {
      const el = document.querySelector(
        '.ant-select-item-option[title="Ada Lovelace (ada@corp.example)"]',
      );
      if (!el) throw new Error('identity option not rendered');
      return el as HTMLElement;
    });
    await user.click(option);
    const adopt = within(modal).getByRole('button', { name: 'Adopt' });
    await user.click(adopt);

    const toast = await screen.findByText(unreachable);
    expect(axiosInstance.post).toHaveBeenCalledWith(
      `/api/v1/reconciliation/orphans/${DRIFT_ID}/signal`,
      { action: 'ADOPT', identityId: 'identity-1' },
    );
    // The dialog can be used again while the toast still shows (it closes after 3 s)
    await waitFor(() => expect(adopt).not.toHaveClass('ant-btn-loading'), { timeout: 2000 });
    expect(toast).toBeInTheDocument();
  });

  it('falls back to its own text when the API gives no reason', async () => {
    vi.mocked(axiosInstance.post).mockRejectedValue({});
    const user = userEvent.setup();
    renderWithProviders(<OrphanedAccountsList />);

    await confirmDelete(user);

    expect(await screen.findByText('Failed to send delete signal')).toBeInTheDocument();
  });
});

const DELETE_DRIFT_ID = '6741c0f2a9d3e5b1c2f40c01';
const IMPACT =
  'Deletes the Entra ID account svc-legacy-backup (no Golden Record). Its 2 group memberships go with it.';

/** As GET /reconciliation/drifts?type=ORPHAN_ACCOUNT answers it (`_id`, mapped to `id`). */
const orphan = {
  _id: DELETE_DRIFT_ID,
  type: 'ORPHAN_ACCOUNT',
  severity: 'high',
  userId: '',
  userDisplayName: 'svc-legacy-backup',
  userEmail: 'svc-legacy-backup@corp.example',
  targetSystem: 'entra-id',
  detectedAt: '2026-11-20T08:00:00.000Z',
  autoCorrectEligible: false,
  status: 'quarantined',
};

describe('OrphanedAccountsList delete confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/simulate-delete'))
        return Promise.resolve({
          data: {
            success: true,
            accountIdentifier: 'svc-legacy-backup',
            accountName: 'svc-legacy-backup',
            targetSystem: 'entra-id',
            impact: IMPACT,
          },
        });
      if (url.includes('/orphans/stats'))
        return Promise.resolve({
          data: { success: true, total: 1, quarantined: 1, disabled: 0, resolved: 0, bySystem: {} },
        });
      if (url.includes('/reconciliation/drifts'))
        return Promise.resolve({
          data: { drifts: [orphan], total: 1, page: 1, limit: 50, totalPages: 1 },
        });
      return Promise.resolve({ data: [] });
    });
    mockPost.mockResolvedValue({ data: { success: true } });
  });

  it(
    'asks with the simulated impact before it signals the delete, then confirms it',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      renderWithProviders(<OrphanedAccountsList />);

      const row = (await screen.findByText('svc-legacy-backup')).closest('tr')!;
      await user.click(within(row).getByRole('button', { name: /Delete/ }));

      const dialog = (
        await screen.findByText('Delete orphaned account?', {
          selector: '.ant-modal-confirm-title',
        })
      ).closest('.ant-modal') as HTMLElement;
      expect(within(dialog).getByText(IMPACT)).toBeInTheDocument();
      expect(mockPost).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`/reconciliation/orphans/${DELETE_DRIFT_ID}/signal$`)),
          { action: 'DELETE', identityId: undefined },
        ),
      );
      expect(await screen.findByText('Delete signal sent')).toBeInTheDocument();
    },
  );

  // EuroID never deletes an AD account (HX-F report follow-up): no Delete for it, and the
  // reason a cleanup recorded is shown
  it('offers no Delete for an Active Directory orphan and shows why it is kept', async () => {
    const reason =
      'EuroID never deletes an Active Directory account: AD gives no recycle bin guarantee.';
    vi.mocked(axiosInstance.get).mockImplementation(async (url: string) => {
      if (url.includes('/orphans/stats')) {
        return { data: { success: true, total: 1, quarantined: 1, disabled: 1, resolved: 0 } };
      }
      return {
        data: {
          ...orphansPage,
          drifts: [
            {
              ...orphansPage.drifts[0],
              targetSystem: 'ad',
              orphanDetails: { targetSystem: 'ad', externalId: 'ext-1', keptReason: reason },
            },
          ],
        },
      };
    });
    renderWithProviders(<OrphanedAccountsList />);

    const row = (await screen.findByText('Orphan Account')).closest('tr')!;
    expect(within(row).getByRole('button', { name: /adopt/i })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /delete/i })).toBeNull();
    expect(within(row).getByText('Kept, never deleted')).toBeInTheDocument();
  });
});
