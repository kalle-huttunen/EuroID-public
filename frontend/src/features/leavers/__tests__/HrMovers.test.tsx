import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { HrMovers } from '../HrMovers';
import { LeaversPage } from '../LeaversPage';
import type { IMoverBatch, IMoverPolicy } from '../../../interfaces';

// Dev builds (VITE_AUTH_DISABLED) grant every role; the role tests set it explicitly.
let mockIsPolicyAdmin = true;
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => (role === 'policy-admin' ? mockIsPolicyAdmin : true),
}));

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    put: (...args: unknown[]) => mockPut(...args),
  },
}));

const pendingBatch: IMoverBatch = {
  id: 'mb-1',
  sourceName: 'csv-hr',
  status: 'pending',
  identityCount: 3,
  allowance: 2,
  activeIdentityCount: 40,
  fieldCounts: { departmentName: 3, jobTitle: 1 },
  createdAt: new Date().toISOString(),
  items: [
    {
      itemId: 'i-1',
      identityId: 'id-1',
      displayName: 'Ada Lovelace',
      email: 'ada@corp.example',
      changes: [
        { field: 'departmentName', before: 'Sales', after: 'Engineering' },
        { field: 'jobTitle', before: 'Rep', after: 'Engineer' },
      ],
      status: 'pending-approval',
    },
    {
      itemId: 'i-2',
      identityId: 'id-2',
      displayName: 'Grace Hopper',
      changes: [{ field: 'departmentName', before: 'Sales', after: '' }],
      status: 'pending-approval',
    },
  ],
};

const decidedBatch: IMoverBatch = {
  ...pendingBatch,
  id: 'mb-0',
  status: 'approved',
  decidedBy: 'admin@corp.example',
  decidedAt: '2026-11-20T10:00:00.000Z',
  comment: 'Reorganisation',
  startedCount: 1,
  items: [
    { ...pendingBatch.items[0], status: 'started', workflowId: 'w-1' },
    {
      ...pendingBatch.items[1],
      status: 'superseded',
      closeReason: 'Its access already matches the HR data.',
    },
  ],
};

const policy: IMoverPolicy = {
  massMoverMaxCount: 10,
  massMoverMaxPercent: 5,
  massMoverMinCount: 2,
  configured: false,
};

function serve(batches: IMoverBatch[]) {
  mockGet.mockImplementation((url: string, config?: { params?: { status?: string } }) => {
    if (url.endsWith('/movers/batches')) {
      const status = config?.params?.status;
      return Promise.resolve({
        data: status ? batches.filter((b) => b.status === status) : batches,
      });
    }
    if (url.endsWith('/movers/policy')) return Promise.resolve({ data: policy });
    if (url.endsWith('/leavers/batches') || url.endsWith('/leavers/open-offboardings')) {
      return Promise.resolve({ data: [] });
    }
    return Promise.resolve({ data: {} });
  });
}

