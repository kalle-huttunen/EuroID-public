/**
 * The Policies tab of the credential lifecycle page (policy-admin, like every /policies route):
 * the list, create, edit and delete with their requests, the API's refusal shown in place, the
 * reload after each change, and the form saying that automatic reset is off.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ONE_POLICY,
  POLICIES,
  apiError,
  callsTo,
  dialog,
  mockDelete,
  mockGet,
  mockPatch,
  mockPost,
  renderPage,
  serve,
  servicePolicy,
  standardPolicy,
} from './CredentialLifecyclePage.fixtures';

vi.mock('../../../auth/usePermission', () => ({ usePermission: () => true }));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

/** Opens the select named `name` and clicks the option with this text. */
async function choose(name: string, optionText: string) {
  const box = screen.getByRole('combobox', { name });
  fireEvent.mouseDown(box);
  const option = await waitFor(() => {
    const listId = box.getAttribute('aria-controls');
    const dropdown = listId
      ? document.getElementById(listId)?.closest('.ant-select-dropdown')
      : null;
    const found = Array.from(dropdown?.querySelectorAll('.ant-select-item-option') ?? []).find(
      (o) => o.textContent === optionText,
    );
    if (!found) throw new Error(`no option "${optionText}" in ${name}`);
    return found;
  });
  fireEvent.click(option);
}

async function openPolicies() {
  renderPage('/credentials?tab=policies');
  return screen.findByRole('table', { name: 'Credential policies' });
}

