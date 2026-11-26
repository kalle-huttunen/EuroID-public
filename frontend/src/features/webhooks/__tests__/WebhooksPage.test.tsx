import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { WebhooksPage } from '../WebhooksPage';
import type { IWebhookTestResult } from '../../../interfaces';
import {
  confirmDialog,
  expectListReloaded,
  listLoads,
  mockDelete,
  mockGet,
  mockPatch,
  mockPost,
  paused,
  serve,
  sub,
  SUB_ID,
} from './WebhooksPage.fixtures';

// Dev builds (VITE_AUTH_DISABLED) grant every role; the role test sets it explicitly.
let mockIsSuperAdmin = true;
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => (role === 'super-admin' ? mockIsSuperAdmin : true),
}));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

describe('WebhooksPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSuperAdmin = true;
  });

  it('lists subscriptions with URL, event types and status', async () => {
    serve([sub, paused]);
    renderWithProviders(<WebhooksPage />);

    expect(await screen.findByText('SIEM feed')).toBeInTheDocument();
    expect(screen.getByText('https://siem.example.com/hooks/euroid')).toBeInTheDocument();
    expect(screen.getByText('identity.created')).toBeInTheDocument();
    expect(screen.getByText('identity.*')).toBeInTheDocument();
    expect(screen.getByText('drift.detected')).toBeInTheDocument();
    // Three tags, the rest counted.
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.queryByText('anomaly.detected')).not.toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    // Webhooks carry ids only, and the page says so.
    expect(
      screen.getByText(/No names, email addresses or other personal data/),
    ).toBeInTheDocument();
    // An active subscription offers pause, a paused one resume.
    expect(screen.getByRole('button', { name: 'Pause SIEM feed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume Ticketing' })).toBeInTheDocument();
  });

  it('keeps the table in a horizontal scroll container with fixed columns', async () => {
    serve();
    renderWithProviders(<WebhooksPage />);

    const table = (await screen.findByText('SIEM feed')).closest('table')!;
    expect(table.style.tableLayout).toBe('fixed');
    // At 400 px the table keeps its width and its container scrolls sideways.
    expect(table.style.width).toBe('940px');
    expect((table.closest('.ant-table-content') as HTMLElement).style.overflowX).toBe('auto');
  });

  it('says so when there is no subscription and offers to create one', async () => {
    serve([]);
    renderWithProviders(<WebhooksPage />);

    expect(await screen.findByText('No webhook subscriptions yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /New subscription/ }).length).toBe(2);
  });

  it('shows the API message when the list cannot be loaded', async () => {
    mockGet.mockRejectedValue({ response: { status: 500, data: { message: 'Mongo is down' } } });
    renderWithProviders(<WebhooksPage />);

    expect(await screen.findByText('Could not load the webhook subscriptions')).toBeInTheDocument();
    expect(screen.getByText('Mongo is down')).toBeInTheDocument();
  });

  // Every /event-subscriptions route needs super-admin: anyone else would only get 403s.
  it('asks nothing of the API for a user without super-admin', async () => {
    mockIsSuperAdmin = false;
    serve();
    renderWithProviders(<WebhooksPage />);

    expect(await screen.findByText('Webhooks need the super-admin role.')).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /New subscription/ })).not.toBeInTheDocument();
  });

  it('pauses only after confirming, saying what a pause loses', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([sub]);
    renderWithProviders(<WebhooksPage />);
    await screen.findByText('SIEM feed');

    await user.click(screen.getByRole('button', { name: 'Pause SIEM feed' }));
    let dialog = await confirmDialog('Pause SIEM feed?');
    expect(within(dialog).getByText(/are not delivered later/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mockPatch).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Pause SIEM feed' }));
    dialog = await confirmDialog('Pause SIEM feed?');
    const before = listLoads();
    await user.click(within(dialog).getByRole('button', { name: 'Pause subscription' }));

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`/event-subscriptions/${SUB_ID}$`)),
        { status: 'PAUSED' },
      ),
    );
    await expectListReloaded(before);
    expect(await screen.findByText('SIEM feed paused.')).toBeInTheDocument();
  });

  it('resumes a paused subscription', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([paused]);
    renderWithProviders(<WebhooksPage />);
    await screen.findByText('Ticketing');

    await user.click(screen.getByRole('button', { name: 'Resume Ticketing' }));

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(
        expect.stringMatching(/\/event-subscriptions\/64b7f0c2a1b2c3d4e5f60731$/),
        { status: 'ACTIVE' },
      ),
    );
    expect(await screen.findByText(/Ticketing resumed/)).toBeInTheDocument();
  });

  it('shows the API message when a pause fails', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([sub]);
    mockPatch.mockRejectedValue({
      response: { status: 404, data: { message: `Subscription ${SUB_ID} not found` } },
    });
    renderWithProviders(<WebhooksPage />);
    await screen.findByText('SIEM feed');

    await user.click(screen.getByRole('button', { name: 'Pause SIEM feed' }));
    await user.click(
      within(await confirmDialog('Pause SIEM feed?')).getByRole('button', {
        name: 'Pause subscription',
      }),
    );

    expect(
      await screen.findByText(`Pause failed: Subscription ${SUB_ID} not found`),
    ).toBeInTheDocument();
  });

  it('deletes only after confirming and reloads the list', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([sub]);
    renderWithProviders(<WebhooksPage />);
    await screen.findByText('SIEM feed');

    await user.click(screen.getByRole('button', { name: 'Delete SIEM feed' }));
    let dialog = await confirmDialog('Delete SIEM feed?');
    expect(
      within(dialog).getByText(/deliveries waiting for a retry are not sent/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mockDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete SIEM feed' }));
    dialog = await confirmDialog('Delete SIEM feed?');
    const before = listLoads();
    await user.click(within(dialog).getByRole('button', { name: 'Delete subscription' }));

    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`/event-subscriptions/${SUB_ID}$`)),
      ),
    );
    await expectListReloaded(before);
    expect(await screen.findByText('SIEM feed deleted.')).toBeInTheDocument();
  });

  describe('send test', () => {
    const result = (overrides: Partial<IWebhookTestResult>): IWebhookTestResult => ({
      success: true,
      subscriptionId: SUB_ID,
      deliveryId: '7d1c2b4e-1f0a-4c3b-9e8d-5a6b7c8d9e0f',
      eventType: 'webhook.test',
      httpStatus: 204,
      message: 'Delivered: the receiver answered 204.',
      ...overrides,
    });

    /** `answer` builds the API's answer when the request is made. */
    async function sendTest(answer: () => Promise<unknown>) {
      const user = userEvent.setup();
      serve([sub]);
      mockPost.mockImplementation(answer);
      renderWithProviders(<WebhooksPage />);
      await screen.findByText('SIEM feed');
      await user.click(screen.getByRole('button', { name: 'Send a test to SIEM feed' }));
      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`/event-subscriptions/${SUB_ID}/test$`)),
        ),
      );
    }

    it('shows the status the receiver answered', { timeout: 20_000 }, async () => {
      await sendTest(() => Promise.resolve({ data: result({}) }));

      expect(await screen.findByText('Test delivered to SIEM feed')).toBeInTheDocument();
      expect(
        screen.getByText(
          'The receiver answered 204. Delivery id 7d1c2b4e-1f0a-4c3b-9e8d-5a6b7c8d9e0f.',
        ),
      ).toBeInTheDocument();
    });

    it('shows a refusal with the receiver status', { timeout: 20_000 }, async () => {
      await sendTest(() =>
        Promise.resolve({
          data: result({
            success: false,
            httpStatus: 500,
            error: 'Request failed with status code 500',
            message: 'Not delivered: Request failed with status code 500',
          }),
        }),
      );

      expect(await screen.findByText('Test not delivered to SIEM feed')).toBeInTheDocument();
      expect(screen.getByText('The receiver answered 500.')).toBeInTheDocument();
    });

    it('shows the error when the receiver cannot be reached', { timeout: 20_000 }, async () => {
      await sendTest(() =>
        Promise.resolve({
          data: result({
            success: false,
            httpStatus: undefined,
            error: 'getaddrinfo ENOTFOUND siem.example.com',
            message: 'Not delivered: getaddrinfo ENOTFOUND siem.example.com',
          }),
        }),
      );

      expect(await screen.findByText('Test not delivered to SIEM feed')).toBeInTheDocument();
      expect(screen.getByText('getaddrinfo ENOTFOUND siem.example.com')).toBeInTheDocument();
    });

    it('shows the API message when the test cannot be sent', { timeout: 20_000 }, async () => {
      await sendTest(() =>
        Promise.reject({
          response: { status: 404, data: { message: `Subscription ${SUB_ID} not found` } },
        }),
      );

      expect(await screen.findByText('Test not sent to SIEM feed')).toBeInTheDocument();
      expect(screen.getByText(`Subscription ${SUB_ID} not found`)).toBeInTheDocument();
    });
  });
});