describe('HR movers tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPolicyAdmin = true;
    // The approve answer as the backend gives it: approved, the members still pending, their
    // mover runs start right after the answer
    mockPost.mockResolvedValue({
      data: {
        ...pendingBatch,
        identityCount: pendingBatch.items.length,
        status: 'approved',
        decidedBy: 'admin@corp.example',
      },
    });
  });

  it('lists a pending batch with each identity, its HR change and the limit', async () => {
    serve([pendingBatch, decidedBatch]);
    renderWithProviders(<HrMovers />);

    expect(await screen.findAllByText('Ada Lovelace')).not.toHaveLength(0);
    expect(screen.getByText('3 movers from')).toBeInTheDocument();
    expect(screen.getByText('Department changed: 3')).toBeInTheDocument();
    expect(screen.getByText('Job title changed: 1')).toBeInTheDocument();
    expect(
      screen.getByText(/could start at most 2 mover runs \(40 active identities\), so it started/),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Engineering').length).toBeGreaterThan(0);
    expect(screen.getAllByText('(empty)').length).toBeGreaterThan(0);
    expect(mockGet).toHaveBeenCalledWith(expect.stringMatching(/\/movers\/batches$/), {
      params: { status: 'pending' },
    });
  });

  it('approves only after confirming, with the comment', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([pendingBatch]);
    renderWithProviders(<HrMovers />);

    await user.click(await screen.findByRole('button', { name: /Approve and move access/ }));
    expect(mockPost).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/starts the mover workflow for 3 identities/),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Decision comment'), 'Reorg confirmed');
    await user.click(within(dialog).getByRole('button', { name: 'Move access for 3 identities' }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringMatching(/\/movers\/batches\/mb-1\/approve$/),
        { comment: 'Reorg confirmed' },
      ),
    );
  });

  // The approval answers before any start (Temporal down no longer holds it): a start that fails
  // shows in the batch history
  it(
    'says the mover runs are starting: the approval answers before they start',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve([pendingBatch]);
      renderWithProviders(<HrMovers />);

      await user.click(await screen.findByRole('button', { name: /Approve and move access/ }));
      const dialog = await screen.findByRole('dialog');
      await user.click(
        within(dialog).getByRole('button', { name: 'Move access for 3 identities' }),
      );

      const toast = await screen.findByText(
        'Starting 2 mover runs. The batch history shows each one as it starts, or why it does not.',
      );
      expect(toast.closest('.ant-message-success')).not.toBeNull();
    },
  );

  it('rejects after confirming', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([pendingBatch]);
    renderWithProviders(<HrMovers />);

    await user.click(await screen.findByRole('button', { name: /Reject/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reject batch' }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringMatching(/\/movers\/batches\/mb-1\/reject$/),
        {},
      ),
    );
  });

  it('offers no decision and no save to a role below policy-admin', async () => {
    mockIsPolicyAdmin = false;
    serve([pendingBatch]);
    renderWithProviders(<HrMovers />);

    expect(await screen.findAllByText('Ada Lovelace')).not.toHaveLength(0);
    expect(
      screen.queryByRole('button', { name: /Approve and move access/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reject/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save limit/ })).not.toBeInTheDocument();
  });

  it('shows the decided batch and the limit on the defaults', async () => {
    serve([decidedBatch]);
    renderWithProviders(<HrMovers />);

    expect(await screen.findByText('No mover batches waiting')).toBeInTheDocument();
    expect(await screen.findByText('admin@corp.example')).toBeInTheDocument();
    expect(screen.getByText('Reorganisation')).toBeInTheDocument();
    expect(await screen.findByText('Using the defaults')).toBeInTheDocument();
    expect(screen.getByLabelText('Always allowed per sync (floor)')).toHaveValue('2');
  });

  it('saves the limit, refusing a floor above the count', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([]);
    mockPut.mockResolvedValue({ data: { ...policy, configured: true } });
    renderWithProviders(<HrMovers />);

    const floor = await screen.findByLabelText('Always allowed per sync (floor)');
    await user.clear(floor);
    await user.type(floor, '11');
    await user.click(screen.getByRole('button', { name: /Save limit/ }));
    expect(await screen.findByText('May not exceed the identities per sync')).toBeInTheDocument();
    expect(mockPut).not.toHaveBeenCalled();

    await user.clear(floor);
    await user.type(floor, '4');
    await user.click(screen.getByRole('button', { name: /Save limit/ }));
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(expect.stringMatching(/\/movers\/policy$/), {
        massMoverMaxCount: 10,
        massMoverMaxPercent: 5,
        massMoverMinCount: 4,
      }),
    );
  });

  it('is a tab of the Joiners, movers and leavers page, with the pending count', async () => {
    const user = userEvent.setup();
    serve([pendingBatch]);
    renderWithProviders(<LeaversPage />);

    const tab = await screen.findByRole('tab', { name: /HR movers/ });
    await waitFor(() => expect(within(tab).getByTitle('1')).toBeInTheDocument());
    await user.click(tab);
    expect(await screen.findAllByText('Ada Lovelace')).not.toHaveLength(0);
  });
});
