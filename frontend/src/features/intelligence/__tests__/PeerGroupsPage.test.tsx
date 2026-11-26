/**
 * The peer groups page: the groups from GET /intelligence/peer-groups (members, outliers,
 * entitlements, when computed), paging, a group's modal with its outliers read from
 * GET /intelligence/peer-groups/:groupKey/outliers (names from GET /identity/:id, linked to the
 * person's access) and the entitlements its members hold, with how they hold each; the empty,
 * loading and error states; and the route's policy-admin gate (an operator lands on Access Denied
 * and sends nothing).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import dayjs from 'dayjs';
import { renderWithProviders, mockAuthValue } from '../../../test/test-utils';
import { ProtectedRoute } from '../../../auth/ProtectedRoute';
import { PeerGroupsPage } from '../PeerGroupsPage';
import type { IPeerGroup, IPeerGroupOutlier } from '../../../interfaces';
import {
  AINO_ID,
  ainoIdentity,
  apiError,
  dialog,
  financeGroup,
  salesGroup,
} from './access-intelligence.fixtures';

const mockGet = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: { get: (...args: unknown[]) => mockGet(...args), post: vi.fn() },
}));

const LIST = /\/intelligence\/peer-groups$/;
const OUTLIERS = /\/intelligence\/peer-groups\/([^/]+)\/outliers$/;
const IDENTITY = /\/identity\/([^/]+)$/;

let listAnswer: () => Promise<unknown>;
let outliersAnswer: (groupKey: string) => Promise<unknown>;

function serve(groups: IPeerGroup[], total = groups.length) {
  listAnswer = () => Promise.resolve({ data: { data: groups, total } });
  outliersAnswer = (groupKey) => {
    const group = groups.find((g) => g.groupKey === groupKey);
    return Promise.resolve({ data: (group?.outliers ?? []) as IPeerGroupOutlier[] });
  };
}

const calls = (pattern: RegExp) =>
  mockGet.mock.calls.filter(([url]) => pattern.test(url as string));
const groupsTable = () => screen.findByRole('table', { name: 'Peer groups' });
const rowOf = (table: HTMLElement, label: string) =>
  within(table).getByText(label).closest('tr') as HTMLElement;
const at = (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm');

async function openGroup(label: string) {
  const user = userEvent.setup();
  renderWithProviders(<PeerGroupsPage />);
  const table = await groupsTable();
  await user.click(
    within(rowOf(table, label)).getByRole('button', { name: `Details of ${label}` }),
  );
  return { user, modal: await dialog(label) };
}

describe('PeerGroupsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serve([financeGroup, salesGroup]);
    mockGet.mockImplementation((url: string) => {
      if (LIST.test(url)) return listAnswer();
      const groupKey = OUTLIERS.exec(url)?.[1];
      if (groupKey) return outliersAnswer(decodeURIComponent(groupKey));
      const id = IDENTITY.exec(url)?.[1];
      if (id === AINO_ID) return Promise.resolve({ data: ainoIdentity });
      return Promise.reject(apiError(404, 'Identity not found'));
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('lists each group with its members, outliers, entitlements and when it was computed', async () => {
    renderWithProviders(<PeerGroupsPage />);
    const table = await groupsTable();

    expect(calls(LIST).at(-1)?.[1]).toEqual({ params: { page: 1, limit: 20 } });
    const finance = rowOf(table, 'Finance · Accountant');
    const cells = within(finance)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells.slice(1, 5)).toEqual(['6', '1', '3', at(financeGroup.calculatedAt)]);
    const sales = rowOf(table, 'Sales · Account Manager');
    expect(
      within(sales)
        .getAllByRole('cell')
        .map((c) => c.textContent)
        .slice(1, 5),
    ).toEqual(['4', '0', '1', at(salesGroup.calculatedAt)]);
    // The latest computation of the groups shown, and where the data comes from.
    expect(
      screen.getByText(new RegExp(`Last computed ${at(financeGroup.calculatedAt)}`)),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/nightly intelligence batch/).length).toBeGreaterThan(0);
  });

  it(
    'opens a group: its outliers linked to their access and what its members hold',
    { timeout: 15_000 },
    async () => {
      const { modal } = await openGroup('Finance · Accountant');

      await waitFor(() =>
        expect(calls(OUTLIERS).at(-1)?.[0]).toBe(
          `/api/v1/intelligence/peer-groups/${financeGroup.groupKey}/outliers`,
        ),
      );
      const outliers = await within(modal).findByRole('table', { name: 'Outliers' });
      const link = await within(outliers).findByRole('link', {
        name: 'Open the access of Aino Laine',
      });
      expect(link).toHaveAttribute('href', `/identities/${AINO_ID}?tab=access`);
      const aino = link.closest('tr') as HTMLElement;
      expect(within(aino).getByText('15')).toBeInTheDocument();
      // Named as the baseline names it, not by its native id
      expect(within(aino).getByText('entra-id: SG-Payroll-Admins')).toBeInTheDocument();
      expect(within(aino).queryByText(/4b1e2f3a/)).toBeNull();
      expect(
        within(aino).getByText('ad: CN=Finance-Share,OU=Groups,DC=corp,DC=example'),
      ).toBeInTheDocument();

      // Highest share first.
      const baseline = within(modal).getByRole('table', { name: 'Group entitlements' });
      const rows = within(baseline).getAllByRole('row').slice(1);
      expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual([
        'SG-Finance',
        'CN=Finance-Share,OU=Groups,DC=corp,DC=example',
        'SG-Payroll-Admins',
      ]);
      expect(within(rows[1]).getByText('83%')).toBeInTheDocument();
      expect(within(rows[2]).getByText('17%')).toBeInTheDocument();
      // How the members holding it got it.
      expect(within(rows[0]).getByText('Role-based rules, access requests')).toBeInTheDocument();
      expect(within(rows[1]).getByText('Role-based rules')).toBeInTheDocument();
      expect(within(rows[2]).getByText('Access requests')).toBeInTheDocument();
      expect(within(modal).getByText('Entitlements the members hold')).toBeInTheDocument();

      // Advice only: the modal offers nothing but Close.
      expect(within(modal).getByText('Advice only')).toBeInTheDocument();
      expect(
        within(modal)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(expect.arrayContaining(['Close']));
      expect(
        within(modal).queryByRole('button', { name: /grant|revoke|remove|request/i }),
      ).toBeNull();
    },
  );

  it('shows the id of an outlier the identity list no longer has, still linked', async () => {
    serve([{ ...financeGroup, outliers: [{ ...financeGroup.outliers[0], identityId: 'gone-1' }] }]);
    const { modal } = await openGroup('Finance · Accountant');

    const link = await within(modal).findByRole('link', { name: 'Open the access of gone-1' });
    expect(link).toHaveAttribute('href', '/identities/gone-1?tab=access');
  });

  it('says when no member deviates from the group', async () => {
    const { modal } = await openGroup('Sales · Account Manager');

    expect(
      await within(modal).findByText('No member’s access differs from this group’s.'),
    ).toBeInTheDocument();
    // Built before the batch recorded how members hold an entitlement.
    const baseline = within(modal).getByRole('table', { name: 'Group entitlements' });
    expect(within(baseline).getByText('Not recorded')).toBeInTheDocument();
  });

  it('shows the API’s message when the outliers cannot be loaded', async () => {
    outliersAnswer = () => Promise.reject(apiError(403, 'Requires one of: policy-admin'));
    const { modal } = await openGroup('Finance · Accountant');

    expect(await within(modal).findByText('Could not load the outliers')).toBeInTheDocument();
    expect(within(modal).getByText('Requires one of: policy-admin')).toBeInTheDocument();
  });

  it('pages through the groups on the server', { timeout: 15_000 }, async () => {
    serve([financeGroup, salesGroup], 45);
    const user = userEvent.setup();
    renderWithProviders(<PeerGroupsPage />);
    await groupsTable();

    await user.click(screen.getByTitle('2'));
    await waitFor(() =>
      expect(calls(LIST).at(-1)?.[1]).toEqual({ params: { page: 2, limit: 20 } }),
    );
  });

  it('says how groups are made when there is none yet', async () => {
    serve([]);
    renderWithProviders(<PeerGroupsPage />);

    expect(await screen.findByText('No peer groups yet')).toBeInTheDocument();
    expect(screen.getByText(/a group needs at least 3 members by default/)).toBeInTheDocument();
    expect(screen.getByText(/04:00 UTC by default/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /compute|build/i })).toBeNull();
  });

  it('shows a skeleton while the groups load', () => {
    listAnswer = () => new Promise(() => {});
    renderWithProviders(<PeerGroupsPage />);

    const region = screen.getByRole('region', { name: 'Peer group list' });
    expect(region.querySelector('.ant-skeleton')).not.toBeNull();
  });

  it('shows the API’s message when the groups cannot be loaded', async () => {
    listAnswer = () => Promise.reject(apiError(403, 'Requires one of: policy-admin'));
    renderWithProviders(<PeerGroupsPage />);

    expect(await screen.findByText('Could not load the peer groups')).toBeInTheDocument();
    expect(screen.getByText('Requires one of: policy-admin')).toBeInTheDocument();
  });

  it('reads the groups again on Refresh', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PeerGroupsPage />);
    await groupsTable();
    const before = calls(LIST).length;

    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(calls(LIST).length).toBe(before + 1));
  });

  // App.tsx guards the route with policy-admin, like both peer group routes.
  const asRole = (role: string) => ({
    ...mockAuthValue,
    user: { ...mockAuthValue.user, profile: { ...mockAuthValue.user.profile, roles: [role] } },
  });
  const guarded = (
    <ProtectedRoute requiredRole="policy-admin">
      <PeerGroupsPage />
    </ProtectedRoute>
  );

  it('opens for a policy-admin behind the route guard', async () => {
    vi.stubEnv('VITE_AUTH_DISABLED', 'false');
    renderWithProviders(guarded, { authValue: asRole('policy-admin') });
    expect(await groupsTable()).toBeInTheDocument();
  });

  it('shows an operator Access Denied and sends no request', () => {
    vi.stubEnv('VITE_AUTH_DISABLED', 'false');
    renderWithProviders(guarded, { authValue: asRole('operator') });
    expect(screen.getByText('Access Denied')).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });
});
