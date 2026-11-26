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

describe('WebhooksPage: create a subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const onClose = vi.fn();

  /**
   * The create modal alone, as the page opens it with the names in use (no list to render). The
   * first test opens it from the page and checks that the list reloads after a create.
   */
  async function openCreate(namesInUse: string[] = []) {
    const user = userEvent.setup();
    renderWithProviders(
      <WebhookFormModal open subscription={null} namesInUse={namesInUse} onClose={onClose} />,
    );
    return { user, modal: await formModal('New webhook subscription') };
  }

  it(
    'creates a subscription with a generated secret and reloads the list',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      serve([paused]);
      renderWithProviders(<WebhooksPage />);
      await screen.findByText('Ticketing');

      await user.click(screen.getByRole('button', { name: /New subscription/ }));
      const modal = await formModal('New webhook subscription');
      expect(within(modal).getByText(/Write-only: EuroID keeps it encrypted/)).toBeInTheDocument();
      await fill(user, 'Name', 'SIEM feed');
      await fill(user, 'Endpoint URL', 'https://siem.example.com/hooks/euroid');
      await pickEventType(user, 'identity.created');
      await user.click(within(modal).getByRole('button', { name: /Generate a secret/ }));
      const secret = (screen.getByLabelText('Signing secret') as HTMLInputElement).value;
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // Shown once, while it can still be copied.
      expect(screen.getByLabelText('Signing secret')).toHaveAttribute('type', 'text');

      const before = listLoads();
      await user.click(within(modal).getByRole('button', { name: 'Create subscription' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(expect.stringMatching(/\/event-subscriptions$/), {
          name: 'SIEM feed',
          filters: { eventTypes: ['identity.created'] },
          webhook: {
            url: 'https://siem.example.com/hooks/euroid',
            headers: {},
            signingSecret: secret,
          },
        }),
      );
      await expectListReloaded(before);
      expect(await screen.findByText('Subscription "SIEM feed" created.')).toBeInTheDocument();
    },
  );

  it(
    'refuses an http URL, a short secret and a name in use before asking the API',
    { timeout: 30_000 },
    async () => {
      serve([sub]);
      const { user, modal } = await openCreate([sub.name]);
      await fill(user, 'Name', 'SIEM feed');
      await fill(user, 'Endpoint URL', 'http://siem.example.com/hook');
      await pickEventType(user, 'drift.detected');
      await fill(user, 'Signing secret', 'too-short');
      await user.click(within(modal).getByRole('button', { name: 'Create subscription' }));

      // Creating with a name in use would answer the existing subscription unchanged.
      expect(
        await within(modal).findByText('Another subscription has this name.'),
      ).toBeInTheDocument();
      expect(within(modal).getByText('The URL must start with https://.')).toBeInTheDocument();
      expect(within(modal).getByText('16 to 256 characters.')).toBeInTheDocument();
      expect(mockPost).not.toHaveBeenCalled();
    },
  );

  it(
    'keeps the form open with the API message when the backend refuses the URL',
    { timeout: 30_000 },
    async () => {
      serve([]);
      const refusal =
        'Webhook URL refused: it must use https, and its host must not be or resolve to a private, loopback, link-local or cloud metadata address.';
      mockPost.mockRejectedValue({ response: { status: 400, data: { message: refusal } } });
      const { user, modal } = await openCreate();
      await fill(user, 'Name', 'Intranet');
      await fill(user, 'Endpoint URL', 'https://intranet.corp.example/hook');
      await pickEventType(user, 'identity.created');
      await fill(user, 'Signing secret', 'a-long-enough-secret-123');
      await user.click(within(modal).getByRole('button', { name: 'Create subscription' }));

      expect(await within(modal).findByText(`Not created: ${refusal}`)).toBeInTheDocument();
      expect(
        screen.getByText('New webhook subscription', { selector: '.ant-modal-title' }),
      ).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it(
    'leaves an IPv6 address to the API, which decides what a webhook may reach',
    { timeout: 30_000 },
    async () => {
      serve([]);
      const refusal =
        'Webhook URL refused: it must use https, and its host must not be or resolve to a private, loopback, link-local or cloud metadata address.';
      mockPost.mockRejectedValue({ response: { status: 400, data: { message: refusal } } });
      const { user, modal } = await openCreate();
      await fill(user, 'Name', 'Loopback');
      await fill(user, 'Endpoint URL', 'https://[::ffff:127.0.0.1]/x');
      await pickEventType(user, 'identity.created');
      await fill(user, 'Signing secret', 'a-long-enough-secret-123');
      await user.click(within(modal).getByRole('button', { name: 'Create subscription' }));

      expect(await within(modal).findByText(`Not created: ${refusal}`)).toBeInTheDocument();
      expect(within(modal).queryByText(/Enter a full URL/)).not.toBeInTheDocument();
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringMatching(/\/event-subscriptions$/),
        expect.objectContaining({
          webhook: expect.objectContaining({ url: 'https://[::ffff:127.0.0.1]/x' }),
        }),
      );
    },
  );

  it('refuses text that is not a URL before asking the API', { timeout: 30_000 }, async () => {
    serve([]);
    const { user, modal } = await openCreate();
    await fill(user, 'Name', 'Broken');
    await fill(user, 'Endpoint URL', 'https://siem example com/hook');
    await pickEventType(user, 'identity.created');
    await fill(user, 'Signing secret', 'a-long-enough-secret-123');
    await user.click(within(modal).getByRole('button', { name: 'Create subscription' }));

    expect(
      await within(modal).findByText(
        'Enter a full URL, for example https://siem.example.com/hooks/euroid.',
      ),
    ).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it(
    'shows the API message when the name is taken meanwhile (409)',
    { timeout: 30_000 },
    async () => {
      serve([]);
      const taken = 'A webhook subscription named "SIEM feed" already exists.';
      mockPost.mockRejectedValue({ response: { status: 409, data: { message: taken } } });
      const { user, modal } = await openCreate();
      await fill(user, 'Name', 'SIEM feed');
      await fill(user, 'Endpoint URL', 'https://siem.example.com/hooks/euroid');
      await pickEventType(user, 'identity.created');
      await fill(user, 'Signing secret', 'a-long-enough-secret-123');
      await user.click(within(modal).getByRole('button', { name: 'Create subscription' }));

      expect(await within(modal).findByText(`Not created: ${taken}`)).toBeInTheDocument();
    },
  );
});
