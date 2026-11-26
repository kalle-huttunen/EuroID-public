import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders } from '../../../test/test-utils';
import { RequestDetail } from '../RequestDetail';
import { axiosInstance } from '@api/data';
import type { AccessRequest } from '@api/access-requests-api';
import { API_BASE } from '@api/constants';
import { usePermission } from '../../../auth/usePermission';

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));
// Signed in as a viewer unless a test says otherwise (policy-admin below)
vi.mock('../../../auth/usePermission', () => ({ usePermission: vi.fn(() => false) }));

/** GET /access-requests/:id as the backend answers it (a stored request document). */
const request = (sodCheckResult: AccessRequest['sodCheckResult']): AccessRequest => ({
  requestId: 'req-1',
  requesterId: 'id-person',
  requesterEmail: 'person@example.com',
  status: 'PENDING_APPROVAL',
  entitlements: [
    {
      catalogEntryId: 'cat-approvers',
      system: 'entra-id',
      entitlementName: 'Approvers',
      justification: 'needed for audits',
    },
  ] as AccessRequest['entitlements'],
  approvalSteps: [],
  sodCheckResult,
  createdAt: '2026-11-23T10:00:00.000Z',
});

const renderDetail = (doc: AccessRequest) => {
  vi.mocked(axiosInstance.get).mockResolvedValue({ data: doc });
  return renderWithProviders(
    <Routes>
      <Route path="/access-requests/:id" element={<RequestDetail />} />
    </Routes>,
    { initialRoute: '/access-requests/req-1' },
  );
};

describe('RequestDetail: segregation of duties', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the reviewer the Warn matches stored with the request', async () => {
    renderDetail(
      request({
        passed: true,
        violations: [
          {
            policyName: 'Auditor also approving',
            severity: 'MEDIUM',
            action: 'WARN',
            conflictingEntitlements: ['entra-id:Auditors', 'entra-id:Approvers'],
          },
          // Stored before the action was kept: every stored match of a passed result is a Warn one
          {
            policyName: 'Old warning',
            severity: 'LOW',
            conflictingEntitlements: ['entra-id:A', 'entra-id:B'],
          },
        ],
      }),
    );

    const card = await screen.findByRole('region', { name: 'Segregation of duties warnings' });
    expect(within(card).getByText('Auditor also approving')).toBeInTheDocument();
    expect(within(card).getByText(/entra-id:Auditors, entra-id:Approvers/)).toBeInTheDocument();
    expect(within(card).getByText('Old warning')).toBeInTheDocument();
    expect(within(card).getByText(/Warn policies do not stop the request/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Segregation of duties conflict' })).toBeNull();
  });

  it('says why a request was rejected before fulfilment', async () => {
    renderDetail({
      ...request({
        passed: false,
        violations: [
          {
            policyName: 'Payments vs approvals',
            severity: 'HIGH',
            action: 'BLOCK',
            conflictingEntitlements: ['entra-id:Payables', 'entra-id:Approvers'],
          },
        ],
      }),
      status: 'REJECTED',
    });

    const card = await screen.findByRole('region', { name: 'Segregation of duties conflict' });
    expect(within(card).getByText(/Rejected before fulfilment/)).toBeInTheDocument();
    expect(within(card).getByText('Payments vs approvals')).toBeInTheDocument();
    expect(within(card).getByText(/entra-id:Payables, entra-id:Approvers/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Segregation of duties warnings' })).toBeNull();
  });

  it('shows no SoD card for a request without matches', async () => {
    renderDetail(request({ passed: true, violations: [] }));

    expect(await screen.findByText('Approvers')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Segregation of duties/ })).toBeNull();
  });
});

describe('RequestDetail: a request EuroID closed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('tells the requester why: the approval workflow is no longer running', async () => {
    renderDetail({
      ...request({ passed: true, violations: [] }),
      status: 'CANCELLED',
      statusReason: 'The approval workflow is no longer running.',
    });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Closed as CANCELLED')).toBeInTheDocument();
    expect(
      within(alert).getByText('The approval workflow is no longer running.'),
    ).toBeInTheDocument();
  });

  it('tells the requester why: the end date passed before approval completed', async () => {
    renderDetail({
      ...request({ passed: true, violations: [] }),
      status: 'EXPIRED',
      statusReason: 'The requested end date passed before approval completed.',
    });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Closed as EXPIRED')).toBeInTheDocument();
    expect(
      within(alert).getByText('The requested end date passed before approval completed.'),
    ).toBeInTheDocument();
  });

  // HX-E2: a request whose removal Entra ID refused stays ACTIVE with the reason; it is not closed
  it('tells the requester an ACTIVE request whose access was not removed yet, and why', async () => {
    const reason =
      'Entra ID refused to remove the access: entra-id: 1 of 1 changes failed. The request stays ACTIVE.';
    renderDetail({
      ...request({ passed: true, violations: [] }),
      status: 'ACTIVE',
      statusReason: reason,
    });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Access not removed yet')).toBeInTheDocument();
    expect(within(alert).getByText(reason)).toBeInTheDocument();
    expect(screen.queryByText(/^Closed as/)).toBeNull();
  });

  it('shows a request whose approval workflow could not be started as FAILED', async () => {
    renderDetail({ ...request({ passed: true, violations: [] }), status: 'FAILED' });

    expect(await screen.findByText('Approvers')).toBeInTheDocument();
    const tags = screen.getAllByText('FAILED');
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((tag) => tag.closest('.ant-tag-error'))).toBe(true);
  });

  it('shows no reason for a request decided by people', async () => {
    renderDetail({ ...request({ passed: true, violations: [] }), status: 'REJECTED' });

    expect(await screen.findByText('Approvers')).toBeInTheDocument();
    expect(screen.queryByText(/^Closed as/)).toBeNull();
  });
});

