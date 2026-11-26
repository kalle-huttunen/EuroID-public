import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { DeadLetterPage } from '../DeadLetterPage';
import {
  eventEntry,
  LIST,
  mockGet,
  mockPost,
  serve,
  workflowEntry,
} from './DeadLetterPage.fixtures';

// Dev builds (VITE_AUTH_DISABLED) grant every role; the modal's role test is in its own file.
vi.mock('../../../auth/usePermission', () => ({ usePermission: () => true }));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

async function openDetails(user: ReturnType<typeof userEvent.setup>, source: string) {
  // Waits for the rows with a text query: retrying the role query until they arrived could use up
  // findBy's one-second limit on a loaded machine.
  await screen.findAllByText(source);
  await user.click(screen.getByRole('button', { name: new RegExp(`Open entry ${source}`) }));
  return screen.findByLabelText('Entry payload');
}

/** The params of the last list request. */
function lastListParams(): Record<string, unknown> {
  const calls = mockGet.mock.calls.filter(([url]) => LIST.test(url as string));
  return (calls.at(-1)?.[1] as { params: Record<string, unknown> }).params;
}

describe('DeadLetterPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists entries with type, source, error and status, asking for one row more than a page', async () => {
    serve([eventEntry, workflowEntry]);
    renderWithProviders(<DeadLetterPage />);

    expect(await screen.findByText('identity.created')).toBeInTheDocument();
    expect(screen.getByText('distributed-transaction')).toBeInTheDocument();
    expect(screen.getByText('Event handler failed')).toBeInTheDocument();
    expect(screen.getByText('Workflow failed')).toBeInTheDocument();
    expect(screen.getByText('Handler failed for m•••@corp.example')).toBeInTheDocument();
    expect(lastListParams()).toEqual({ limit: 21, offset: 0 });
    // One page only: no older page to go to.
    expect(screen.getByRole('button', { name: /Older/ })).toBeDisabled();
  });

  it('fits the list to the page: fixed columns, a long source cut with its name on hover', async () => {
    // 2.0co: the table was sized to its content, so at 1440 px Details and Status were cut off.
    const user = userEvent.setup();
    serve([{ ...eventEntry, source: 'identity.created:NotificationHandler' }]);
    renderWithProviders(<DeadLetterPage />);

    const source = await screen.findByText('identity.created:NotificationHandler');
    const table = source.closest('table')!;
    expect(table.style.tableLayout).toBe('fixed');
    expect(table.style.width).not.toBe('max-content');
    // Retries moved to the entry's details: one column fewer at desktop widths.
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Captured',
      'Type',
      'Source',
      'Error',
      'Status',
      '',
    ]);

    await user.hover(source);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Show entries from identity.created:NotificationHandler',
    );
  });

  it(
    'filters by status from the key figures and by source prefix',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve([eventEntry]);
      renderWithProviders(<DeadLetterPage />);

      await user.click(
        await screen.findByRole('button', { name: 'Show failed permanently entries' }),
      );
      await waitFor(() =>
        expect(lastListParams()).toEqual({ status: 'failed_permanently', limit: 21, offset: 0 }),
      );

      await user.type(screen.getByLabelText('Source starts with'), ' webhook: {Enter}');
      await waitFor(() =>
        expect(lastListParams()).toEqual({
          status: 'failed_permanently',
          source: 'webhook:',
          limit: 21,
          offset: 0,
        }),
      );
    },
  );

  // The webhooks page links a failed delivery here, filtered by its source.
  it('starts filtered by the source a link names', async () => {
    serve([eventEntry]);
    renderWithProviders(<DeadLetterPage />, {
      initialRoute: `/dead-letter?source=${encodeURIComponent('webhook:64b7f0c2a1b2c3d4e5f60730:identity.created')}`,
    });

    await waitFor(() =>
      expect(lastListParams()).toEqual({
        source: 'webhook:64b7f0c2a1b2c3d4e5f60730:identity.created',
        limit: 21,
        offset: 0,
      }),
    );
    expect(screen.getByLabelText('Source starts with')).toHaveValue(
      'webhook:64b7f0c2a1b2c3d4e5f60730:identity.created',
    );
    // Only the filtered list was asked for.
    expect(mockGet.mock.calls.filter(([url]) => LIST.test(url as string))).toHaveLength(1);
  });

  it(
    'pages to older entries only when the backend returned more than a page',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      const many = Array.from({ length: 21 }, (_, i) => ({
        ...eventEntry,
        _id: `64b7f0c2a1b2c3d4e5f607${String(i).padStart(2, '0')}`,
      }));
      serve(many);
      renderWithProviders(<DeadLetterPage />);

      // 20 shown, the 21st only says an older page exists.
      expect(
        await screen.findAllByRole('button', { name: /Open entry identity.created/ }),
      ).toHaveLength(20);
      await user.click(screen.getByRole('button', { name: /Older/ }));
      await waitFor(() => expect(lastListParams()).toEqual({ limit: 21, offset: 20 }));
      expect(screen.getByText('Page 2')).toBeInTheDocument();
    },
  );

  it(
    'opens an entry in a centered modal sized for its payload, actions in the footer',
    { timeout: 20_000 },
    async () => {
      // 3.dm: the owner chose a modal over the side drawer for this read-and-act view.
      const user = userEvent.setup();
      serve([eventEntry]);
      renderWithProviders(<DeadLetterPage />);

      const payload = await openDetails(user, 'identity.created');
      expect(document.querySelector('.ant-drawer')).toBeNull();
      const modal = payload.closest('.ant-modal') as HTMLElement;
      expect(modal).toHaveStyle({ width: '880px' });
      const footer = modal.querySelector('.ant-modal-footer') as HTMLElement;
      expect(within(footer).getByRole('button', { name: /Retry$/ })).toBeEnabled();
      expect(within(footer).getByRole('button', { name: /Dismiss$/ })).toBeEnabled();

      await user.click(within(modal).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByLabelText('Entry payload')).toBeNull());
    },
  );

  it('says so when the queue is empty', async () => {
    serve([]);
    renderWithProviders(<DeadLetterPage />);
    expect(await screen.findByText('The dead-letter queue is empty')).toBeInTheDocument();
  });
});
