import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { AnomalyDetailModal } from '../AnomalyDetailModal';
import type { Anomaly } from '@api/intelligence-api';

// The backend gates anomaly actions by role (anomaly.controller.ts); the modal must match it.
const GRANTS: Record<string, string[]> = {
  'super-admin': ['super-admin', 'operator', 'viewer'],
  operator: ['operator', 'viewer'],
  viewer: ['viewer'],
};
let mockRole = 'super-admin';
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => GRANTS[mockRole].includes(role),
}));

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

/** The routes take the anomaly's public id, its `anomalyId` (a UUID), not the document `_id`. */
const ANOMALY_ID = '0b5e2c1d-7a43-4f0e-9d7a-2a1c3b4d5e6f';
const OBJECT_ID = '665f1c2a1b2c3d4e5f607181';

const openAnomaly: Anomaly = {
  _id: OBJECT_ID,
  anomalyId: ANOMALY_ID,
  identityId: '64b7f0c2a1b2c3d4e5f60001',
  type: 'PRIVILEGE_ESCALATION',
  severity: 'high',
  riskScore: 40,
  title: 'Privilege escalation in 24 h',
  description: 'Three admin groups were added within a day.',
  evidence: { events: ['evt-1', 'evt-2'], pattern: '3 admin groups in 24h', details: {} },
  status: 'open',
  detectedAt: '2026-11-22T10:00:00.000Z',
};

/** Serves GET /anomalies/:id; a status action answers the anomaly as `after` and serves that. */
function serve(initial: Anomaly, after?: Partial<Anomaly>) {
  let current = initial;
  mockGet.mockImplementation((url: string) =>
    url.endsWith(`/anomalies/${ANOMALY_ID}`)
      ? Promise.resolve({ data: current })
      : Promise.reject(Object.assign(new Error('400'), { response: { status: 400 } })),
  );
  mockPost.mockImplementation((url: string) => {
    if (url.endsWith('/anomalies/analyze')) {
      return Promise.resolve({
        data: {
          analyzed: 1,
          totalIdentities: 1,
          anomaliesCreated: 0,
          identityIds: [initial.identityId],
          ruleFailures: { rules: 0, identities: 0, byRule: {} },
        },
      });
    }
    current = { ...current, ...after };
    return Promise.resolve({ data: current });
  });
}

function renderModal(
  row: Anomaly | null = openAnomaly,
  role = 'super-admin',
  onClose: () => void = () => {},
) {
  mockRole = role;
  return renderWithProviders(
    <AnomalyDetailModal
      anomalyId={row ? ANOMALY_ID : null}
      row={row}
      identityLabel="Maija Meikäläinen"
      onClose={onClose}
    />,
  );
}

/** Under test rc-util's useId gives nested modals one id; find the confirmation by its title. */
async function confirmDialog(title: string): Promise<HTMLElement> {
  const heading = await screen.findByText(title);
  return heading.closest('[role="dialog"]') as HTMLElement;
}

function footer(): HTMLElement {
  return document.querySelector('.ant-modal-footer') as HTMLElement;
}

