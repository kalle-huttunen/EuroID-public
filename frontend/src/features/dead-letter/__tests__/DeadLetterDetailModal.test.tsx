/**
 * The detail modal of a dead-letter entry (opened from DeadLetterPage, whose test checks that a
 * row opens it): the entry as the API masked it, and retry, replay and dismiss, each after a
 * confirmation, with the outcome the backend reports. The entry is re-read from
 * GET /dead-letter/:id, so an action's outcome is told from the entry after it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { DeadLetterDetailModal } from '../DeadLetterDetailModal';
import type { IDeadLetterEntry } from '../../../interfaces';
import {
  confirmDialog,
  eventEntry,
  HANDLER,
  handlerEntry,
  mockGet,
  mockPost,
  serve,
  workflowEntry,
} from './DeadLetterPage.fixtures';

// Dev builds (VITE_AUTH_DISABLED) grant every role; the role test sets it explicitly.
let mockIsSuperAdmin = true;
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => (role === 'super-admin' ? mockIsSuperAdmin : true),
}));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

/** Opens the modal on `row`, as the page does for a clicked row; resolves to the payload. */
async function openModal(row: IDeadLetterEntry) {
  renderWithProviders(<DeadLetterDetailModal row={row} onClose={vi.fn()} />);
  return screen.findByLabelText('Entry payload');
}

