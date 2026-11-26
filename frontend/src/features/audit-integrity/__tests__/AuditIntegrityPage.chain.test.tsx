import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import dayjs from 'dayjs';
import { renderWithProviders } from '../../../test/test-utils';
import { AuditIntegrityPage } from '../AuditIntegrityPage';
import {
  BROKEN_AT,
  CHAIN,
  ERASURE_ID,
  EVENT_ID,
  apiError,
  brokenLink,
  chainOk,
  lastChainParams,
  mockGet,
  mockPost,
  proofOk,
  serve,
  signed,
} from './AuditIntegrityPage.fixtures';

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

const chainCard = () => screen.getByRole('region', { name: 'Hash chain' });
const eventCard = () => screen.getByRole('region', { name: 'Single event' });

async function verifyChain(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(chainCard()).getByRole('button', { name: /Verify chain/ }));
}

async function chooseWindow(label: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Time window' }));
  await screen.findAllByRole('listbox');
  fireEvent.click(document.querySelector(`.ant-select-item-option[title="${label}"]`) as Element);
}

describe('AuditIntegrityPage: hash chain and single event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSuperAdmin = true;
  });

  it('checks the last 24 hours by default and says the chain is intact', async () => {
    const user = userEvent.setup();
    serve({ chain: chainOk(42) });
    renderWithProviders(<AuditIntegrityPage />);

    await verifyChain(user);

    expect(
      await screen.findByText(/^The chain is intact: 42 events checked from .* to now\.$/),
    ).toBeInTheDocument();
    const params = lastChainParams();
    expect(Object.keys(params)).toEqual(['from']);
    const hours = dayjs().diff(dayjs(params.from), 'minute') / 60;
    expect(hours).toBeGreaterThanOrEqual(24);
    expect(hours).toBeLessThan(24.1);
    expect(
      screen.getByText(
        `The chain is intact: 42 events checked from ${dayjs(params.from).format('YYYY-MM-DD HH:mm:ss')} to now.`,
      ),
    ).toBeInTheDocument();
  });

  it('checks the whole log with no window at all', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve({ chain: chainOk(3) });
    renderWithProviders(<AuditIntegrityPage />);

    await chooseWindow('Whole log');
    await verifyChain(user);

    await waitFor(() => expect(lastChainParams()).toEqual({}));
    expect(
      await screen.findByText('The chain is intact: 3 events checked in the whole log.'),
    ).toBeInTheDocument();
  });

  it('offers a custom range with a start and an end time', { timeout: 20_000 }, async () => {
    serve();
    renderWithProviders(<AuditIntegrityPage />);

    await chooseWindow('Custom range');

    expect(within(chainCard()).getByPlaceholderText('From')).toBeInTheDocument();
    expect(within(chainCard()).getByPlaceholderText('To')).toBeInTheDocument();
  });

  it('says what runs while the server checks a long window', async () => {
    const user = userEvent.setup();
    let answer: (value: unknown) => void = () => undefined;
    serve({ chainRequest: () => new Promise((resolve) => (answer = resolve)) });
    renderWithProviders(<AuditIntegrityPage />);

    await verifyChain(user);

    expect(
      await screen.findByText(/^Checking the hash chain from .* to now\.\.\.$/),
    ).toBeInTheDocument();
    expect(screen.getByText(/The server reads every event of the window/)).toBeInTheDocument();
    expect(within(chainCard()).getByRole('button', { name: /Verify chain/ })).toHaveClass(
      'ant-btn-loading',
    );

    await waitFor(() =>
      expect(mockGet).toHaveBeenCalledWith(expect.stringMatching(CHAIN), expect.anything()),
    );
    answer({ data: chainOk(9000) });
    expect(await screen.findByText(/The chain is intact: 9000 events checked/)).toBeInTheDocument();
    expect(screen.queryByText(/Checking the hash chain/)).not.toBeInTheDocument();
  });

  it(
    'names the first broken event, why it breaks the chain, and links it in the audit log',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve({ chain: brokenLink });
      renderWithProviders(<AuditIntegrityPage />);

      await verifyChain(user);

      expect(await screen.findByText(/^The chain is broken from/)).toBeInTheDocument();
      const card = chainCard();
      expect(within(card).getByText(EVENT_ID)).toBeInTheDocument();
      expect(
        within(card).getByText(
          new RegExp(
            `written ${dayjs(BROKEN_AT).format('YYYY-MM-DD HH:mm:ss')}, chain position 412, event 57 of the window`,
          ),
        ),
      ).toBeInTheDocument();
      expect(
        within(card).getByText('It does not link to the event before it.'),
      ).toBeInTheDocument();
      expect(within(card).getByText(/that event was replaced by another one/)).toBeInTheDocument();
      expect(within(card).getByRole('link', { name: 'Open it in the audit log' })).toHaveAttribute(
        'href',
        `/audit?dateFrom=${encodeURIComponent(BROKEN_AT)}&dateTo=${encodeURIComponent(BROKEN_AT)}`,
      );
    },
  );

  it('says how many chain positions are missing before an event', async () => {
    const user = userEvent.setup();
    serve({ chain: { ...brokenLink, reason: 'missing_events', missingEvents: 3 } });
    renderWithProviders(<AuditIntegrityPage />);

    await verifyChain(user);

    expect(await screen.findByText('Events before it are missing.')).toBeInTheDocument();
    const card = chainCard();
    expect(
      within(card).getByText(
        /3 positions before it\. Chain positions before it are not in the log/,
      ),
    ).toBeInTheDocument();
    expect(
      within(card).getByRole('link', { name: 'Open it in the audit log' }),
    ).toBeInTheDocument();
  });

  it('says when the newest events of the chain are missing, with no event to name', async () => {
    const user = userEvent.setup();
    serve({
      chain: {
        valid: false,
        eventsChecked: 40,
        firstInvalidSeq: 41,
        reason: 'missing_events',
        missingEvents: 2,
        legacyEventsChecked: 0,
        erasureGaps: [],
      },
    });
    renderWithProviders(<AuditIntegrityPage />);

    await verifyChain(user);

    expect(
      await screen.findByText('2 events at the end of the chain, from position 41, are missing.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/All 40 events before them hold/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Check its Merkle proof' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Open it in the audit log' }),
    ).not.toBeInTheDocument();
  });

  it('reports gaps GDPR erasures recorded and the older events it checked', async () => {
    const user = userEvent.setup();
    serve({
      chain: {
        ...chainOk(120),
        legacyEventsChecked: 80,
        legacyNote: 'Events written before hash version 2 ...',
        erasureGaps: [
          { erasureEntryId: ERASURE_ID, erasedAt: '2026-11-20T09:30:00.000Z', eventsRemoved: 4 },
        ],
      },
    });
    renderWithProviders(<AuditIntegrityPage />);

    await verifyChain(user);

    expect(await screen.findByText(/^The chain is intact: 120 events checked/)).toBeInTheDocument();
    const gap = within(chainCard()).getByLabelText('GDPR erasure gap');
    expect(gap.textContent).toContain(`4 events removed by the GDPR erasure ${ERASURE_ID}`);
    expect(gap.textContent).toContain(
      dayjs('2026-11-20T09:30:00.000Z').format('YYYY-MM-DD HH:mm:ss'),
    );
    expect(gap.textContent).toContain('so the gap is not tampering');
    expect(
      screen.getByText(
        /80 events were written before hash version 2\. Their hash does not cover the payload/,
      ),
    ).toBeInTheDocument();
  });

  it('says a changed event no longer matches its hash', async () => {
    const user = userEvent.setup();
    serve({ chain: { ...brokenLink, reason: 'hash_mismatch' } });
    renderWithProviders(<AuditIntegrityPage />);

    await verifyChain(user);

    expect(
      await screen.findByText('Its stored hash does not match its content.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/was changed after it was written/)).toBeInTheDocument();
  });

  it('says so when the window holds no events', async () => {
    const user = userEvent.setup();
    serve({ chain: chainOk(0) });
    renderWithProviders(<AuditIntegrityPage />);

    await verifyChain(user);

    expect(
      await screen.findByText(/^No audit events from .* to now\. Nothing was checked\.$/),
    ).toBeInTheDocument();
  });

  it('shows the API message when the check fails', async () => {
    const user = userEvent.setup();
    serve({ chainRequest: () => Promise.reject(apiError(500, 'Audit store unavailable')) });
    renderWithProviders(<AuditIntegrityPage />);

    await verifyChain(user);

    expect(
      await screen.findByText('The check failed: Audit store unavailable'),
    ).toBeInTheDocument();
  });

  it(
    "checks the broken event's Merkle proof from the chain result",
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve({ chain: brokenLink, proof: proofOk });
      renderWithProviders(<AuditIntegrityPage />);
      await verifyChain(user);

      await user.click(await screen.findByRole('button', { name: 'Check its Merkle proof' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`/audit/verify-event/${EVENT_ID}$`)),
        ),
      );
      expect(within(eventCard()).getByLabelText('Audit event id')).toHaveValue(EVENT_ID);
      expect(
        await screen.findByText(`Event ${EVENT_ID} is in checkpoint ${signed.checkpointId}`),
      ).toBeInTheDocument();
    },
  );

  it(
    "checks an event's proof by its id and lists the proof steps",
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve({ proof: proofOk });
      renderWithProviders(<AuditIntegrityPage />);

      const check = within(eventCard()).getByRole('button', { name: /Check proof/ });
      expect(check).toBeDisabled();
      await user.type(within(eventCard()).getByLabelText('Audit event id'), ` ${EVENT_ID} `);
      await user.click(check);

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`/audit/verify-event/${EVENT_ID}$`)),
        ),
      );
      expect(
        await screen.findByText(/Its proof \(2 steps\) leads from the event/),
      ).toBeInTheDocument();
      // In a collapsed <details>: found by its label, not by role.
      const steps = within(eventCard()).getByLabelText('Proof steps');
      expect(steps.querySelectorAll('li')).toHaveLength(2);
      expect(steps.textContent).toContain(`right: ${'c'.repeat(64)}`);
      expect(steps.textContent).toContain(`left: ${'d'.repeat(64)}`);
    },
  );

  it('says when a proof does not lead to the checkpoint root', async () => {
    const user = userEvent.setup();
    serve({ proof: { ...proofOk, valid: false } });
    renderWithProviders(<AuditIntegrityPage />);

    await user.type(within(eventCard()).getByLabelText('Audit event id'), `${EVENT_ID}{Enter}`);

    expect(
      await screen.findByText(
        `The proof of event ${EVENT_ID} does not lead to the root of checkpoint ${signed.checkpointId}`,
      ),
    ).toBeInTheDocument();
  });

  it('shows the API message when no checkpoint holds the event', async () => {
    const user = userEvent.setup();
    serve({ proofError: apiError(400, `No Merkle checkpoint contains event ${EVENT_ID}`) });
    renderWithProviders(<AuditIntegrityPage />);

    await user.type(within(eventCard()).getByLabelText('Audit event id'), `${EVENT_ID}{Enter}`);

    expect(
      await screen.findByText(
        `No proof for event ${EVENT_ID}: No Merkle checkpoint contains event ${EVENT_ID}`,
      ),
    ).toBeInTheDocument();
  });

  // Every audit integrity route needs super-admin: anyone else would only get 403s.
  it('asks nothing of the API for a user without super-admin', async () => {
    mockIsSuperAdmin = false;
    serve();
    renderWithProviders(<AuditIntegrityPage />);

    expect(
      await screen.findByText('Audit integrity checks need the super-admin role.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Verify chain/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Check checkpoints/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create checkpoint/ })).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('lets a super-admin run every check', async () => {
    serve();
    renderWithProviders(<AuditIntegrityPage />);

    expect(within(chainCard()).getByRole('button', { name: /Verify chain/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Check checkpoints/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Create checkpoint/ })).toBeEnabled();
    expect(within(eventCard()).getByLabelText('Audit event id')).toBeEnabled();
    // Only the checkpoint list loads by itself; the checks wait for a click.
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(mockGet.mock.calls.some(([url]) => CHAIN.test(url as string))).toBe(false);
  });
});
