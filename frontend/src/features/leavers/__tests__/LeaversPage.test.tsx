import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { LeaversPage } from '../LeaversPage';
import type { ILeaverBatch } from '../../../interfaces';

// Dev builds (VITE_AUTH_DISABLED) grant every role; the role tests set it explicitly.
let mockIsPolicyAdmin = true;
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => (role === 'policy-admin' ? mockIsPolicyAdmin : true),
}));

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    put: vi.fn(),
  },
}));

const pendingBatch: ILeaverBatch = {
  id: 'batch-1',
  sourceName: 'csv-hr',
  status: 'pending',
  identityCount: 2,
  allowance: 1,
  activeIdentityCount: 30,
  reasonCounts: { 'missing-from-source': 1, terminated: 1 },
  createdAt: new Date().toISOString(),
  items: [
    {
      leaverEventId: 'le-1',
      identityId: 'id-1',
      displayName: 'Ada Lovelace',
      email: 'ada@corp.example',
      reason: 'missing-from-source',
      effectiveDate: '2026-11-01T00:00:00.000Z',
      status: 'pending-approval',
    },
    {
      leaverEventId: 'le-2',
      identityId: 'id-2',
      displayName: 'Grace Hopper',
      reason: 'terminated',
      status: 'pending-approval',
    },
  ],
};

const decidedBatch: ILeaverBatch = {
  ...pendingBatch,
  id: 'batch-0',
  status: 'rejected',
  decidedBy: 'admin@corp.example',
  decidedAt: '2026-11-20T10:00:00.000Z',
  comment: 'Broken export',
  items: pendingBatch.items.map((i) => ({ ...i, status: 'rejected' as const })),
};

/**
 * The approve answer as the backend gives it: the batch approved and its members queued, before
 * any offboarding starts (they start right after the answer); `closed` members were back in the
 * feed at approval.
 */
const approvedAnswer = (closed: string[] = []): ILeaverBatch => ({
  ...pendingBatch,
  status: 'approved',
  decidedBy: 'admin@corp.example',
  items: pendingBatch.items.map((i) =>
    closed.includes(i.identityId)
      ? {
          ...i,
          status: 'superseded' as const,
          closeReason: 'Back in the HR feed when the batch was approved',
        }
      : { ...i, status: 'queued' as const },
  ),
});

function serve(batches: ILeaverBatch[]) {
  mockGet.mockImplementation((url: string, config?: { params?: { status?: string } }) => {
    if (url.endsWith('/leavers/batches')) {
      const status = config?.params?.status;
      return Promise.resolve({
        data: status ? batches.filter((b) => b.status === status) : batches,
      });
    }
    return Promise.resolve({ data: {} });
  });
}

