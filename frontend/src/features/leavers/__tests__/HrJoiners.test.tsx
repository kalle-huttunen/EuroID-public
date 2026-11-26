import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { HrJoiners } from '../HrJoiners';
import { LeaversPage } from '../LeaversPage';
import type { IJoinerBatch, IJoinerPolicy } from '../../../interfaces';

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

const pendingBatch: IJoinerBatch = {
  id: 'jb-1',
  sourceName: 'csv-hr',
  status: 'pending',
  identityCount: 3,
  allowance: 2,
  activeIdentityCount: 3,
  createdAt: new Date().toISOString(),
  items: [
    {
      joinerEventId: 'je-1',
      identityId: 'id-1',
      displayName: 'Ada Lovelace',
      email: 'ada@corp.example',
      departmentName: 'Engineering',
      jobTitle: 'Engineer',
      status: 'pending-approval',
    },
    {
      joinerEventId: 'je-2',
      identityId: 'id-2',
      displayName: 'Grace Hopper',
      departmentName: 'Engineering',
      status: 'pending-approval',
    },
    {
      joinerEventId: 'je-3',
      identityId: 'id-3',
      displayName: 'Alan Turing',
      departmentName: 'Sales',
      jobTitle: 'Account Executive',
      status: 'pending-approval',
    },
  ],
};

const decidedBatch: IJoinerBatch = {
  ...pendingBatch,
  id: 'jb-0',
  status: 'approved',
  decidedBy: 'admin@corp.example',
  decidedAt: '2026-11-20T10:00:00.000Z',
  comment: 'First import checked',
  startedCount: 2,
  items: [
    { ...pendingBatch.items[0], status: 'started', workflowId: 'w-1' },
    { ...pendingBatch.items[1], status: 'started', workflowId: 'w-2' },
    {
      ...pendingBatch.items[2],
      status: 'superseded',
      closeReason: 'HR marks the person as left (status "terminated").',
    },
  ],
};

const policy: IJoinerPolicy = {
  massJoinerMaxCount: 10,
  massJoinerMaxPercent: 5,
  massJoinerMinCount: 2,
  configured: false,
};

function serve(batches: IJoinerBatch[]) {
  mockGet.mockImplementation((url: string, config?: { params?: { status?: string } }) => {
    if (url.endsWith('/joiners/batches')) {
      const status = config?.params?.status;
      return Promise.resolve({
        data: status ? batches.filter((b) => b.status === status) : batches,
      });
    }
    if (url.endsWith('/joiners/policy')) return Promise.resolve({ data: policy });
    if (
      url.endsWith('/leavers/batches') ||
      url.endsWith('/leavers/open-offboardings') ||
      url.endsWith('/movers/batches')
    ) {
      return Promise.resolve({ data: [] });
    }
    return Promise.resolve({ data: {} });
  });
}

