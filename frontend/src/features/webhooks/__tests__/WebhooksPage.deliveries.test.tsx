import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { WebhooksPage } from '../WebhooksPage';
import { WebhookDeliveriesModal } from '../WebhookDeliveriesModal';
import type { IWebhookDelivery } from '../../../interfaces';
import {
  delivered,
  DELIVERIES,
  delivery,
  exhausted,
  mockDelete,
  mockGet,
  mockPatch,
  mockPost,
  paused,
  retrying,
  serve,
  sub,
  SUB_ID,
  waiting,
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

describe('WebhooksPage: delivery history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Opens the history from the subscription's row, as an admin does. */
  async function openHistoryFromPage(deliveries: IWebhookDelivery[]) {
    const user = userEvent.setup();
    serve([sub], deliveries);
    renderWithProviders(<WebhooksPage />);
    await screen.findByText('SIEM feed');
    await user.click(screen.getByRole('button', { name: 'Deliveries of SIEM feed' }));
    const heading = await screen.findByText('Deliveries: SIEM feed', {
      selector: '.ant-modal-title',
    });
    return { user, modal: heading.closest('.ant-modal') as HTMLElement };
  }

  /** The history modal alone, as the page opens it for `subscription` (no list to render). */
  async function openHistory(deliveries: IWebhookDelivery[], subscription = sub) {
    const user = userEvent.setup();
    serve([subscription], deliveries);
    renderWithProviders(<WebhookDeliveriesModal subscription={subscription} onClose={vi.fn()} />);
    const heading = await screen.findByText(`Deliveries: ${subscription.name}`, {
      selector: '.ant-modal-title',
    });
    return { user, modal: heading.closest('.ant-modal') as HTMLElement };
  }

  const lastDeliveriesParams = () => {
    const calls = mockGet.mock.calls.filter(([url]) => DELIVERIES.test(url as string));
    return (calls.at(-1)?.[1] as { params: Record<string, unknown> }).params;
  };

  it(
    'lists attempts with status, response, retries and errors, asking for one row more than a page',
    { timeout: 20_000 },
    async () => {
      const { modal } = await openHistoryFromPage([delivered, retrying, exhausted]);

      expect(await within(modal).findByText('Delivered')).toBeInTheDocument();
      expect(lastDeliveriesParams()).toEqual({ limit: 21, offset: 0 });
      expect(mockGet).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`/event-subscriptions/${SUB_ID}/deliveries$`)),
        expect.anything(),
      );
      expect(within(modal).getByText('200')).toBeInTheDocument();
      expect(within(modal).getByText('503')).toBeInTheDocument();
      expect(within(modal).getByText('Request failed with status code 503')).toBeInTheDocument();
      expect(within(modal).getByText(/2026-11-22 \d\d:02:05/)).toBeInTheDocument();
      expect(within(modal).getByText('(passed)')).toBeInTheDocument();
      expect(within(modal).getByRole('button', { name: /Older/ })).toBeDisabled();
    },
  );

  it(
    'links a delivery that ran out of attempts to its dead-letter entries, not one still retrying',
    { timeout: 20_000 },
    async () => {
      const { modal } = await openHistory([retrying, exhausted, waiting]);

      const links = await within(modal).findAllByRole('link', {
        name: /Dead-letter entries for/,
      });
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute(
        'href',
        `/dead-letter?source=${encodeURIComponent(`webhook:${SUB_ID}:identity.created`)}`,
      );
      expect(
        within(modal).getByRole('link', { name: 'All dead-letter entries of this subscription' }),
      ).toHaveAttribute('href', `/dead-letter?source=${encodeURIComponent(`webhook:${SUB_ID}:`)}`);
    },
  );

  it(
    'explains a delivery the retry poller found its subscription inactive for',
    { timeout: 20_000 },
    async () => {
      const { modal } = await openHistory([waiting]);

      expect(await within(modal).findAllByText(/Subscription no longer active/)).not.toHaveLength(
        0,
      );
      expect(within(modal).getByText(/keeps its attempts and waits/)).toBeInTheDocument();
    },
  );

  // 2.0dl: the retry poller no longer reads (or marks) the deliveries of a paused subscription,
  // and a delivery that ran out of attempts keeps no retry time.
  it(
    'explains retries waiting for a paused subscription and links only the one out of attempts',
    { timeout: 20_000 },
    async () => {
      const pausedDelivery = (overrides: Partial<IWebhookDelivery>) =>
        delivery({
          subscriptionId: paused._id,
          eventType: 'provisioning.failed',
          status: 'FAILED',
          ...overrides,
        });
      const { modal } = await openHistory(
        [
          pausedDelivery({
            _id: '64b7f0c2a1b2c3d4e5f60805',
            httpStatus: 503,
            attempts: 2,
            nextRetryAt: '2026-11-22T09:00:01.000Z',
            lastError: 'Request failed with status code 503',
          }),
          pausedDelivery({
            _id: '64b7f0c2a1b2c3d4e5f60806',
            httpStatus: 500,
            attempts: 5,
            lastError: 'Request failed with status code 500',
          }),
        ],
        paused,
      );

      expect(
        await within(modal).findByText('Retries are waiting for this subscription'),
      ).toBeInTheDocument();
      expect(within(modal).getByText(/keeps its attempts and waits/)).toBeInTheDocument();
      expect(within(modal).getAllByRole('link', { name: /Dead-letter entries for/ })).toHaveLength(
        1,
      );
    },
  );

  // Browser check of 2.0dx at 1440 px: the fixed columns alone (1038 px) were wider than the
  // modal body (992 px), so Error and the dead-letter link were cut off.
  it(
    'fits every column in the modal at 1440 px and scrolls sideways only below that',
    { timeout: 20_000 },
    async () => {
      const { modal } = await openHistory([delivered, retrying, exhausted]);
      await within(modal).findByText('Delivered');

      const table = modal.querySelector('table') as HTMLTableElement;
      const tableWidth = parseInt(table.style.width, 10);
      const columnWidths = [...table.querySelectorAll('colgroup col')].map((col) =>
        parseInt((col as HTMLElement).style.width, 10),
      );
      // Every column, the expand column included, has a width; together they fit the table.
      expect(columnWidths.length).toBe(9);
      expect(columnWidths.every((width) => width > 0)).toBe(true);
      expect(columnWidths.reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(tableWidth);
      // 1280 px (antd caps a modal at the viewport less 32 px), less 24 px padding each side.
      expect(modal.style.width).toBe('1280px');
      expect(tableWidth).toBeLessThanOrEqual(1280 - 48);
      // Narrower screens (400 px): the table keeps its width and scrolls inside the modal.
      expect((table.closest('.ant-table-content') as HTMLElement).style.overflowX).toBe('auto');
      // The error is shown whole, wrapping, not cut to one line.
      const error = within(modal).getByText('Request failed with status code 503');
      expect(error.closest('td')?.className).not.toMatch(/ellipsis/);
    },
  );

  it('leaves a missing response or retry empty', { timeout: 20_000 }, async () => {
    const { modal } = await openHistory([delivered, waiting]);
    await within(modal).findByText('Delivered');

    expect(within(modal).queryByText('None')).not.toBeInTheDocument();
    const cells = (id: string) =>
      [
        ...(modal.querySelector(`tr[data-row-key="${id}"]`) as HTMLElement).querySelectorAll('td'),
      ].map((td) => td.textContent);
    // Expand, Created, Event, Status, Response, Attempts, Next retry, Error, Dead letter.
    expect(cells(waiting._id)[4]).toBe('');
    expect(cells(delivered._id)[6]).toBe('');
  });

  it('shows the delivery id and the ids-only body of a row', { timeout: 20_000 }, async () => {
    const { user, modal } = await openHistory([delivered]);

    await user.click(await within(modal).findByRole('button', { name: /expand row/i }));
    expect(await within(modal).findByText(delivered._id)).toBeInTheDocument();
    const body = within(modal).getByLabelText('Delivery body');
    expect(body.textContent).toContain('"identityId": "64b7f0c2a1b2c3d4e5f60999"');
  });

  it(
    'pages to older attempts when the API returned more than a page',
    { timeout: 20_000 },
    async () => {
      const many = Array.from({ length: 21 }, (_, i) =>
        delivery({ _id: `64b7f0c2a1b2c3d4e5f608${String(i).padStart(2, '0')}` }),
      );
      const { user, modal } = await openHistory(many);

      await within(modal).findAllByText('Delivered');
      expect(within(modal).getAllByText('Delivered')).toHaveLength(20);
      await user.click(within(modal).getByRole('button', { name: /Older/ }));
      await waitFor(() => expect(lastDeliveriesParams()).toEqual({ limit: 21, offset: 20 }));
      expect(within(modal).getByText('Page 2')).toBeInTheDocument();
    },
  );

  it('says so when nothing was delivered yet', { timeout: 20_000 }, async () => {
    const { modal } = await openHistory([]);

    expect(await within(modal).findByText('No deliveries yet')).toBeInTheDocument();
    expect(within(modal).getByText(/Test deliveries are not recorded/)).toBeInTheDocument();
  });
});