describe('LeaversPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPolicyAdmin = true;
    mockPost.mockResolvedValue({ data: approvedAnswer() });
  });

  it('lists a pending batch with each identity, its reason and the limit it exceeded', async () => {
    serve([pendingBatch, decidedBatch]);
    renderWithProviders(<LeaversPage />);

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByText('ada@corp.example')).toBeInTheDocument();
    expect(screen.getByText('Missing from feed: 1')).toBeInTheDocument();
    expect(screen.getByText('Terminated in HR: 1')).toBeInTheDocument();
    expect(
      screen.getByText(/could start at most 1 offboarding \(30 active identities\), so it started/),
    ).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith(expect.stringMatching(/\/leavers\/batches$/), {
      params: { status: 'pending' },
    });
  });

  it('approves only after confirming, with the comment', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([pendingBatch]);
    renderWithProviders(<LeaversPage />);

    await user.click(await screen.findByRole('button', { name: /Approve and offboard/ }));
    expect(mockPost).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/starts the offboarding workflow for 2 identities/),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Decision comment'), 'HR confirmed');
    await user.click(within(dialog).getByRole('button', { name: 'Offboard 2 identities' }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringMatching(/\/leavers\/batches\/batch-1\/approve$/),
        { comment: 'HR confirmed' },
      ),
    );
  });

  it(
    'says the offboardings are starting: the approval answers before they start',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve([pendingBatch]);
      renderWithProviders(<LeaversPage />);

      await user.click(await screen.findByRole('button', { name: /Approve and offboard/ }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Offboard 2 identities' }));

      const toast = await screen.findByText(
        'Starting 2 offboardings. The batch history shows each one as it starts, or why it does not.',
      );
      expect(toast.closest('.ant-message-success')).not.toBeNull();
    },
  );

  it(
    'warns with the reason when a member was not started at approval',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve([pendingBatch]);
      mockPost.mockResolvedValueOnce({ data: approvedAnswer(['id-1']) });
      renderWithProviders(<LeaversPage />);

      await user.click(await screen.findByRole('button', { name: /Approve and offboard/ }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Offboard 2 identities' }));

      const toast = await screen.findByText(
        'Starting 1 of 2 offboardings. Not started: 1. Reason: Back in the HR feed when the ' +
          'batch was approved. The batch history shows each one.',
      );
      expect(toast.closest('.ant-message-warning')).not.toBeNull();
    },
  );

  it('rejects after confirming; cancelling sends nothing', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([pendingBatch]);
    renderWithProviders(<LeaversPage />);

    await user.click(await screen.findByRole('button', { name: /Reject/ }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /Cancel/ }),
    );
    expect(mockPost).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Reject/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reject batch' }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringMatching(/\/leavers\/batches\/batch-1\/reject$/),
        {},
      ),
    );
  });

  it('offers no decision to a role below policy-admin', async () => {
    mockIsPolicyAdmin = false;
    serve([pendingBatch]);
    renderWithProviders(<LeaversPage />);

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve and offboard/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reject/ })).not.toBeInTheDocument();
  });

  it('says so when nothing waits', async () => {
    serve([]);
    renderWithProviders(<LeaversPage />);
    expect(await screen.findByText('No leaver batches waiting')).toBeInTheDocument();
  });

  it('shows decided batches with the decision, actor and comment', async () => {
    const user = userEvent.setup();
    serve([decidedBatch]);
    renderWithProviders(<LeaversPage />);

    await user.click(await screen.findByRole('tab', { name: 'Decided' }));
    expect(await screen.findByText('admin@corp.example')).toBeInTheDocument();
    expect(screen.getByText('Broken export')).toBeInTheDocument();
    expect(screen.getAllByText('Rejected').length).toBeGreaterThan(0);
  });

  it('fits decided batches to the page width instead of growing with the comment', async () => {
    // 2.0co: the table was sized to its content, so at 1440 px it scrolled sideways.
    const user = userEvent.setup();
    serve([decidedBatch]);
    renderWithProviders(<LeaversPage />);

    await user.click(await screen.findByRole('tab', { name: 'Decided' }));
    const table = (await screen.findByText('admin@corp.example')).closest('table')!;
    expect(table.style.tableLayout).toBe('fixed');
    expect(table.style.width).not.toBe('max-content');

    await user.hover(screen.getByText('Broken export'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Broken export');
  });

  it('lists every offboarding that left a target failed, leaver or deleted user', async () => {
    const user = userEvent.setup();
    serve([]);
    const fallback = mockGet.getMockImplementation()!;
    const failedGithub = {
      status: 'partial-failure',
      hubStatus: 'suspended',
      finishedAt: '2026-11-22T10:00:00.000Z',
      systems: [{ system: 'github', outcome: 'failed', reason: 'accepted invite' }],
    };
    mockGet.mockImplementation((url: string, config?: unknown) =>
      url.endsWith('/leavers/open-offboardings')
        ? Promise.resolve({
            data: [
              {
                workflowId: 't-tenant-a-offboard-id-9',
                identityId: 'id-9',
                displayName: 'Linus Torvalds',
                leaver: { leaverEventId: 'le-9', sourceName: 'csv-hr', reason: 'end-date' },
                offboarding: failedGithub,
              },
              {
                workflowId: 't-tenant-a-offboard-id-7',
                identityId: 'id-7',
                displayName: 'Margaret Hamilton',
                email: 'margaret@corp.example',
                offboarding: { ...failedGithub, systems: [{ system: 'okta', outcome: 'failed' }] },
              },
            ],
          })
        : fallback(url, config),
    );
    renderWithProviders(<LeaversPage />);

    await user.click(await screen.findByRole('tab', { name: /Failed offboardings/ }));
    expect(await screen.findByText('Linus Torvalds')).toBeInTheDocument();
    expect(screen.getByText('End date passed')).toBeInTheDocument();
    expect(screen.getByText('github: Failed')).toBeInTheDocument();
    const manual = screen.getByText('Margaret Hamilton').closest('tr') as HTMLElement;
    expect(within(manual).getByText('User deleted')).toBeInTheDocument();
    expect(within(manual).getByText('okta: Failed')).toBeInTheDocument();
  });

  it(
    'closes a failed target of a deleted user by its offboarding',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve([]);
      const fallback = mockGet.getMockImplementation()!;
      mockGet.mockImplementation((url: string, config?: unknown) =>
        url.endsWith('/leavers/open-offboardings')
          ? Promise.resolve({
              data: [
                {
                  workflowId: 't-tenant-a-offboard-id-7',
                  identityId: 'id-7',
                  displayName: 'Margaret Hamilton',
                  offboarding: {
                    status: 'partial-failure',
                    hubStatus: 'suspended',
                    finishedAt: '2026-11-22T10:00:00.000Z',
                    systems: [{ system: 'okta', outcome: 'failed', reason: 'rate limited' }],
                  },
                },
              ],
            })
          : fallback(url, config),
      );
      renderWithProviders(<LeaversPage />);

      await user.click(await screen.findByRole('tab', { name: /Failed offboardings/ }));
      await user.click(await screen.findByRole('button', { name: 'Mark okta removed manually' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/last failed target/)).toBeInTheDocument();
      await user.type(within(dialog).getByLabelText('Removal note'), 'Deactivated in Okta');
      await user.click(within(dialog).getByRole('button', { name: 'Record as removed manually' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          '/api/v1/leavers/offboardings/t-tenant-a-offboard-id-7/removed-manually',
          { system: 'okta', reason: 'Deactivated in Okta' },
        ),
      );
    },
  );
});
