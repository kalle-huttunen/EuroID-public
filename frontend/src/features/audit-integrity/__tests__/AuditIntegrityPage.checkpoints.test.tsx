import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { AuditIntegrityPage } from '../AuditIntegrityPage';
import {
  EVENT_ID,
  LEGACY_CHECKPOINT_NOTE,
  ROOTS_LIST,
  anchorOf,
  apiError,
  legacyPart,
  mockGet,
  mockPost,
  proofOk,
  rootsOk,
  serve,
  signed,
  unsigned,
} from './AuditIntegrityPage.fixtures';

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

const checkpointsCard = () => screen.getByRole('region', { name: 'Merkle checkpoints' });
const listLoads = () => mockGet.mock.calls.filter(([url]) => ROOTS_LIST.test(url as string));
const ANCHOR = /\/anchor$/;

/** Resolves once the last GET to a matching URL has its answer (or its error). */
async function answered(url: RegExp) {
  await waitFor(() => expect(mockGet.mock.calls.some(([u]) => url.test(u as string))).toBe(true));
  const last = mockGet.mock.calls.findLastIndex(([u]) => url.test(u as string));
  await Promise.resolve(mockGet.mock.results[last].value).catch(() => undefined);
}

/**
 * Opens the signed checkpoint's anchor proof once the data it needs has arrived. A role query
 * over the whole page takes over a second under coverage, past findBy*'s 1 s: so the test awaits
 * the list's and the anchor's requests and finds the row by its text and the button in the row.
 */
async function openAnchor(user: ReturnType<typeof userEvent.setup>) {
  await answered(ROOTS_LIST);
  const row = (await screen.findByText('1025 to 1152')).closest('tr') as HTMLElement;
  await user.click(
    within(row).getByRole('button', { name: `Anchor proof of checkpoint ${signed.checkpointId}` }),
  );
  await answered(ANCHOR);
  return waitFor(() => {
    const modal = document.querySelector('.ant-modal');
    if (!modal) throw new Error('the anchor proof modal is not open');
    return modal as HTMLElement;
  });
}

