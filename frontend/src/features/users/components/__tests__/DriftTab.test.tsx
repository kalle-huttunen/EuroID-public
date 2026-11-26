import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useQuery } from '@tanstack/react-query';
import { renderWithProviders } from '../../../../test/test-utils';
import { axiosInstance } from '@api/data';
import { reconciliationKeys } from '@api/reconciliation-api';
import { DriftTab } from '../DriftTab';

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn(), post: vi.fn() },
}));

const get = vi.mocked(axiosInstance.get);
const post = vi.mocked(axiosInstance.post);

const IDENTITY_ID = '6650aaaaaaaaaaaaaaaaaaaa';

// Drifts as GET /reconciliation/drifts sends them: `_id`, no `id`.
const apiDrift = (_id: string, field: string, autoCorrectEligible: boolean) => ({
  _id,
  tenantId: 'dev-tenant',
  type: 'FIELD_MISMATCH',
  severity: 'medium',
  userId: IDENTITY_ID,
  userDisplayName: 'Matti Virtanen',
  userEmail: 'm•••@example.com',
  targetSystem: 'entra-id',
  field,
  hubValue: 'Senior Developer',
  targetValue: 'Developer',
  detectedAt: '2026-11-22T10:00:00.000Z',
  autoCorrectEligible,
  status: 'open',
  __v: 0,
});

describe('DriftTab', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, 'error');
    get.mockResolvedValue({
      data: {
        success: true,
        drifts: [
          apiDrift('6650a1b2c3d4e5f6a7b8c9d0', 'jobTitle', true),
          apiDrift('6650a1b2c3d4e5f6a7b8c9d1', 'department', false),
        ],
        total: 2,
        page: 1,
        limit: 50,
        totalPages: 1,
      },
    });
    post.mockResolvedValue({ data: { success: true } });
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('corrects the drift by the id the API sent, with a key per row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DriftTab identityId={IDENTITY_ID} />);

    const row = (await screen.findByText('jobTitle')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /Fix/ }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/api/v1/reconciliation/drifts/6650a1b2c3d4e5f6a7b8c9d0/correct',
      ),
    );
    expect(post).toHaveBeenCalledTimes(1);
    const keyWarnings = consoleError.mock.calls.filter((args) =>
      args.some((a) => typeof a === 'string' && /unique\W+key/i.test(a)),
    );
    expect(keyWarnings).toEqual([]);
  });

  // 2.0dt: the tab picked this identity's drifts in the browser from the tenant's recent drifts
  // of any status, so a corrected drift stayed listed with its Fix button and the Correct looked
  // like a failure. Here the API answers as the backend does: by its userId and status filters.
  it('drops a corrected drift from the list and refreshes every drift list', async () => {
    const store = [apiDrift('6650a1b2c3d4e5f6a7b8c9d0', 'jobTitle', true)];
    get.mockImplementation(async (url: string) => {
      const query = new URL(url, 'http://api').searchParams;
      const drifts = store.filter(
        (d) =>
          (!query.get('userId') || d.userId === query.get('userId')) &&
          (!query.get('status') || d.status === query.get('status')),
      );
      return {
        data: { success: true, drifts, total: drifts.length, page: 1, limit: 50, totalPages: 1 },
      };
    });
    post.mockImplementation(async (url: string) => {
      const drift = store.find((d) => url.includes(`/drifts/${d._id}/correct`));
      if (drift) drift.status = 'corrected';
      return { data: { success: true } };
    });
    // The Reconciliation page's list stands for the other drift queries of the app.
    const dashboardFetch = vi.fn().mockResolvedValue({ drifts: [] });
    function DashboardList() {
      useQuery({
        queryKey: reconciliationKeys.driftsPaginated({ page: 1 }),
        queryFn: dashboardFetch,
      });
      return null;
    }
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <DriftTab identityId={IDENTITY_ID} />
        <DashboardList />
      </>,
    );

    const row = (await screen.findByText('jobTitle')).closest('tr') as HTMLElement;
    await waitFor(() => expect(dashboardFetch).toHaveBeenCalledTimes(1));
    await user.click(within(row).getByRole('button', { name: /Fix/ }));

    expect(await screen.findByText('Identity in sync')).toBeInTheDocument();
    expect(screen.queryByText('jobTitle')).not.toBeInTheDocument();
    await waitFor(() => expect(dashboardFetch).toHaveBeenCalledTimes(2));
  });

  it("shows the API's reason when the correction fails", async () => {
    post.mockRejectedValue({
      response: { data: { message: 'Correction failed: The user was not found in entra-id' } },
    });
    const user = userEvent.setup();
    renderWithProviders(<DriftTab identityId={IDENTITY_ID} />);

    const row = (await screen.findByText('jobTitle')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /Fix/ }));

    expect(
      await screen.findByText('Correction failed: The user was not found in entra-id'),
    ).toBeInTheDocument();
  });
});
