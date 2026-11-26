/**
 * r2-08 N6: the Create Tenant dialog asked for Max Identities, and the request (and the API's
 * create) dropped it: the value typed was silently lost.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { TenantManagement } from '../TenantManagement';

const mockGet = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: { get: (...args: unknown[]) => mockGet(...args), post: vi.fn(), patch: vi.fn() },
}));

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue({ data: [] });
});

describe('TenantManagement create', () => {
  it('asks only for what a create stores', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TenantManagement />);

    await user.click(await screen.findByRole('button', { name: /Create tenant/ }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByLabelText('Tenant ID')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/Max Identities/)).toBeNull();
  });
});
