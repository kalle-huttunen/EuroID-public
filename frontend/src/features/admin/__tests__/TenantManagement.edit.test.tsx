/**
 * Max Identities is enforced since HX-A2 (a create past it answers 409): the edit field says so,
 * and clearing it removes the limit (null), where the form used to leave the key out of the PATCH
 * so the stored limit stayed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { TenantManagement } from '../TenantManagement';

const mockGet = vi.fn();
const mockPatch = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: vi.fn(),
    patch: (...args: unknown[]) => mockPatch(...args),
  },
}));

const tenant = {
  tenantId: 'acme',
  name: 'Acme',
  status: 'active',
  settings: { maxIdentities: 500, mfaRequired: true },
};

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue({ data: [tenant] });
  mockPatch.mockReset().mockResolvedValue({ data: tenant });
});

async function openEdit() {
  const user = userEvent.setup();
  renderWithProviders(<TenantManagement />);
  await user.click(await screen.findByRole('button', { name: /Edit/ }));
  return { user, dialog: await screen.findByRole('dialog') };
}

describe('TenantManagement edit: Max Identities', () => {
  it('says the limit is enforced on creates', async () => {
    const { dialog } = await openEdit();

    expect(within(dialog).getByText(/no identity is created past it/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/does not enforce/i)).toBeNull();
  });

  it('removes the limit when the field is cleared', { timeout: 30_000 }, async () => {
    const { user, dialog } = await openEdit();

    await user.clear(within(dialog).getByLabelText('Max Identities'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    const [, body] = mockPatch.mock.calls[0];
    expect(body.settings).toMatchObject({ maxIdentities: null, mfaRequired: true });
  });
});