describe('HR joiners tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPolicyAdmin = true;
    // The approve answer as the backend gives it: approved, the members waiting joiners whose
    // onboardings start right after the answer
    mockPost.mockResolvedValue({
      data: {
        ...pendingBatch,
        status: 'approved',
        decidedBy: 'admin@corp.example',
        items: pendingBatch.items.map((item) => ({ ...item, status: 'waiting' })),
      },
    });
  });

  it('lists a pending batch with each joiner, the departments and the limit', async () => {
    serve([pendingBatch, decidedBatch]);
    renderWithProviders(<HrJoiners />);

    expect(await screen.findAllByText('Ada Lovelace')).not.toHaveLength(0);
    expect(screen.getByText('3 joiners from')).toBeInTheDocument();
    expect(screen.getByText('Engineering: 2')).toBeInTheDocument();
    expect(screen.getByText('Sales: 1')).toBeInTheDocument();
    expect(
      screen.getByText(/could start at most 2 onboarding runs \(3 active identities\), so it/),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Account Executive').length).toBeGreaterThan(0);
    expect(mockGet).toHaveBeenCalledWith(expect.stringMatching(/\/joiners\/batches$/), {
      params: { status: 'pending' },
    });
  });

  it('approves only after confirming, with the comment', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([pendingBatch]);
    renderWithProviders(<HrJoiners />);

    await user.click(await screen.findByRole('button', { name: /Approve and onboard/ }));
    expect(mockPost).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/starts the onboarding workflow for 3 identities/),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Decision comment'), 'First import checked');
    await user.click(within(dialog).getByRole('button', { name: 'Onboard 3 identities' }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringMatching(/\/joiners\/batches\/jb-1\/approve$/),
        { comment: 'First import checked' },
      ),
    );
    expect(
      await screen.findByText(
        'Starting 3 onboarding runs. The batch history shows each one as it starts, or why it does not.',
      ),
    ).toBeInTheDocument();
  });

  it('shows why the backend refused an approval', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([pendingBatch]);
    mockPost.mockRejectedValueOnce({
      response: {
        status: 409,
        data: { message: 'The pipeline is PAUSED: deploy or resume it before approving joiners' },
      },
    });
    renderWithProviders(<HrJoiners />);

    await user.click(await screen.findByRole('button', { name: /Approve and onboard/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Onboard 3 identities' }));

    expect(
      await screen.findByText(
        'The pipeline is PAUSED: deploy or resume it before approving joiners',
      ),
    ).toBeInTheDocument();
  });

  // The approval answers before any start (Temporal down no longer holds it): the toast says the
  // runs are starting, and a start that fails shows in the batch history
  it('says the onboarding runs are starting, as a success', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([pendingBatch]);
    renderWithProviders(<HrJoiners />);

    await user.click(await screen.findByRole('button', { name: /Approve and onboard/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Onboard 3 identities' }));

    const toast = await screen.findByText(/^Starting 3 onboarding runs\./);
    expect(toast.closest('.ant-message-success')).not.toBeNull();
    expect(document.querySelector('.ant-message-warning')).toBeNull();
  });

  it('rejects after confirming', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([pendingBatch]);
    renderWithProviders(<HrJoiners />);

    await user.click(await screen.findByRole('button', { name: /Reject/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/provision them one by one/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Reject batch' }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringMatching(/\/joiners\/batches\/jb-1\/reject$/),
        {},
      ),
    );
  });

  it('offers no decision and no save to a role below policy-admin', async () => {
    mockIsPolicyAdmin = false;
    serve([pendingBatch]);
    renderWithProviders(<HrJoiners />);

    expect(await screen.findAllByText('Ada Lovelace')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Approve and onboard/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reject/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save limit/ })).not.toBeInTheDocument();
  });

  it('shows the decided batch and the limit on the defaults', async () => {
    serve([decidedBatch]);
    renderWithProviders(<HrJoiners />);

    expect(await screen.findByText('No joiner batches waiting')).toBeInTheDocument();
    expect(await screen.findByText('admin@corp.example')).toBeInTheDocument();
    expect(screen.getByText('First import checked')).toBeInTheDocument();
    expect(await screen.findByText('Using the defaults')).toBeInTheDocument();
    expect(screen.getByLabelText('Always allowed per sync (floor)')).toHaveValue('2');
  });

  it('saves the limit, refusing a floor above the count', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([]);
    mockPut.mockResolvedValue({ data: { ...policy, configured: true } });
    renderWithProviders(<HrJoiners />);

    expect(await screen.findByText('Mass-joiner limit')).toBeInTheDocument();
    const floor = await screen.findByLabelText('Always allowed per sync (floor)');
    await user.clear(floor);
    await user.type(floor, '11');
    await user.click(screen.getByRole('button', { name: /Save limit/ }));
    expect(await screen.findByText('May not exceed the identities per sync')).toBeInTheDocument();
    expect(mockPut).not.toHaveBeenCalled();

    await user.clear(floor);
    await user.type(floor, '0');
    await user.click(screen.getByRole('button', { name: /Save limit/ }));
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(expect.stringMatching(/\/joiners\/policy$/), {
        massJoinerMaxCount: 10,
        massJoinerMaxPercent: 5,
        massJoinerMinCount: 0,
      }),
    );
  });

  it('is a tab of the Joiners, movers and leavers page, with the pending count', async () => {
    const user = userEvent.setup();
    serve([pendingBatch]);
    renderWithProviders(<LeaversPage />);

    expect(
      await screen.findByRole('heading', { name: 'Joiners, movers and leavers' }),
    ).toBeInTheDocument();
    const tab = await screen.findByRole('tab', { name: /HR joiners/ });
    await waitFor(() => expect(within(tab).getByTitle('1')).toBeInTheDocument());
    await user.click(tab);
    expect(await screen.findAllByText('Ada Lovelace')).not.toHaveLength(0);
  });
});
