/**
 * The peer group check in the request form: for an operator, each requested entitlement with a
 * native id is checked with POST /intelligence/unusual-check for the identity with the signed-in
 * user's email (GET /identity/v2/by-email), and a warning is shown while the request is composed.
 * It never blocks the request. A role below operator sends no check (the route needs operator).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, mockAuthValue } from '../../../test/test-utils';
import { RequestForm } from '../RequestForm';
import type { RequestableCatalogEntry } from '@api/access-requests-api';

let mockIsOperator = true;
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => (role === 'operator' ? mockIsOperator : true),
}));

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const REQUESTER_ID = '64b7f0c2a1b2c3d4e5f60401';

/** As GET /entitlement-catalog/requestable answers them (full catalog documents). */
const payrollAdmins: RequestableCatalogEntry = {
  _id: '6741c0f2a9d3e5b1c2f40b11',
  name: 'SG-Payroll-Admins',
  system: 'entra-id',
  nativeId: '2f1e0d9c-8b7a-4c6d-9e5f-0a1b2c3d4e01',
  type: 'group',
  riskLevel: 'HIGH',
  category: 'Finance',
};
const financeShare: RequestableCatalogEntry = {
  _id: '6741c0f2a9d3e5b1c2f40b12',
  name: 'Finance share',
  system: 'ad',
  nativeId: 'CN=Finance-Share,OU=Groups,DC=corp,DC=example',
  type: 'group',
  riskLevel: 'MEDIUM',
};
/** Not linked to an entitlement in its system yet: no name in the peer baseline. */
const travelTool: RequestableCatalogEntry = {
  _id: '6741c0f2a9d3e5b1c2f40b13',
  name: 'Travel booking',
  system: 'servicenow',
  type: 'role',
};

const UNUSUAL = '/api/v1/intelligence/unusual-check';
const BY_EMAIL = '/api/v1/identity/v2/by-email';

type Body = { identityId: string; entitlementId: string };
let unusualAnswer: (body: Body) => Promise<unknown>;
let byEmailAnswer: () => Promise<unknown>;

const unusualCalls = () => mockPost.mock.calls.filter(([url]) => url === UNUSUAL);
const byEmailCalls = () => mockGet.mock.calls.filter(([url]) => url === BY_EMAIL);

function apiError(status: number, message: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { statusCode: status, message } },
  });
}

/** The peer check's alert (the SoD pre-check shows an alert of its own while it runs). */
const peerAlert = async () =>
  (await screen.findByText('Unusual for your peer group')).closest('[role="alert"]') as HTMLElement;

function renderForm(entries: RequestableCatalogEntry[]) {
  const onSuccess = vi.fn();
  renderWithProviders(<RequestForm entries={entries} onSuccess={onSuccess} onCancel={vi.fn()} />);
  return onSuccess;
}

