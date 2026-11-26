/**
 * An approver's decision goes to PUT /access-requests/:requestId/approve or /reject with the step
 * waiting for them and their comment. A decision or delegation the approval workflow cannot take: the API answers 409 when the
 * workflow had ended (EuroID closed the request) and 503 when it could not be reached (nothing
 * recorded, try again). The approver sees the API's own message (App.useApp toasts), and after a
 * 409 the queue is asked again so the closed request leaves it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { ApprovalQueue } from '../ApprovalQueue';
import { axiosInstance } from '@api/data';
import type { AccessRequest } from '@api/access-requests-api';

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));

/** GET /access-requests/pending-approvals as the backend answers it. */
const pending: AccessRequest = {
  requestId: '6f1c2a4e-8b0d-4c39-9d2e-0a7b3c5d1e2f',
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
  ],
  approvalSteps: [
    { stepOrder: 0, approverType: 'MANAGER', approverEmail: 'anna@example.com', status: 'PENDING' },
  ],
  createdAt: '2026-11-23T10:00:00.000Z',
};

/** An axios error carrying the API's answer. */
const apiError = (status: number, message: string) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { statusCode: status, message } },
  });

const queueReads = () =>
  vi
    .mocked(axiosInstance.get)
    .mock.calls.filter(([url]) => String(url).endsWith('/access-requests/pending-approvals'))
    .length;

async function decide(action: 'Approve' | 'Reject', comment?: string) {
  const user = userEvent.setup();
  renderWithProviders(<ApprovalQueue />);
  const row = (await screen.findByText('person@example.com')).closest('tr')!;
  await user.click(within(row).getByRole('button', { name: new RegExp(action) }));
  const dialog = await screen.findByRole('dialog');
  if (comment) await user.type(within(dialog).getByPlaceholderText('Justification...'), comment);
  await user.click(within(dialog).getByRole('button', { name: 'OK' }));
}

/** The manager approved; the second step waits for this approver. */
const secondStep: AccessRequest = {
  ...pending,
  approvalSteps: [
    {
      stepOrder: 0,
      approverType: 'MANAGER',
      approverEmail: 'anna@example.com',
      status: 'APPROVED',
    },
    { stepOrder: 1, approverType: 'OWNER', approverEmail: 'olli@example.com', status: 'PENDING' },
  ],
};

describe('ApprovalQueue: a decision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(axiosInstance.get).mockResolvedValue({ data: [secondStep] });
    vi.mocked(axiosInstance.put).mockResolvedValue({ data: { success: true } });
  });

  it.each([
    ['Approve' as const, 'approve', 'Request approved'],
    ['Reject' as const, 'reject', 'Request rejected'],
  ])(
    '%s sends the request id, the step waiting for the approver and the comment',
    async (action, route, toast) => {
      await decide(action, 'Checked with the team lead');

      expect(await screen.findByText(toast)).toBeInTheDocument();
      expect(axiosInstance.put).toHaveBeenCalledTimes(1);
      expect(axiosInstance.put).toHaveBeenCalledWith(
        `/api/v1/access-requests/${pending.requestId}/${route}`,
        { stepIndex: 1, justification: 'Checked with the team lead', decision: route },
      );
    },
    20_000,
  );
});

describe('ApprovalQueue: a decision the approval workflow cannot take', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(axiosInstance.get).mockResolvedValue({ data: [pending] });
  });

  it('shows why EuroID closed the request (409) and asks for the queue again', async () => {
    vi.mocked(axiosInstance.put).mockRejectedValueOnce(
      apiError(409, 'The approval workflow is no longer running. The request was closed.'),
    );

    await decide('Approve');

    expect(
      await screen.findByText(
        'The approval workflow is no longer running. The request was closed.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(queueReads()).toBeGreaterThanOrEqual(2));
  }, 20_000);

  it('shows why a delegation closed the request (409)', async () => {
    vi.mocked(axiosInstance.put).mockRejectedValueOnce(
      apiError(409, 'The approval workflow is no longer running. The request was closed.'),
    );
    const user = userEvent.setup();
    renderWithProviders(<ApprovalQueue />);
    const row = (await screen.findByText('person@example.com')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: /Delegate/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Delegate to/), 'dave@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'OK' }));

    expect(
      await screen.findByText(
        'The approval workflow is no longer running. The request was closed.',
      ),
    ).toBeInTheDocument();
    // The delegate route's contract (backend DelegateAccessRequestSchema, pinned by
    // access-requests-id-routes.http.spec.ts with this body): a step and the new approver, no
    // decision. The route used to require `decision` and refused this body (hunt 09 F1).
    expect(axiosInstance.put).toHaveBeenCalledWith(
      expect.stringMatching(/\/access-requests\/.+\/delegate$/),
      { stepIndex: 0, delegateTo: 'dave@example.com' },
    );
    await waitFor(() => expect(queueReads()).toBeGreaterThanOrEqual(2));
  }, 20_000);

  it('asks the approver to try again when the workflow could not be reached (503)', async () => {
    const message =
      'Your decision was not recorded: the approval workflow could not be reached. ' +
      'Try again in a moment.';
    vi.mocked(axiosInstance.put).mockRejectedValueOnce(apiError(503, message));

    await decide('Reject');

    expect(await screen.findByText(message)).toBeInTheDocument();
    // The dialog stays open, so the approver can send it again
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  }, 20_000);
});
