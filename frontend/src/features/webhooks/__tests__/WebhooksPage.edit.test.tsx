import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { WebhooksPage } from '../WebhooksPage';
import { WebhookFormModal } from '../WebhookFormModal';
import {
  expectListReloaded,
  fill,
  formModal,
  listLoads,
  mockDelete,
  mockGet,
  mockPatch,
  mockPost,
  paused,
  pickEventType,
  serve,
  sub,
  SUB_ID,
} from './WebhooksPage.fixtures';

// Dev builds (VITE_AUTH_DISABLED) grant every role.
vi.mock('../../../auth/usePermission', () => ({ usePermission: () => true }));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

describe('WebhooksPage: edit a subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The edit modal alone, as the page opens it for `subscription` (no list to render). The first
   * test opens it from the row and checks that the list reloads after a save.
   */
  async function openEdit(subscription = sub) {
    const user = userEvent.setup();
    serve([subscription]);
    renderWithProviders(
      <WebhookFormModal
        open
        subscription={subscription}
        namesInUse={[subscription.name]}
        onClose={vi.fn()}
      />,
    );
    return { user, modal: await formModal(`Edit ${subscription.name}`) };
  }

  it(
    'edits a subscription without touching its secret and sends only what changed',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      serve([sub]);
      renderWithProviders(<WebhooksPage />);
      await screen.findByText('SIEM feed');

      await user.click(screen.getByRole('button', { name: 'Edit SIEM feed' }));
      const modal = await formModal('Edit SIEM feed');
      expect(screen.getByLabelText('Name')).toHaveValue('SIEM feed');
      // Header values are write-only like the secret: the API answers names only.
      expect(screen.getByLabelText('Header 1 name')).toHaveValue('X-Team');
      expect(screen.getByLabelText('Header 1 value')).toHaveValue('');
      expect(screen.getByLabelText('Header 1 value')).toHaveAttribute('placeholder', 'Unchanged');
      // Write-only: the field starts empty and an empty field keeps the stored secret.
      expect(screen.getByLabelText(/New signing secret/)).toHaveValue('');
      expect(within(modal).getByText(/Leave empty to keep the current secret/)).toBeInTheDocument();

      await user.clear(screen.getByLabelText('Endpoint URL'));
      await fill(user, 'Endpoint URL', 'https://siem.example.com/hooks/euroid-v2');
      const before = listLoads();
      await user.click(within(modal).getByRole('button', { name: 'Save changes' }));

      await waitFor(() =>
        expect(mockPatch).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`/event-subscriptions/${SUB_ID}$`)),
          { webhook: { url: 'https://siem.example.com/hooks/euroid-v2' } },
        ),
      );
      await expectListReloaded(before);
    },
  );

  // 2.0dx: the API answers header names only, so an edit names every header it keeps and sends
  // null for a stored value it never saw.
  it(
    'edits custom headers: keeps a stored value unseen, drops one, adds one',
    { timeout: 30_000 },
    async () => {
      const { user, modal } = await openEdit({
        ...sub,
        webhook: { ...sub.webhook, headerNames: ['X-Team', 'Authorization'] },
      });
      expect(screen.getByLabelText('Header 2 name')).toHaveValue('Authorization');
      await user.click(screen.getByRole('button', { name: 'Remove header 2' }));
      await user.click(within(modal).getByRole('button', { name: /Add header/ }));
      await fill(user, 'Header 2 name', 'X-Env');
      await fill(user, 'Header 2 value', 'prod');
      await user.click(within(modal).getByRole('button', { name: 'Save changes' }));

      await waitFor(() =>
        expect(mockPatch).toHaveBeenCalledWith(expect.any(String), {
          webhook: { headers: { 'X-Team': null, 'X-Env': 'prod' } },
        }),
      );
    },
  );

  it('replaces a stored header value with a new one', { timeout: 30_000 }, async () => {
    const { user, modal } = await openEdit();
    await fill(user, 'Header 1 value', 'red-team');
    await user.click(within(modal).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(expect.any(String), {
        webhook: { headers: { 'X-Team': 'red-team' } },
      }),
    );
  });

  it('asks for a value when a stored header is renamed', { timeout: 30_000 }, async () => {
    const { user, modal } = await openEdit();
    await user.clear(screen.getByLabelText('Header 1 name'));
    await fill(user, 'Header 1 name', 'X-Squad');
    await user.click(within(modal).getByRole('button', { name: 'Save changes' }));

    expect(await within(modal).findByText('Header value')).toBeInTheDocument();
    expect(screen.getByLabelText('Header 1 value')).toHaveAttribute('placeholder', 'Value');
    expect(mockPatch).not.toHaveBeenCalled();
  });

  /**
   * Browser check of 2.0dx: after a create with a generated secret, Edit on a row opened with that
   * secret in "New signing secret" (the create's form state was kept), so Save would have rotated
   * the subscription's secret.
   */
  async function createThenEdit(finishCreate: 'Create subscription' | 'Cancel') {
    const user = userEvent.setup();
    serve([paused]);
    renderWithProviders(<WebhooksPage />);
    await screen.findByText('Ticketing');

    await user.click(screen.getByRole('button', { name: /New subscription/ }));
    const create = await formModal('New webhook subscription');
    await fill(user, 'Name', 'SIEM feed');
    await fill(user, 'Endpoint URL', 'https://siem.example.com/hooks/euroid');
    await pickEventType(user, 'identity.created');
    await user.click(within(create).getByRole('button', { name: /Generate a secret/ }));
    expect(screen.getByLabelText('Signing secret')).not.toHaveValue('');
    await user.click(within(create).getByRole('button', { name: finishCreate }));
    if (finishCreate === 'Create subscription') {
      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    }

    await user.click(await screen.findByRole('button', { name: 'Edit Ticketing' }));
    const edit = await formModal('Edit Ticketing');
    expect(screen.getByLabelText(/New signing secret/)).toHaveValue('');
    expect(screen.getByLabelText('Name')).toHaveValue('Ticketing');
    expect(screen.getByLabelText('Endpoint URL')).toHaveValue('https://tickets.example.com/in');
    await user.clear(screen.getByLabelText('Endpoint URL'));
    await fill(user, 'Endpoint URL', 'https://tickets.example.com/in-v2');
    await user.click(within(edit).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(
        expect.stringMatching(/\/event-subscriptions\/64b7f0c2a1b2c3d4e5f60731$/),
        { webhook: { url: 'https://tickets.example.com/in-v2' } },
      ),
    );
  }

  it('opens Edit with its own values and an empty secret after a create', { timeout: 40_000 }, () =>
    createThenEdit('Create subscription'),
  );

  it(
    'opens Edit with its own values and an empty secret after a cancelled create',
    { timeout: 40_000 },
    () => createThenEdit('Cancel'),
  );

  it('sends a new signing secret only when one is entered', { timeout: 30_000 }, async () => {
    const { user, modal } = await openEdit();
    await fill(user, /New signing secret/, 'rotated-secret-0123456789');
    await user.click(within(modal).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(expect.any(String), {
        webhook: { signingSecret: 'rotated-secret-0123456789' },
      }),
    );
  });
});