describe('AnomalyDetailModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serve(openAnomaly);
  });

  it(
    'shows the anomaly in a centered modal read by its anomalyId, with a link to the identity page',
    { timeout: 20_000 },
    async () => {
      // 3.dn: the owner chose centered modals over side drawers for read-and-act views.
      renderModal();

      expect(await screen.findByText('3 admin groups in 24h')).toBeInTheDocument();
      expect(document.querySelector('.ant-drawer')).toBeNull();
      const modal = document.querySelector('.ant-modal') as HTMLElement;
      expect(modal).toHaveStyle({ width: '720px' });
      expect(
        within(screen.getByLabelText('Evidence events')).getAllByRole('listitem'),
      ).toHaveLength(2);
      await waitFor(() =>
        expect(mockGet).toHaveBeenCalledWith(expect.stringMatching(`/anomalies/${ANOMALY_ID}$`)),
      );
      expect(mockGet).not.toHaveBeenCalledWith(expect.stringContaining(OBJECT_ID));
      expect(screen.getByRole('link', { name: 'Open identity' })).toHaveAttribute(
        'href',
        `/identities/${openAnomaly.identityId}?tab=risk`,
      );
      expect(screen.getByText('Maija Meikäläinen')).toBeInTheDocument();
    },
  );

  it('gives a super-admin every action, analysis included', { timeout: 20_000 }, async () => {
    renderModal();
    await screen.findByText('3 admin groups in 24h');
    const actions = within(footer());
    for (const name of [/Analyse identity again$/, /Acknowledge$/, /Resolve$/, /Dismiss$/]) {
      expect(actions.getByRole('button', { name })).toBeEnabled();
    }
  });

  it('gives an operator acknowledge, resolve and dismiss, and says analysis needs super-admin', async () => {
    renderModal(openAnomaly, 'operator');
    await screen.findByText('3 admin groups in 24h');
    const actions = within(footer());
    expect(actions.queryByRole('button', { name: /Analyse identity again$/ })).toBeNull();
    expect(actions.getByRole('button', { name: /Resolve$/ })).toBeEnabled();
    expect(
      actions.getByText('Analysing the identity again needs the super-admin role.'),
    ).toBeInTheDocument();
  });

  it('shows a viewer the anomaly without any action', async () => {
    renderModal(openAnomaly, 'viewer');
    await screen.findByText('3 admin groups in 24h');
    expect(footer()).toBeNull();
    expect(screen.queryByRole('button', { name: /Resolve$/ })).toBeNull();
  });

  it(
    'resolves after confirmation and says what happened, with the modal on the closed anomaly',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve(openAnomaly, { status: 'resolved', resolvedAt: '2026-11-22T11:00:00.000Z' });
      renderModal(openAnomaly, 'operator');
      await screen.findByText('3 admin groups in 24h');

      await user.click(within(footer()).getByRole('button', { name: /Resolve$/ }));
      const dialog = await confirmDialog('Resolve anomaly?');
      await user.click(within(dialog).getByRole('button', { name: /^Resolve$/ }));

      expect(await screen.findByText('Resolved. The anomaly is closed.')).toBeInTheDocument();
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringMatching(`/anomalies/${ANOMALY_ID}/resolve$`),
      );
      await waitFor(() =>
        expect(within(footer()).getByRole('button', { name: /Resolve$/ })).toBeDisabled(),
      );
      expect(within(footer()).getByText('The anomaly is resolved.')).toBeInTheDocument();
    },
  );

  it.each([
    ['resolve', /Resolve$/, 'Resolve anomaly?', /^Resolve$/, 'Resolved. The anomaly is closed.'],
    ['dismiss', /Dismiss$/, 'Dismiss anomaly?', /^Dismiss$/, 'Dismissed without a reason.'],
  ] as const)(
    'keeps focus in the modal after %s, so Escape still closes it',
    { timeout: 20_000 },
    async (action, button, title, ok, reported) => {
      // The closed anomaly disables the button the confirmation gave focus back to; focus fell
      // to <body>, where Escape no longer reached the modal.
      const user = userEvent.setup();
      const onClose = vi.fn();
      serve(openAnomaly, {
        status: action === 'resolve' ? 'resolved' : 'dismissed',
        resolvedAt: '2026-11-22T11:00:00.000Z',
      });
      renderModal(openAnomaly, 'operator', onClose);
      await screen.findByText('3 admin groups in 24h');

      await user.click(within(footer()).getByRole('button', { name: button }));
      const dialog = await confirmDialog(title);
      await user.click(within(dialog).getByRole('button', { name: ok }));

      expect(await screen.findByText(reported)).toBeInTheDocument();
      await waitFor(() =>
        expect(within(footer()).getByRole('button', { name: button })).toBeDisabled(),
      );
      const modal = screen.getByText('Evidence').closest('.ant-modal-wrap') as HTMLElement;
      await waitFor(() => expect(modal).toContainElement(document.activeElement as HTMLElement));
      // rc-dialog closes on keyCode 27, which user-event's Escape does not set.
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape', keyCode: 27 });
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it('dismisses with the reason given and reports it', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve(openAnomaly, { status: 'dismissed', metadata: { dismissReason: 'Planned migration' } });
    renderModal(openAnomaly, 'operator');
    await screen.findByText('3 admin groups in 24h');

    await user.click(within(footer()).getByRole('button', { name: /Dismiss$/ }));
    const dialog = await confirmDialog('Dismiss anomaly?');
    await user.type(within(dialog).getByLabelText('Dismiss reason'), 'Planned migration');
    await user.click(within(dialog).getByRole('button', { name: /^Dismiss$/ }));

    expect(await screen.findByText('Dismissed: Planned migration')).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledWith(
      expect.stringMatching(`/anomalies/${ANOMALY_ID}/dismiss$`),
      { reason: 'Planned migration' },
    );
  });

  it(
    'analyses the identity again and reports a run in which every rule ran',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      renderModal();
      await screen.findByText('3 admin groups in 24h');

      await user.click(within(footer()).getByRole('button', { name: /Analyse identity again$/ }));

      expect(await screen.findByText('Analysis found no new anomalies.')).toBeInTheDocument();
      expect(screen.queryByText(/failed/)).toBeNull();
      expect(mockPost).toHaveBeenCalledWith(expect.stringMatching('/anomalies/analyze$'), {
        identityId: openAnomaly.identityId,
      });
    },
  );

  it(
    'does not present "no new anomalies" as a clean result when a rule failed',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue({
        data: {
          analyzed: 1,
          totalIdentities: 1,
          anomaliesCreated: 0,
          identityIds: [openAnomaly.identityId],
          ruleFailures: { rules: 1, identities: 1, byRule: { ORPHAN_ACCESS: 1 } },
        },
      });
      renderModal();
      await screen.findByText('3 admin groups in 24h');

      await user.click(within(footer()).getByRole('button', { name: /Analyse identity again$/ }));

      expect(
        await screen.findByText('Analysis found no new anomalies; 1 rule failed.'),
      ).toBeInTheDocument();
      expect(screen.getByText(/Failed: Orphan Access\./)).toBeInTheDocument();
      expect(screen.getByText(/the server log has the cause/)).toBeInTheDocument();
    },
  );

  it(
    'shows the 409 of a change the anomaly no longer allows, and its current state',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      renderModal(openAnomaly, 'operator');
      await screen.findByText('3 admin groups in 24h');
      // Someone else resolved it meanwhile.
      serve({ ...openAnomaly, status: 'resolved', resolvedAt: '2026-11-22T11:00:00.000Z' });
      mockPost.mockRejectedValue(
        Object.assign(new Error('Request failed with status code 409'), {
          response: {
            status: 409,
            data: { message: `Anomaly ${ANOMALY_ID} is resolved and cannot be acknowledged.` },
          },
        }),
      );

      await user.click(within(footer()).getByRole('button', { name: /Acknowledge$/ }));

      expect(
        await screen.findByText(
          `Acknowledge failed: Anomaly ${ANOMALY_ID} is resolved and cannot be acknowledged.`,
        ),
      ).toBeInTheDocument();
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringMatching(`/anomalies/${ANOMALY_ID}/acknowledge$`),
      );
      // The detail reloads: the footer shows the anomaly as it now is.
      expect(await within(footer()).findByText('The anomaly is resolved.')).toBeInTheDocument();
      expect(within(footer()).queryByRole('button', { name: /Acknowledge$/ })).toBeNull();
    },
  );

  it('reports a refused action with the API reason and keeps the anomaly as it is', async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        response: { status: 403, data: { message: 'Requires one of: operator' } },
      }),
    );
    renderModal(openAnomaly, 'operator');
    await screen.findByText('3 admin groups in 24h');

    await user.click(within(footer()).getByRole('button', { name: /Acknowledge$/ }));

    expect(
      await screen.findByText('Acknowledge failed: Requires one of: operator'),
    ).toBeInTheDocument();
    expect(within(footer()).getByRole('button', { name: /Acknowledge$/ })).toBeEnabled();
  });
});
