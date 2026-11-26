import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { LeaverPolicyForm } from '../LeaverPolicyForm';
import type { ILeaverPolicy } from '../../../interfaces';

const mockGet = vi.fn();
const mockPut = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
    post: vi.fn(),
  },
}));

const defaults: ILeaverPolicy = {
  configured: false,
  signals: { terminated: true, endDate: true, missingFromSource: true },
  terminatedStatuses: ['terminated', 'inactive', 'left'],
  missingSyncThreshold: 3,
  massLeaverMaxCount: 10,
  massLeaverMaxPercent: 5,
  massLeaverMinCount: 2,
  timezone: 'UTC',
};

describe('LeaverPolicyForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: defaults });
    mockPut.mockImplementation((_url: string, body: object) =>
      Promise.resolve({ data: { ...body, configured: true, updatedBy: 'admin@corp.example' } }),
    );
  });

  it('shows the defaults a tenant runs on until it saves a policy', async () => {
    renderWithProviders(<LeaverPolicyForm />);

    expect(await screen.findByText('Using the defaults')).toBeInTheDocument();
    expect(screen.getByLabelText('Missing for consecutive full syncs')).toHaveValue('3');
    expect(screen.getByLabelText('Identities per sync')).toHaveValue('10');
    expect(screen.getByLabelText('Percent of active identities')).toHaveValue('5');
    expect(screen.getByLabelText('Always allowed per sync (floor)')).toHaveValue('2');
    for (const word of ['terminated', 'inactive', 'left']) {
      expect(screen.getByText(word)).toBeInTheDocument();
    }
    expect(
      screen.getByRole('switch', { name: 'Person is missing from the HR feed' }),
    ).toBeChecked();
  });

  it('saves the whole policy with the changed values', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeaverPolicyForm />);

    const threshold = await screen.findByLabelText('Missing for consecutive full syncs');
    await user.clear(threshold);
    await user.type(threshold, '5');
    const count = screen.getByLabelText('Identities per sync');
    await user.clear(count);
    await user.type(count, '25');
    const floor = screen.getByLabelText('Always allowed per sync (floor)');
    await user.clear(floor);
    await user.type(floor, '3');
    await user.click(screen.getByRole('switch', { name: 'Employment end date has passed' }));
    await user.click(screen.getByRole('button', { name: /Save policy/ }));

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut).toHaveBeenCalledWith(expect.stringMatching(/\/leavers\/policy$/), {
      signals: { terminated: true, endDate: false, missingFromSource: true },
      terminatedStatuses: ['terminated', 'inactive', 'left'],
      missingSyncThreshold: 5,
      massLeaverMaxCount: 25,
      massLeaverMaxPercent: 5,
      massLeaverMinCount: 3,
      timezone: 'UTC',
    });
    expect(await screen.findByText(/by admin@corp.example/)).toBeInTheDocument();
  }, 20_000);

  it('does not save a floor above the identities per sync', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeaverPolicyForm />);

    const floor = await screen.findByLabelText('Always allowed per sync (floor)');
    await user.clear(floor);
    await user.type(floor, '11');
    await user.click(screen.getByRole('button', { name: /Save policy/ }));

    expect(await screen.findByText('May not exceed the identities per sync')).toBeInTheDocument();
    expect(mockPut).not.toHaveBeenCalled();
  }, 20_000);

  it('does not save an empty miss threshold', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeaverPolicyForm />);

    await user.clear(await screen.findByLabelText('Missing for consecutive full syncs'));
    await user.click(screen.getByRole('button', { name: /Save policy/ }));

    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(mockPut).not.toHaveBeenCalled();
  }, 20_000);

  // 09 F8: an axios error is an Error, so the toast showed "Request failed with status code 400"
  // instead of the API's reason.
  it("shows the API's reason when the save is refused", async () => {
    mockPut.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), {
        response: {
          status: 400,
          data: { message: 'massLeaverMinCount must not exceed massLeaverMaxCount' },
        },
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<LeaverPolicyForm />);

    await screen.findByLabelText('Missing for consecutive full syncs');
    await user.click(screen.getByRole('button', { name: /Save policy/ }));

    expect(
      await screen.findByText('massLeaverMinCount must not exceed massLeaverMaxCount'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/status code 400/)).toBeNull();
  }, 20_000);
});