describe('DeadLetterDetailModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSuperAdmin = true;
  });

  it('shows the payload and error as the API masked them', { timeout: 20_000 }, async () => {
    serve([eventEntry]);
    const payload = await openModal(eventEntry);
    expect(payload.textContent).toContain('m•••@corp.example');
    expect(payload.textContent).toContain('+358 •• ••• 4567');
    expect(
      screen.getByText(/the API masks secrets, email addresses and phone number fields/),
    ).toBeInTheDocument();
  });

  it(
    'retries only after confirming and reports a failed retry with its error',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve([eventEntry], {
        [eventEntry._id]: {
          ...eventEntry,
          retryCount: 1,
          lastRetryError: 'handler still failing',
        },
      });
      await openModal(eventEntry);

      await user.click(screen.getByRole('button', { name: /Retry$/ }));
      const modal = await confirmDialog('Retry this entry?');
      expect(within(modal).getByText(/can happen a second time/)).toBeInTheDocument();
      await user.click(within(modal).getByRole('button', { name: /Cancel/ }));
      expect(mockPost).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: /Retry$/ }));
      await user.click(
        within(await confirmDialog('Retry this entry?')).getByRole('button', {
          name: 'Retry event',
        }),
      );

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringMatching(/\/dead-letter\/64b7f0c2a1b2c3d4e5f60720\/retry$/),
        ),
      );
      expect(await screen.findByText('Retry failed: handler still failing')).toBeInTheDocument();
      expect(screen.getByText('Attempt 1 of 3. The entry stays pending.')).toBeInTheDocument();
    },
  );

  it(
    'says a retry succeeded only when the backend closed the entry as replayed',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve([eventEntry], { [eventEntry._id]: { ...eventEntry, status: 'replayed' } });
      await openModal(eventEntry);

      await user.click(screen.getByRole('button', { name: /Retry$/ }));
      await user.click(
        within(await confirmDialog('Retry this entry?')).getByRole('button', {
          name: 'Retry event',
        }),
      );

      expect(
        await screen.findByText('Retry succeeded; the entry is closed as replayed.'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Every handler of the event ran again and completed without an error.'),
      ).toBeInTheDocument();
      // 2.0cu: handler failures are reported back now; the old "not proven" caveat is gone.
      expect(screen.queryByText(/Most handlers log their own errors/)).not.toBeInTheDocument();
    },
  );

  it(
    'names the failed handler of a per-handler entry and says only it runs again',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve([handlerEntry], { [handlerEntry._id]: { ...handlerEntry, status: 'replayed' } });
      await openModal(handlerEntry);
      expect(screen.getAllByText(HANDLER).length).toBeGreaterThan(0);

      await user.click(screen.getByRole('button', { name: /Retry$/ }));
      const modal = await confirmDialog('Retry this entry?');
      expect(within(modal).getByText(/runs the handler that failed/)).toBeInTheDocument();
      expect(within(modal).getByText(/The handler runs again/)).toBeInTheDocument();
      await user.click(within(modal).getByRole('button', { name: 'Retry event' }));

      expect(
        await screen.findByText(
          `The handler that failed (${HANDLER}) ran again with the stored event and completed without an error.`,
        ),
      ).toBeInTheDocument();
    },
  );

  it(
    'says a replay succeeded only when the backend closed the entry as replayed',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve([eventEntry], { [eventEntry._id]: { ...eventEntry, status: 'replayed' } });
      await openModal(eventEntry);

      await user.click(screen.getByRole('button', { name: /Replay$/ }));
      const modal = await confirmDialog('Replay this entry?');
      expect(within(modal).getByText(/does not count as a retry attempt/)).toBeInTheDocument();
      await user.click(within(modal).getByRole('button', { name: 'Replay event' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringMatching(/\/64b7f0c2a1b2c3d4e5f60720\/replay$/),
        ),
      );
      expect(
        await screen.findByText('Replay succeeded; the entry is closed as replayed.'),
      ).toBeInTheDocument();
    },
  );

  it(
    'reports a failed replay with its error and the entry still pending',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve([eventEntry], {
        [eventEntry._id]: { ...eventEntry, lastRetryError: 'handler still failing' },
      });
      await openModal(eventEntry);

      await user.click(screen.getByRole('button', { name: /Replay$/ }));
      await user.click(
        within(await confirmDialog('Replay this entry?')).getByRole('button', {
          name: 'Replay event',
        }),
      );

      expect(await screen.findByText('Replay failed: handler still failing')).toBeInTheDocument();
      expect(
        screen.getByText('The entry stays pending. A replay does not count as a retry attempt.'),
      ).toBeInTheDocument();
    },
  );

  it(
    'offers no retry or replay for an entry without an event, only dismiss',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve([workflowEntry]);
      await openModal(workflowEntry);

      expect(screen.getByRole('button', { name: /Retry$/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Replay$/ })).toBeDisabled();
      expect(screen.getByText(/EuroID cannot re-run a workflow from here/)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Dismiss$/ }));
      await user.click(
        within(await confirmDialog('Dismiss this entry?')).getByRole('button', {
          name: 'Dismiss entry',
        }),
      );
      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringMatching(/\/64b7f0c2a1b2c3d4e5f60721\/dismiss$/),
        ),
      );
      expect(await screen.findByText('Entry dismissed. Nothing was re-run.')).toBeInTheDocument();
    },
  );

  it('lets an operator dismiss but offers no retry or replay', { timeout: 20_000 }, async () => {
    mockIsSuperAdmin = false;
    serve([eventEntry]);
    await openModal(eventEntry);

    expect(screen.queryByRole('button', { name: /Retry$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Replay$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dismiss$/ })).toBeEnabled();
    expect(screen.getByText('Retry and replay need the super-admin role.')).toBeInTheDocument();
  });

  it('shows the API message when the backend refuses an action', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve([eventEntry]);
    mockPost.mockRejectedValue({
      response: { status: 400, data: { message: 'Entry 64b7 is not in a replayable state' } },
    });
    await openModal(eventEntry);

    await user.click(screen.getByRole('button', { name: /Replay$/ }));
    await user.click(
      within(await confirmDialog('Replay this entry?')).getByRole('button', {
        name: 'Replay event',
      }),
    );

    expect(
      await screen.findByText('Replay failed: Entry 64b7 is not in a replayable state'),
    ).toBeInTheDocument();
  });
});
