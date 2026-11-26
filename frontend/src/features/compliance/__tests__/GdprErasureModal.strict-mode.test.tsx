/**
 * The erasure modal under React.StrictMode, as the app renders it (src/index.tsx), opened by the
 * card's button. The dry run was a useMutation fired once from an effect guarded by a ref:
 * StrictMode unsubscribes and resubscribes the mutation observer after that first mutate, so it
 * never received the answer and the modal showed a skeleton forever although the API answered
 * (browser check 2026-11-25). One dry run per opening still holds: each one writes an audit entry.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { GdprErasureCard } from '../GdprErasureCard';
import {
  ADA_EMAIL,
  ADA_ID,
  apiError,
  mockDelete,
  mockGet,
  mockPost,
  serve,
} from './GdprPage.fixtures';

vi.mock('../../../auth/usePermission', () => ({ usePermission: () => true }));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

const ERASE_URL = `/api/v1/identity/${ADA_ID}/gdpr-erase`;
const ada = { id: ADA_ID, email: ADA_EMAIL, displayName: 'Ada Virtanen' };

const dryRuns = () =>
  mockDelete.mock.calls.filter(
    ([url, config]) => url === ERASE_URL && config?.params?.dryRun === 'true',
  ).length;

type User = ReturnType<typeof userEvent.setup>;

/** Opens the erasure as an admin does: the modal mounts in an update, under StrictMode. */
async function openErasure(user: User) {
  await user.click(screen.getByRole('button', { name: /Erase personal data/ }));
}

describe('GdprErasureModal under StrictMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serve();
    renderWithProviders(
      <React.StrictMode>
        <GdprErasureCard identity={ada} onErased={vi.fn()} />
      </React.StrictMode>,
    );
  });

  it('shows the preview the dry run answered, after one dry run', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    await openErasure(user);

    expect(await screen.findByText('This cannot be undone.')).toBeInTheDocument();
    expect(screen.getByLabelText('Identifier to confirm')).toBeInTheDocument();
    expect(document.querySelector('.ant-modal .ant-skeleton')).toBeNull();
    expect(dryRuns()).toBe(1);
  });

  it('shows a failed dry run with Retry, which runs one more', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    mockDelete.mockRejectedValueOnce(apiError(503, 'The database is not reachable'));
    await openErasure(user);

    const failed = await screen.findByText(/Preview failed: The database is not reachable/);
    expect(dryRuns()).toBe(1);
    await user.click(
      within(failed.closest('.ant-alert') as HTMLElement).getByRole('button', { name: 'Retry' }),
    );

    expect(await screen.findByText('This cannot be undone.')).toBeInTheDocument();
    await waitFor(() => expect(dryRuns()).toBe(2));
  });

  it('runs one dry run per opening', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    await openErasure(user);
    expect(await screen.findByText('This cannot be undone.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('This cannot be undone.')).toBeNull());

    await openErasure(user);
    expect(await screen.findByText('This cannot be undone.')).toBeInTheDocument();
    expect(dryRuns()).toBe(2);
  });
});