describe('AuditIntegrityPage: Merkle checkpoints and anchors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSuperAdmin = true;
  });

  it('lists checkpoints newest first with their anchor status', async () => {
    serve({ checkpoints: [signed, unsigned] });
    renderWithProviders(<AuditIntegrityPage />);

    const signedRow = (await screen.findByText('128')).closest('tr') as HTMLElement;
    expect(listLoads()[0][1]).toEqual({ params: { page: 1, limit: 20 } });
    expect(within(signedRow).getByText('Signed')).toBeInTheDocument();
    expect(within(signedRow).getByText('Witness 202')).toBeInTheDocument();
    expect(within(signedRow).getByText(`${'a'.repeat(12)}…`)).toBeInTheDocument();
    expect(within(signedRow).getByText('1025 to 1152')).toBeInTheDocument();
    expect(
      within(signedRow).getByRole('button', { name: /Anchor proof of checkpoint/ }),
    ).toBeEnabled();

    // Nothing to prove for a checkpoint that was never signed.
    const unsignedRow = screen.getByText('Not signed').closest('tr') as HTMLElement;
    // Made before audit events had chain positions
    expect(within(unsignedRow).getByText('Not recorded')).toBeInTheDocument();
    expect(
      within(unsignedRow).getByRole('button', { name: /Anchor proof of checkpoint/ }),
    ).toBeDisabled();
  });

  it('keeps the table in a horizontal scroll container with fixed columns', async () => {
    serve({ checkpoints: [signed] });
    renderWithProviders(<AuditIntegrityPage />);

    const table = (await screen.findByText('128')).closest('table') as HTMLTableElement;
    expect(table.style.tableLayout).toBe('fixed');
    // At 400 px the table keeps its width and its container scrolls sideways.
    expect(table.style.width).toBe('1190px');
    expect((table.closest('.ant-table-content') as HTMLElement).style.overflowX).toBe('auto');
  });

  it(
    "opens a signed checkpoint's anchor proof in a centered modal by its checkpoint id",
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve({ checkpoints: [signed], anchor: anchorOf(signed) });
      renderWithProviders(<AuditIntegrityPage />);

      const modal = await openAnchor(user);

      expect(await within(modal).findByText('The signature verifies')).toBeInTheDocument();
      // The route takes the checkpoint's UUID, not its _id.
      expect(mockGet).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`/audit/merkle-roots/${signed.checkpointId}/anchor$`)),
      );
      expect(document.querySelector('.ant-drawer')).toBeNull();
      expect(modal).toHaveStyle({ width: '720px' });
      expect(within(modal).getByText('f'.repeat(64))).toBeInTheDocument();
      expect(within(modal).getByText('ab'.repeat(64))).toBeInTheDocument();
      expect(within(modal).getByLabelText('Signed payload').textContent).toContain(
        `"rootHash": "${signed.rootHash}"`,
      );
      expect(within(modal).getByText('https://witness.example/anchors')).toBeInTheDocument();

      const footer = modal.querySelector('.ant-modal-footer') as HTMLElement;
      await user.click(within(footer).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByLabelText('Signed payload')).toBeNull());
    },
  );

  it('says when the anchor signature does not verify', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve({ checkpoints: [signed], anchor: anchorOf(signed, false) });
    renderWithProviders(<AuditIntegrityPage />);

    const modal = await openAnchor(user);

    expect(await within(modal).findByText('The signature does not verify')).toBeInTheDocument();
    expect(within(modal).getByText(/the server now holds another key or none/)).toBeInTheDocument();
  });

  it('shows the API message when the anchor cannot be loaded', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve({
      checkpoints: [signed],
      anchorError: apiError(400, `Checkpoint ${signed.checkpointId} has not been anchored`),
    });
    renderWithProviders(<AuditIntegrityPage />);

    const modal = await openAnchor(user);

    expect(
      await within(modal).findByText(
        `Could not load the anchor: Checkpoint ${signed.checkpointId} has not been anchored`,
      ),
    ).toBeInTheDocument();
  });

  it('checks every checkpoint against the events it covers', async () => {
    const user = userEvent.setup();
    serve({ checkpoints: [signed, unsigned], roots: rootsOk });
    renderWithProviders(<AuditIntegrityPage />);

    await user.click(within(checkpointsCard()).getByRole('button', { name: /Check checkpoints/ }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(expect.stringMatching(/\/audit\/verify$/), {}),
    );
    expect(
      await screen.findByText(
        '2 checkpoints checked: every stored root matches its event hashes, and 131 covered events re-hash to them.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Every covered event is still in the log.')).toBeInTheDocument();
  });

  it('counts covered events that left the log without calling them tampering', async () => {
    const user = userEvent.setup();
    serve({ checkpoints: [signed], roots: { ...rootsOk, eventsVerified: 120, eventsMissing: 11 } });
    renderWithProviders(<AuditIntegrityPage />);

    await user.click(within(checkpointsCard()).getByRole('button', { name: /Check checkpoints/ }));

    expect(
      await screen.findByText(
        /^11 covered events are no longer in the log: removed by retention, a GDPR erasure or a deletion/,
      ),
    ).toBeInTheDocument();
  });

  it('shows the legacy checkpoint as legacy, apart from the chain positions', async () => {
    serve({ checkpoints: [legacyPart, signed] });
    renderWithProviders(<AuditIntegrityPage />);

    const row = (await screen.findByText('9500')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Legacy, part 1')).toBeInTheDocument();
    expect(within(row).queryByText('Not recorded')).toBeNull();
    const chainedRow = screen.getByText('128').closest('tr') as HTMLElement;
    expect(within(chainedRow).queryByText(/Legacy/)).toBeNull();
  });

  it('says what the check of a legacy checkpoint proves and what it cannot', async () => {
    const user = userEvent.setup();
    serve({
      checkpoints: [legacyPart, signed],
      roots: {
        ...rootsOk,
        eventsVerified: 9628,
        legacyCheckpointsChecked: 1,
        legacyNote: LEGACY_CHECKPOINT_NOTE,
      },
    });
    renderWithProviders(<AuditIntegrityPage />);

    await user.click(within(checkpointsCard()).getByRole('button', { name: /Check checkpoints/ }));

    expect(
      await screen.findByText(`1 of them is a legacy checkpoint. ${LEGACY_CHECKPOINT_NOTE}`),
    ).toBeInTheDocument();
    expect(screen.getByText('Every covered event is still in the log.')).toBeInTheDocument();
  });

  it("says an event's proof leads to a legacy checkpoint, and what that proves", async () => {
    const user = userEvent.setup();
    serve({
      checkpoints: [legacyPart],
      proof: {
        ...proofOk,
        rootHash: legacyPart.rootHash,
        checkpointId: legacyPart.checkpointId,
        legacy: true,
        legacyNote: LEGACY_CHECKPOINT_NOTE,
      },
    });
    renderWithProviders(<AuditIntegrityPage />);

    const card = screen.getByRole('region', { name: 'Single event' });
    fireEvent.change(within(card).getByLabelText('Audit event id'), {
      target: { value: EVENT_ID },
    });
    await user.click(within(card).getByRole('button', { name: /Check proof/ }));

    expect(
      await within(card).findByText(
        `Event ${EVENT_ID} is in checkpoint ${legacyPart.checkpointId}`,
      ),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(`This is a legacy checkpoint. ${LEGACY_CHECKPOINT_NOTE}`),
    ).toBeInTheDocument();
  });

  it('names the checkpoint whose root no longer matches', async () => {
    const user = userEvent.setup();
    serve({
      checkpoints: [signed],
      roots: {
        valid: false,
        checkpointsVerified: 1,
        eventsVerified: 0,
        eventsMissing: 0,
        legacyCheckpointsChecked: 0,
        firstInvalidCheckpoint: signed.checkpointId,
        reason: 'root_mismatch',
      },
    });
    renderWithProviders(<AuditIntegrityPage />);

    await user.click(within(checkpointsCard()).getByRole('button', { name: /Check checkpoints/ }));

    expect(
      await screen.findByText(
        `Checkpoint ${signed.checkpointId}: its stored root does not match its stored event hashes`,
      ),
    ).toBeInTheDocument();
  });

  it('names the covered event that changed after the checkpoint', async () => {
    const user = userEvent.setup();
    serve({
      checkpoints: [signed],
      roots: {
        valid: false,
        checkpointsVerified: 1,
        eventsVerified: 0,
        eventsMissing: 0,
        legacyCheckpointsChecked: 0,
        firstInvalidCheckpoint: signed.checkpointId,
        reason: 'event_changed',
        invalidEventId: EVENT_ID,
      },
    });
    renderWithProviders(<AuditIntegrityPage />);

    await user.click(within(checkpointsCard()).getByRole('button', { name: /Check checkpoints/ }));

    expect(
      await screen.findByText(
        `An event that checkpoint ${signed.checkpointId} covers was changed after the checkpoint`,
      ),
    ).toBeInTheDocument();
    expect(within(checkpointsCard()).getByText(EVENT_ID)).toBeInTheDocument();
  });

  it(
    'creates a checkpoint after a confirmation and loads the list again',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve({ checkpoints: [unsigned], created: signed });
      renderWithProviders(<AuditIntegrityPage />);
      await screen.findByText('Not signed');
      expect(listLoads()).toHaveLength(1);

      await user.click(
        within(checkpointsCard()).getByRole('button', { name: /Create checkpoint/ }),
      );
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveAccessibleName('Create a Merkle checkpoint now?');
      expect(
        within(dialog).getByText(/The audit log records that you made it/),
      ).toBeInTheDocument();
      // Nothing is sent before the confirmation.
      expect(mockPost).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Create checkpoint' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(expect.stringMatching(/\/audit\/merkle-roots$/)),
      );
      expect(await screen.findByText('Checkpoint created over 128 events.')).toBeInTheDocument();
      await waitFor(() => expect(listLoads()).toHaveLength(2));
    },
  );

  it('shows the API message when no checkpoint could be created', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve({
      checkpoints: [signed],
      createError: apiError(
        400,
        'No audit events since the last checkpoint: nothing to checkpoint yet.',
      ),
    });
    renderWithProviders(<AuditIntegrityPage />);
    await screen.findByText('128');

    await user.click(within(checkpointsCard()).getByRole('button', { name: /Create checkpoint/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create checkpoint' }));

    expect(
      await screen.findByText(
        'No checkpoint was created: No audit events since the last checkpoint: nothing to checkpoint yet.',
      ),
    ).toBeInTheDocument();
    expect(listLoads()).toHaveLength(1);
  });

  it('says so when no checkpoints exist, and why', async () => {
    serve({ checkpoints: [] });
    renderWithProviders(<AuditIntegrityPage />);

    expect(await screen.findByText('No Merkle checkpoints yet')).toBeInTheDocument();
    expect(
      screen.getByText(/The daily audit archive run makes them when it is enabled/),
    ).toBeInTheDocument();
  });

  it('shows the API message when the checkpoints cannot be loaded', async () => {
    serve({ checkpointsError: apiError(500, 'Mongo is down') });
    renderWithProviders(<AuditIntegrityPage />);

    expect(await screen.findByText('Could not load the checkpoints')).toBeInTheDocument();
    expect(within(checkpointsCard()).getByText('Mongo is down')).toBeInTheDocument();
  });

  it('loads the checkpoints again on Refresh', async () => {
    const user = userEvent.setup();
    serve({ checkpoints: [signed] });
    renderWithProviders(<AuditIntegrityPage />);
    await screen.findByText('128');
    expect(listLoads()).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /Refresh/ }));

    await waitFor(() => expect(listLoads()).toHaveLength(2));
  });
});