describe('RequestForm peer group check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOperator = true;
    byEmailAnswer = () =>
      Promise.resolve({
        data: { found: true, identity: { _id: REQUESTER_ID, email: 'admin@euroid.local' } },
      });
    unusualAnswer = ({ entitlementId }) =>
      // Nest sends no body for a null answer: axios gives an empty string.
      Promise.resolve({
        data:
          entitlementId === `entra-id::${payrollAdmins.nativeId}`
            ? { warning: 'Only 3% of your peers have this access.', severity: 'CRITICAL' }
            : '',
      });
    mockGet.mockImplementation((url: string) =>
      url === BY_EMAIL ? byEmailAnswer() : Promise.reject(apiError(404, 'Not found')),
    );
    mockPost.mockImplementation((url: string, body: unknown) => {
      if (url === UNUSUAL) return unusualAnswer(body as Body);
      if (url.endsWith('/access-requests/pre-check-sod')) {
        return Promise.resolve({ data: { blockers: [], warnings: [] } });
      }
      return Promise.resolve({ data: { requestId: 'req-1', status: 'PENDING_APPROVAL' } });
    });
  });

  it('warns an operator about an entitlement few peers have, while the request is composed', async () => {
    renderForm([payrollAdmins, financeShare, travelTool]);

    const alert = await peerAlert();
    expect(within(alert).getByText('Unusual for your peer group')).toBeInTheDocument();
    const item = within(alert).getByText('SG-Payroll-Admins').closest('li') as HTMLElement;
    expect(item).toHaveTextContent('SG-Payroll-Admins: Only 3% of your peers have this access.');
    expect(within(item).getByText('Critical')).toBeInTheDocument();
    expect(alert).toHaveClass('ant-alert-error');
    expect(within(alert).queryByText('Finance share')).toBeNull();
    expect(within(alert).getByText(/This does not block the request/)).toBeInTheDocument();
    // Peers' access counts what they got by request too, so the alert says so.
    expect(alert).toHaveTextContent(/their active access requests/);

    // The requester as the access request routes find it, by the signed-in user's email.
    expect(byEmailCalls()[0][1]).toEqual({ params: { email: mockAuthValue.user.profile.email } });
    // Each entry with a native id, as `system::nativeId`; the unlinked one is not.
    expect(unusualCalls().map(([, body]) => body)).toEqual([
      { identityId: REQUESTER_ID, entitlementId: `entra-id::${payrollAdmins.nativeId}` },
      { identityId: REQUESTER_ID, entitlementId: `ad::${financeShare.nativeId}` },
    ]);
    expect(screen.getByRole('button', { name: 'Submit Request' })).toBeEnabled();
  });

  it('submits the request despite the warning', { timeout: 15_000 }, async () => {
    const user = userEvent.setup();
    const onSuccess = renderForm([payrollAdmins]);
    await screen.findByText('Unusual for your peer group');

    await user.type(
      screen.getByLabelText('Justification (min 10 characters)'),
      'Covering payroll runs in December',
    );
    await user.click(screen.getByRole('button', { name: 'Submit Request' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(mockPost).toHaveBeenCalledWith('/api/v1/access-requests', {
      entitlements: [
        {
          catalogEntryId: payrollAdmins._id,
          justification: 'Covering payroll runs in December',
        },
      ],
      requestedDurationDays: undefined,
    });
  });

  it('shows an uncommon entitlement as a warning', async () => {
    unusualAnswer = () =>
      Promise.resolve({
        data: {
          warning: 'This access is uncommon in your peer group (12% hold rate).',
          severity: 'WARNING',
        },
      });
    renderForm([financeShare]);

    const alert = await peerAlert();
    expect(alert).toHaveClass('ant-alert-warning');
    expect(within(alert).getByText('Warning')).toBeInTheDocument();
    expect(alert).toHaveTextContent('uncommon in your peer group (12% hold rate)');
  });

  it('shows nothing when every entitlement is usual for the peers', async () => {
    unusualAnswer = () => Promise.resolve({ data: '' });
    renderForm([financeShare]);

    await waitFor(() => expect(unusualCalls()).toHaveLength(1));
    expect(screen.queryByText('Unusual for your peer group')).toBeNull();
  });

  it('checks nothing for a signed-in user who is no identity in the hub', async () => {
    byEmailAnswer = () => Promise.reject(apiError(404, 'Identity not found'));
    renderForm([payrollAdmins]);

    await waitFor(() => expect(byEmailCalls()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(unusualCalls()).toHaveLength(0);
    expect(screen.queryByText('Unusual for your peer group')).toBeNull();
  });

  it('says so, with the API’s message, when the check fails', async () => {
    unusualAnswer = () =>
      Promise.reject(apiError(400, 'entitlementId: String must contain at most 500 character(s)'));
    renderForm([payrollAdmins]);

    expect(
      await screen.findByText(
        /The peer group check could not run: entitlementId: String must contain at most 500/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit Request' })).toBeEnabled();
  });

  it('sends a viewer no check and shows no warning', async () => {
    mockIsOperator = false;
    renderForm([payrollAdmins, financeShare]);

    // The SoD pre-check still runs for every role.
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/v1/access-requests/pre-check-sod', {
        entitlements: [{ catalogEntryId: payrollAdmins._id }, { catalogEntryId: financeShare._id }],
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(byEmailCalls()).toHaveLength(0);
    expect(unusualCalls()).toHaveLength(0);
    expect(screen.queryByText('Unusual for your peer group')).toBeNull();
  });
});

describe('RequestForm justification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOperator = false;
    mockPost.mockImplementation((url: string) =>
      url.endsWith('/access-requests/pre-check-sod')
        ? Promise.resolve({ data: { blockers: [], warnings: [] } })
        : Promise.resolve({ data: { requestId: 'req-1', status: 'PENDING_APPROVAL' } }),
    );
  });

  const requestCalls = () =>
    mockPost.mock.calls.filter(([url]) => url === '/api/v1/access-requests');

  it('refuses an empty or short justification without sending the request', async () => {
    // POST /access-requests refuses a justification under 10 characters (create DTO).
    const user = userEvent.setup();
    const onSuccess = renderForm([payrollAdmins]);
    const justification = screen.getByLabelText('Justification (min 10 characters)');

    await user.click(screen.getByRole('button', { name: 'Submit Request' }));
    expect(await screen.findByText('Justification is required')).toBeInTheDocument();

    await user.type(justification, 'audit');
    await user.click(screen.getByRole('button', { name: 'Submit Request' }));
    expect(await screen.findByText('At least 10 characters required')).toBeInTheDocument();

    expect(requestCalls()).toHaveLength(0);
    expect(onSuccess).not.toHaveBeenCalled();

    await user.type(justification, ' of payroll runs');
    await user.click(screen.getByRole('button', { name: 'Submit Request' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(requestCalls()).toHaveLength(1);
  }, 15_000);
});

// Hunt 09 F3: a failed submit that was no SoD refusal was rethrown inside the form's onFinish, an
// unobserved rejection: the requester saw nothing. A cleared duration field sent null, which the
// API refuses (400), so that request failed silently too.
describe('RequestForm submit errors', () => {
  const requestCalls = () =>
    mockPost.mock.calls.filter(([url]) => url === '/api/v1/access-requests');

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOperator = false;
    mockPost.mockImplementation((url: string) =>
      url.endsWith('/access-requests/pre-check-sod')
        ? Promise.resolve({ data: { blockers: [], warnings: [] } })
        : Promise.resolve({ data: { requestId: 'req-1', status: 'PENDING_APPROVAL' } }),
    );
  });

  it('shows the API’s reason when the request is refused', async () => {
    const reason =
      'No approver for the MANAGER step: the person the access is for has no manager ' +
      '(managerEmail) in the directory.';
    mockPost.mockImplementation((url: string) =>
      url.endsWith('/access-requests/pre-check-sod')
        ? Promise.resolve({ data: { blockers: [], warnings: [] } })
        : Promise.reject(apiError(400, reason)),
    );
    const user = userEvent.setup();
    const onSuccess = renderForm([payrollAdmins]);

    await user.type(
      screen.getByLabelText('Justification (min 10 characters)'),
      'Covering payroll runs in December',
    );
    await user.click(screen.getByRole('button', { name: 'Submit Request' }));

    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
    // The form stays open with the request, so it can be sent again
    expect(screen.getByRole('button', { name: 'Submit Request' })).toBeEnabled();
  }, 15_000);

  it('sends no duration when the duration field was cleared', async () => {
    const user = userEvent.setup();
    const onSuccess = renderForm([payrollAdmins]);
    const duration = screen.getByLabelText('Duration (days, optional)');

    await user.type(screen.getByLabelText('Justification (min 10 characters)'), 'Year-end close');
    await user.type(duration, '30');
    await user.clear(duration);
    await user.click(screen.getByRole('button', { name: 'Submit Request' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const [[, body]] = requestCalls();
    expect(body).not.toHaveProperty('requestedDurationDays', null);
    expect((body as { requestedDurationDays?: unknown }).requestedDurationDays).toBeUndefined();
  }, 15_000);
});