// HX-E3: a removal Entra ID refuses for good was retried every 6 hours forever; a policy-admin
// who removed the access by hand now closes the request from its page
describe('RequestDetail: closing a failing removal as removed by hand', () => {
  const PAST = '2026-11-20T10:00:00.000Z';
  const FUTURE = '2999-01-01T00:00:00.000Z';
  const failing = (over: Partial<AccessRequest> = {}): AccessRequest => ({
    ...request({ passed: true, violations: [] }),
    status: 'ACTIVE',
    expiresAt: PAST,
    statusReason: 'Entra ID refused to remove the access: entra-id: 1 of 1 changes failed.',
    ...over,
  });
  const signInAsPolicyAdmin = () =>
    vi.mocked(usePermission).mockImplementation((role: string) => role !== 'super-admin');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePermission).mockImplementation(() => false);
  });

  it('offers a policy-admin [Mark removed manually] on an ACTIVE request past its end date', async () => {
    signInAsPolicyAdmin();
    renderDetail(failing());

    expect(
      await screen.findByRole('button', { name: /mark removed manually/i }),
    ).toBeInTheDocument();
    expect(usePermission).toHaveBeenCalledWith('policy-admin');
  });

  it.each<[string, () => void, Partial<AccessRequest>]>([
    ['to a viewer', () => undefined, {}],
    ['before the end date', signInAsPolicyAdmin, { expiresAt: FUTURE }],
    ['for a request that is not ACTIVE', signInAsPolicyAdmin, { status: 'EXPIRED' }],
    ['for a request with no end date', signInAsPolicyAdmin, { expiresAt: undefined }],
  ])('offers no such button %s', async (_label, signIn, over) => {
    signIn();
    renderDetail(failing(over));

    expect(await screen.findByText('Approvers')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark removed manually/i })).toBeNull();
  });

  it('takes the requested end date when the request has no granted one', async () => {
    signInAsPolicyAdmin();
    renderDetail(failing({ expiresAt: undefined, timeConstraint: { expiresAt: PAST } }));

    expect(
      await screen.findByRole('button', { name: /mark removed manually/i }),
    ).toBeInTheDocument();
  });

  it('closes it only with a note, and shows the API’s error', async () => {
    signInAsPolicyAdmin();
    vi.mocked(axiosInstance.post)
      .mockRejectedValueOnce({
        response: { data: { message: 'The request changed meanwhile. Reload it.' } },
      })
      .mockResolvedValueOnce({ data: { ...failing(), status: 'EXPIRED' } });
    renderDetail(failing());
    await userEvent.click(await screen.findByRole('button', { name: /mark removed manually/i }));

    const dialog = await screen.findByRole('dialog');
    const ok = within(dialog).getByRole('button', { name: 'Close as removed manually' });
    expect(ok).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Removal note'), 'Removed in Entra admin');
    await userEvent.click(ok);
    expect(
      await screen.findByText('Not closed: The request changed meanwhile. Reload it.'),
    ).toBeInTheDocument();

    await userEvent.click(ok);
    await waitFor(() => expect(axiosInstance.post).toHaveBeenCalledTimes(2));
    expect(axiosInstance.post).toHaveBeenLastCalledWith(
      `${API_BASE}/access-requests/req-1/removed-manually`,
      { note: 'Removed in Entra admin' },
    );
    expect(await screen.findByText('Request closed as removed manually')).toBeInTheDocument();
  });

  it('tells everyone a request was closed as removed by hand, by whom and why', async () => {
    renderDetail({
      ...failing(),
      status: 'EXPIRED',
      statusReason: 'An admin removed the access by hand and closed the request: done in Entra',
      removedManually: {
        by: 'pat.policy@example.com',
        at: '2026-11-26T09:00:00.000Z',
        note: 'done in Entra',
      },
    });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Closed as removed manually')).toBeInTheDocument();
    expect(within(alert).getByText(/done in Entra/)).toBeInTheDocument();
    expect(within(alert).getByText(/pat\.policy@example\.com/)).toBeInTheDocument();
  });
});
