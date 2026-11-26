/**
 * Segregation-of-duties policy page: the list, the role gating and the actions on a policy. Actions
 * mirror the controller's guards: list for every role, create, edit, turn on or off and delete for
 * policy-admin and super-admin. Creating a policy is in SodPoliciesPage.form.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  blockPolicy,
  dialog,
  inactiveWarnPolicy,
  listCalls,
  mockDelete,
  mockGet,
  mockPatch,
  mockPost,
  ONE,
  renderPage,
  serve,
} from './SodPoliciesPage.fixtures';

let mockIsPolicyAdmin = true;
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => (role === 'policy-admin' ? mockIsPolicyAdmin : true),
}));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

describe('SodPoliciesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPolicyAdmin = true;
  });

  it('lists each policy with its entitlements by catalog name, action, severity and status', async () => {
    serve([blockPolicy, inactiveWarnPolicy]);
    renderPage();

    const row = (await screen.findByText('Vendor create vs pay')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Who creates vendors must not pay them')).toBeInTheDocument();
    // Both sides by their catalog names, with the system and kind they are matched on.
    expect(await within(row).findByText('Vendor Create')).toBeInTheDocument();
    expect(within(row).getByText('Microsoft Entra ID group')).toBeInTheDocument();
    expect(await within(row).findByText('Payment Approvers')).toBeInTheDocument();
    expect(within(row).getByText('Active Directory group')).toBeInTheDocument();
    expect(within(row).getByText('Block')).toBeInTheDocument();
    expect(within(row).getByText('Critical')).toBeInTheDocument();
    expect(within(row).getByRole('switch', { name: 'Active: Vendor create vs pay' })).toBeChecked();

    const other = screen.getByText('Payments vs GitHub release').closest('tr') as HTMLElement;
    expect(within(other).getByText('Warn')).toBeInTheDocument();
    expect(within(other).getByText('Low')).toBeInTheDocument();
    // An entitlement the catalog does not hold keeps its raw id, said so.
    expect(within(other).getByText('release-managers')).toBeInTheDocument();
    expect(
      within(other).getByText(/GitHub team, not in the entitlement catalog/),
    ).toBeInTheDocument();
    expect(
      within(other).getByRole('switch', { name: 'Active: Payments vs GitHub release' }),
    ).not.toBeChecked();

    // No violation count: the API has none.
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Policy',
      'Conflicting entitlements (all at once)',
      'Action',
      'Severity',
      'Status',
      '',
    ]);
  });

  it('filters active and inactive policies', { timeout: 20_000 }, async () => {
    serve([blockPolicy, inactiveWarnPolicy]);
    renderPage();
    await screen.findByText('Vendor create vs pay');

    fireEvent.click(screen.getByText('Inactive (1)'));
    expect(screen.queryByText('Vendor create vs pay')).not.toBeInTheDocument();
    expect(screen.getByText('Payments vs GitHub release')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Active (1)'));
    expect(screen.getByText('Vendor create vs pay')).toBeInTheDocument();
    expect(screen.queryByText('Payments vs GitHub release')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('All (2)'));
    expect(screen.getByText('Payments vs GitHub release')).toBeInTheDocument();
  });

  it('shows a viewer the list read-only', async () => {
    mockIsPolicyAdmin = false;
    serve([blockPolicy, inactiveWarnPolicy]);
    renderPage();

    const row = (await screen.findByText('Vendor create vs pay')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Active')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New policy/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(5);
    expect(
      screen.getByText('Creating and changing policies needs the policy-admin role.'),
    ).toBeInTheDocument();
  });

  it('says where the policies act, as the backend enforces them', async () => {
    serve([blockPolicy]);
    renderPage();
    await screen.findByText('Vendor create vs pay');

    fireEvent.click(screen.getByText('Where these policies act'));
    const panel = await screen.findByRole('region', { name: 'Where these policies act' });
    expect(
      within(panel).getByText(/access from their earlier requests that is still in force/),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(/checked again against what the person holds/),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/the rest of the run goes on/)).toBeInTheDocument();
    expect(within(panel).queryByText(/linked admin account instead/)).not.toBeInTheDocument();
    expect(within(panel).getByText(/request goes ahead/)).toBeInTheDocument();
    expect(within(panel).getByText(/does not change what is blocked/)).toBeInTheDocument();
    expect(within(panel).getByText(/no count of current violations/)).toBeInTheDocument();
  });

  it(
    'edits only what the API can change and sends only the changed field',
    { timeout: 60_000 },
    async () => {
      const user = userEvent.setup();
      serve([blockPolicy]);
      renderPage();
      await screen.findByText('Vendor create vs pay');
      const before = listCalls();

      await user.click(screen.getByRole('button', { name: 'Edit Vendor create vs pay' }));
      const modal = await dialog('Edit "Vendor create vs pay"');
      expect(
        within(modal).getByText(/The API changes only the action and the severity/),
      ).toBeInTheDocument();
      expect(within(modal).queryByLabelText('Name')).not.toBeInTheDocument();
      expect(await within(modal).findByText('Vendor Create')).toBeInTheDocument();
      const save = within(modal).getByRole('button', { name: 'Save changes' });
      expect(save).toBeDisabled();

      await user.click(within(modal).getByRole('radio', { name: /^Warn/ }));
      await user.click(save);

      await waitFor(() =>
        expect(mockPatch).toHaveBeenCalledWith(expect.stringMatching(ONE(blockPolicy.id)), {
          action: 'WARN',
        }),
      );
      expect(await screen.findByText('Policy "Vendor create vs pay" saved')).toBeInTheDocument();
      await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    },
  );

  it('turns a policy off only after confirming, then reloads', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([blockPolicy]);
    renderPage();
    await screen.findByText('Vendor create vs pay');
    const before = listCalls();

    await user.click(screen.getByRole('switch', { name: 'Active: Vendor create vs pay' }));
    let confirm = await dialog('Turn off "Vendor create vs pay"?');
    expect(within(confirm).getByText(/no longer checked against it/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(mockPatch).not.toHaveBeenCalled();

    await user.click(screen.getByRole('switch', { name: 'Active: Vendor create vs pay' }));
    confirm = await dialog('Turn off "Vendor create vs pay"?');
    await user.click(within(confirm).getByRole('button', { name: 'Turn off' }));

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(expect.stringMatching(ONE(blockPolicy.id)), {
        isActive: false,
      }),
    );
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
  });

  it('says what turning a Block policy on will stop', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([{ ...blockPolicy, isActive: false }]);
    renderPage();
    await screen.findByText('Vendor create vs pay');

    await user.click(screen.getByRole('switch', { name: 'Active: Vendor create vs pay' }));
    const confirm = await dialog('Turn on "Vendor create vs pay"?');
    expect(within(confirm).getByText(/refuses access requests/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(expect.stringMatching(ONE(blockPolicy.id)), {
        isActive: true,
      }),
    );
  });

  it(
    'deletes after a confirmation that says delete only deactivates, then reloads',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve([blockPolicy, inactiveWarnPolicy]);
      renderPage();
      await screen.findByText('Vendor create vs pay');
      const before = listCalls();

      // Already inactive: delete would change nothing.
      expect(
        screen.getByRole('button', { name: 'Delete Payments vs GitHub release' }),
      ).toBeDisabled();

      await user.click(screen.getByRole('button', { name: 'Delete Vendor create vs pay' }));
      const confirm = await dialog('Delete "Vendor create vs pay"?');
      expect(within(confirm).getByText(/no permanent delete/)).toBeInTheDocument();
      expect(within(confirm).getByText(/stays in this list as inactive/)).toBeInTheDocument();
      await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

      await waitFor(() =>
        expect(mockDelete).toHaveBeenCalledWith(expect.stringMatching(ONE(blockPolicy.id))),
      );
      expect(
        await screen.findByText(
          'Policy "Vendor create vs pay" deleted. It stays in the list as inactive.',
        ),
      ).toBeInTheDocument();
      await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    },
  );

  it('shows the API message when a delete fails', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([blockPolicy]);
    mockDelete.mockRejectedValue({
      response: { status: 404, data: { message: `SoD policy ${blockPolicy.id} not found` } },
    });
    renderPage();
    await screen.findByText('Vendor create vs pay');

    await user.click(screen.getByRole('button', { name: 'Delete Vendor create vs pay' }));
    const confirm = await dialog('Delete "Vendor create vs pay"?');
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    expect(
      await screen.findByText(`Delete failed: SoD policy ${blockPolicy.id} not found`),
    ).toBeInTheDocument();
  });

  it('offers a policy-admin the first policy when there is none', async () => {
    serve([]);
    renderPage();
    expect(await screen.findByText('No SoD policies yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create the first policy/ })).toBeInTheDocument();
  });

  it('shows a viewer the empty list without an action', async () => {
    mockIsPolicyAdmin = false;
    serve([]);
    renderPage();
    expect(await screen.findByText('No SoD policies yet')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Create the first policy/ }),
    ).not.toBeInTheDocument();
  });

  it('shows an error with a retry when the list cannot be loaded', async () => {
    mockGet.mockRejectedValue({ response: { status: 500, data: { message: 'boom' } } });
    renderPage();
    expect(await screen.findByText('Could not load the SoD policies')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });
});
