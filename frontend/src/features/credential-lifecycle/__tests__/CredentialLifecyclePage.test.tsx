/**
 * Credential lifecycle page: the operator lists (due and overdue, could not be checked), their
 * empty and error states, the note that nothing is reset, and the role gating that mirrors the
 * controller: the compliance summary and the policies are policy-admin routes, so an operator
 * gets neither tab nor request. The policies tab is in CredentialLifecyclePage.policies.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ADA_ID,
  BY_STATUS,
  COMPLIANCE_URL,
  EXPIRING,
  POLICIES,
  SVC_ID,
  apiError,
  callsTo,
  mockDelete,
  mockGet,
  mockPatch,
  mockPost,
  renderPage,
  serve,
} from './CredentialLifecyclePage.fixtures';

let mockIsPolicyAdmin = false;
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => (role === 'policy-admin' ? mockIsPolicyAdmin : true),
}));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

describe('CredentialLifecyclePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPolicyAdmin = false;
  });

  it('lists the due and overdue credentials, earliest first, each linked to its identity', async () => {
    serve();
    renderPage();

    const table = await screen.findByRole('table', { name: 'Due and overdue credentials' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    const [overdue, soon] = rows;
    expect(within(overdue).getByText('Active Directory')).toBeInTheDocument();
    expect(
      within(overdue).getByText('CN=svc-backup,OU=Service,DC=corp,DC=local'),
    ).toBeInTheDocument();
    expect(within(overdue).getByText('Overdue')).toBeInTheDocument();
    expect(within(overdue).getByText('Overdue by 3 days')).toBeInTheDocument();
    expect(
      within(overdue).getByRole('link', { name: `Open the credentials of identity ${SVC_ID}` }),
    ).toHaveAttribute('href', `/identities/${SVC_ID}?tab=credentials`);
    expect(within(soon).getByText('Entra ID')).toBeInTheDocument();
    expect(within(soon).getByText('Expiring soon')).toBeInTheDocument();
    expect(within(soon).getByText('In 10 days')).toBeInTheDocument();

    expect(callsTo(EXPIRING)[0][1]).toEqual({ params: { daysAhead: 30, limit: 500 } });
    // Nothing on the page offers a reset, and it says why
    expect(screen.getByText('Automatic password reset is off')).toBeInTheDocument();
    expect(screen.getByText(/needs secret storage/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reset|rotate/i })).toBeNull();
  });

  it('asks again for another due-within window', async () => {
    const user = userEvent.setup();
    serve();
    renderPage();
    await screen.findByRole('table', { name: 'Due and overdue credentials' });

    await user.click(screen.getByText('7 days'));

    await waitFor(() =>
      expect(callsTo(EXPIRING).map(([, config]) => config.params.daysAhead)).toEqual([30, 7]),
    );
  });

  it('lists the credentials that could not be checked with the reason', async () => {
    const user = userEvent.setup();
    serve();
    renderPage();
    await screen.findByRole('table', { name: 'Due and overdue credentials' });

    await user.click(screen.getByRole('tab', { name: 'Could not be checked' }));

    const table = await screen.findByRole('table', {
      name: 'Credentials that could not be checked',
    });
    expect(
      within(table).getByText('Active Directory is not configured for this tenant'),
    ).toBeInTheDocument();
    expect(within(table).getByText('Could not be checked')).toBeInTheDocument();
    expect(
      within(table).getByRole('link', { name: `Open the credentials of identity ${ADA_ID}` }),
    ).toBeInTheDocument();
    expect(callsTo(BY_STATUS)[0][1]).toEqual({ params: { status: 'UNKNOWN', limit: 500 } });
  });

  it('says where entries come from when nothing is due or unchecked', async () => {
    const user = userEvent.setup();
    serve({ due: [], unknown: [] });
    renderPage();

    expect(await screen.findByText('Nothing is due in the next 30 days')).toBeInTheDocument();
    expect(
      screen.getAllByText(/each account it provisioned in Entra ID or Active Directory/).length,
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole('tab', { name: 'Could not be checked' }));
    expect(await screen.findByText('No account is waiting on a check')).toBeInTheDocument();
  });

  it('shows the API’s message when the list cannot be loaded', async () => {
    serve();
    mockGet.mockImplementation((url: string) =>
      EXPIRING.test(url)
        ? Promise.reject(apiError(400, 'daysAhead: Number must be less than or equal to 365'))
        : Promise.resolve({ data: [] }),
    );
    renderPage();

    expect(await screen.findByText('Could not load the due credentials')).toBeInTheDocument();
    expect(
      screen.getByText('daysAhead: Number must be less than or equal to 365'),
    ).toBeInTheDocument();
  });

  it('gives an operator no compliance summary and no policies, and asks for neither', async () => {
    serve();
    renderPage('/credentials?tab=policies');
    await screen.findByRole('table', { name: 'Due and overdue credentials' });

    expect(screen.queryByRole('tab', { name: 'Policies' })).toBeNull();
    expect(screen.queryByText('Accounts tracked')).toBeNull();
    expect(callsTo(COMPLIANCE_URL)).toHaveLength(0);
    expect(callsTo(POLICIES)).toHaveLength(0);
  });

  it('shows a policy-admin the compliance summary, which opens the matching list', async () => {
    const user = userEvent.setup();
    mockIsPolicyAdmin = true;
    serve();
    renderPage();

    const unknownCell = await screen.findByRole('button', { name: 'Show could not be checked' });
    expect(await within(unknownCell).findByText('5')).toBeInTheDocument();
    expect(screen.getByText('Accounts tracked')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Policies' })).toBeInTheDocument();

    await user.click(unknownCell);

    expect(screen.getByRole('tab', { name: 'Could not be checked' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      await screen.findByText('Active Directory is not configured for this tenant'),
    ).toBeInTheDocument();
  });
});