describe('CredentialLifecyclePage policies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serve();
  });

  it('lists each policy with what it applies to, its maximum age, warning and status', async () => {
    const table = await openPolicies();

    const standard = within(table).getByText('Standard').closest('tr') as HTMLElement;
    expect(within(standard).getByText('Everyone else')).toBeInTheDocument();
    expect(within(standard).getByText('Every system')).toBeInTheDocument();
    expect(within(standard).getByText('Every employment type')).toBeInTheDocument();
    expect(within(standard).getByText('90 days')).toBeInTheDocument();
    expect(within(standard).getByText('14 days')).toBeInTheDocument();
    expect(within(standard).getByText('Active')).toBeInTheDocument();

    const service = within(table).getByText('AD service accounts').closest('tr') as HTMLElement;
    expect(within(service).getByText('Active Directory')).toBeInTheDocument();
    expect(within(service).getByText('Service account')).toBeInTheDocument();
    expect(within(service).getByText('365 days')).toBeInTheDocument();
    expect(within(service).getByText('Inactive')).toBeInTheDocument();
  });

  // userEvent types each character: the form's fields take a few seconds in jsdom.
  it(
    'creates a policy with what the nightly check uses, and reloads the list',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      await openPolicies();
      const before = callsTo(POLICIES).length;

      await user.click(screen.getByRole('button', { name: /New policy/ }));
      const form = await dialog('New credential policy');
      // The form promises no reset
      expect(within(form).getByText('Automatic password reset is off')).toBeInTheDocument();
      expect(within(form).queryByRole('switch', { name: /rotat|reset/i })).toBeNull();

      await user.type(within(form).getByLabelText('Name'), 'Contractors');
      await choose('Systems', 'Entra ID');
      await choose('Employment types', 'Contractor');
      const maxAge = within(form).getByLabelText('Maximum password age (days)');
      await user.clear(maxAge);
      await user.type(maxAge, '60');
      const warn = within(form).getByLabelText('Warn before (days)');
      await user.clear(warn);
      await user.type(warn, '7');
      await user.click(within(form).getByRole('button', { name: 'Create policy' }));

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      const [url, body] = mockPost.mock.calls[0];
      expect(url).toMatch(POLICIES);
      expect(body).toEqual({
        name: 'Contractors',
        targetScope: { connectorTypes: ['entra-id'], employmentTypes: ['CONTRACTOR'] },
        passwordPolicy: { maxAgeDays: 60 },
        rotationPolicy: { notifyDaysBefore: 7 },
        isActive: true,
      });
      expect(await screen.findByText('Policy "Contractors" created')).toBeInTheDocument();
      await waitFor(() => expect(callsTo(POLICIES).length).toBeGreaterThan(before));
      await waitFor(() => expect(screen.queryByText('New credential policy')).toBeNull());
    },
  );

  // userEvent types each character: the form's fields take a few seconds in jsdom.
  it('shows the API’s refusal in the form and keeps it open', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValue(
      apiError(409, 'A credential policy named "Standard" already exists. Choose another name.'),
    );
    await openPolicies();

    await user.click(screen.getByRole('button', { name: /New policy/ }));
    const form = await dialog('New credential policy');
    await user.type(within(form).getByLabelText('Name'), 'Standard');
    await user.click(within(form).getByRole('button', { name: 'Create policy' }));

    expect(
      await within(form).findByText(
        'Could not create the policy: A credential policy named "Standard" already exists. Choose another name.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('New credential policy')).toBeInTheDocument();
  });

  // userEvent types each character: the form's fields take a few seconds in jsdom.
  it(
    'saves only what changed, keeping the stored settings the form does not show',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      await openPolicies();

      await user.click(screen.getByRole('button', { name: 'Edit AD service accounts' }));
      const form = await dialog('Edit "AD service accounts"');
      const save = within(form).getByRole('button', { name: 'Save changes' });
      expect(save).toBeDisabled();

      const maxAge = within(form).getByLabelText('Maximum password age (days)');
      await user.clear(maxAge);
      await user.type(maxAge, '180');
      await user.click(within(form).getByRole('switch', { name: 'Active' }));
      await user.click(save);

      await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
      const [url, changes] = mockPatch.mock.calls[0];
      expect(url).toMatch(ONE_POLICY(servicePolicy._id));
      expect(changes).toEqual({
        passwordPolicy: {
          maxAgeDays: 180,
          minLength: 24,
          requireComplexity: true,
          preventReuse: 10,
        },
        isActive: true,
      });
      expect(await screen.findByText('Policy "AD service accounts" saved')).toBeInTheDocument();
    },
  );

  // The stored settings objects carry a nested tenantId (fixtures): the API refuses unknown keys.
  it(
    'sends back only the settings the API accepts when the warning or the systems change',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      await openPolicies();

      await user.click(screen.getByRole('button', { name: 'Edit AD service accounts' }));
      const form = await dialog('Edit "AD service accounts"');
      const warn = within(form).getByLabelText('Warn before (days)');
      await user.clear(warn);
      await user.type(warn, '10');
      await choose('Systems', 'Entra ID');
      await user.click(within(form).getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
      expect(mockPatch.mock.calls[0][1]).toEqual({
        targetScope: {
          connectorTypes: ['ad', 'entra-id'],
          employmentTypes: ['SERVICE_ACCOUNT'],
          entitlementTiers: [],
        },
        rotationPolicy: {
          enabled: false,
          intervalDays: 365,
          notifyDaysBefore: 10,
          vaultStorage: false,
        },
      });
      expect(await screen.findByText('Policy "AD service accounts" saved')).toBeInTheDocument();
    },
  );

  it('deletes a policy after a confirmation and reloads the list', async () => {
    const user = userEvent.setup();
    await openPolicies();
    const before = callsTo(POLICIES).length;

    await user.click(screen.getByRole('button', { name: 'Delete Standard' }));
    const confirm = await dialog('Delete "Standard"?');
    expect(within(confirm).getByText(/deleted for good/)).toBeInTheDocument();
    expect(mockDelete).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1));
    expect(mockDelete.mock.calls[0][0]).toMatch(ONE_POLICY(standardPolicy._id));
    expect(await screen.findByText('Policy "Standard" deleted')).toBeInTheDocument();
    await waitFor(() => expect(callsTo(POLICIES).length).toBeGreaterThan(before));
  });

  it('says why a delete failed', async () => {
    const user = userEvent.setup();
    mockDelete.mockRejectedValue(
      apiError(404, `Credential policy ${standardPolicy._id} not found`),
    );
    await openPolicies();

    await user.click(screen.getByRole('button', { name: 'Delete Standard' }));
    const confirm = await dialog('Delete "Standard"?');
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    expect(
      await screen.findByText(`Delete failed: Credential policy ${standardPolicy._id} not found`),
    ).toBeInTheDocument();
  });

  it('offers the first policy when there is none', async () => {
    serve({ policies: [] });
    renderPage('/credentials?tab=policies');

    expect(await screen.findByText('No credential policies yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create the first policy/ })).toBeInTheDocument();
  });
});
