import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider, App as AntdApp } from 'antd';
import { AuthContext } from '../../../auth/auth-context';
import { UserList } from '../UserList';
import type { IStandardUser } from '../../../interfaces';
import { UserStatus } from '../../../interfaces';
import { fetchOpenDriftCounts } from '@api/reconciliation-api';

const mockUsers: IStandardUser[] = [
  {
    _id: '1',
    email: 'alice@example.com',
    firstName: 'Alice',
    lastName: 'Smith',
    status: UserStatus.ACTIVE,
    sourceSystem: 'Workday',
  } as IStandardUser,
  {
    _id: '2',
    email: 'bob@example.com',
    firstName: 'Bob',
    lastName: 'Jones',
    status: UserStatus.ACTIVE,
    sourceSystem: 'Manual',
  } as IStandardUser,
  {
    _id: '3',
    email: 'carol@example.com',
    firstName: 'Carol',
    lastName: 'Lee',
    status: UserStatus.PENDING,
    sourceSystem: 'AD',
  } as IStandardUser,
];

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

vi.mock('@api/reconciliation-api', () => ({
  fetchOpenDriftCounts: vi.fn().mockResolvedValue({}),
  reconciliationKeys: {
    openDriftCounts: (ids: string[]) => ['reconciliation', 'drifts', 'open-counts', ids],
  },
}));

vi.mock('@api/intelligence-api', () => ({
  fetchRiskScores: vi.fn().mockResolvedValue([]),
  intelligenceKeys: { riskScores: () => ['riskScores'] },
}));

vi.mock('@api/identity-api', () => ({
  identityKeys: {
    conflicts: () => ['conflicts'],
    listPaginated: (range: { start: number; end: number }) => ['identity', 'list', range],
  },
}));

vi.mock('../../../components/dashboard/ProvisioningProgress', () => ({
  // What the progress modal follows: whose run (the title) and which workflow it polls
  ProvisioningProgress: (p: { visible: boolean; userName: string; workflowId?: string | null }) =>
    p.visible ? (
      <div data-testid="provisioning-progress">{`${p.userName || '-'} | ${p.workflowId ?? 'none'}`}</div>
    ) : null,
}));

vi.mock('../CreateUserModal', () => ({
  CreateUserModal: () => null,
}));

vi.mock('../OnboardingWizard', () => ({
  OnboardingWizard: () => null,
}));

vi.mock('@shared/LiveBadge', () => ({
  LiveBadge: () => <span data-testid="live-badge">Live</span>,
}));

const mockAuthValue = {
  user: {
    profile: {
      sub: 'dev-user',
      email: 'admin@euroid.local',
      name: 'Dev Admin',
      roles: ['super-admin'],
      tenantId: 'default',
      tenantName: 'Default',
    },
    access_token: 'dev-token',
  },
  isAuthenticated: true,
  isLoading: false,
  signoutRedirect: undefined,
  signinRedirect: undefined,
};

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

/** Where the router is, and the `from` an identity page was opened with. */
function LocationProbe() {
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  return (
    <div data-testid="location">
      {location.pathname + location.search}
      {from ? ` from ${from}` : ''}
    </div>
  );
}

function TestWrapper({
  children,
  initialEntry = '/users',
  authValue = mockAuthValue,
}: {
  children: React.ReactNode;
  initialEntry?: string;
  authValue?: typeof mockAuthValue;
}) {
  const queryClient = createTestQueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <ConfigProvider>
            <AntdApp>
              <Routes>
                <Route path="/users" element={children} />
                <Route path="/identities/:id" element={<div>Identity page</div>} />
              </Routes>
              <LocationProbe />
            </AntdApp>
          </ConfigProvider>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

const location = () => screen.getByTestId('location').textContent;

function mockIdentityList(users: IStandardUser[]) {
  mockGet.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/identity/conflicts')) {
      return Promise.resolve({ data: [], headers: {} });
    }
    if (typeof url === 'string' && url.includes('/identity?')) {
      return Promise.resolve({
        data: users,
        headers: { 'x-total-count': String(users.length) },
      });
    }
    return Promise.resolve({ data: [], headers: {} });
  });
}

describe('UserList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentityList(mockUsers);
    vi.mocked(fetchOpenDriftCounts).mockResolvedValue({});
  });

  it('renders table with user rows (name, email, status)', async () => {
    render(
      <TestWrapper>
        <UserList />
      </TestWrapper>,
    );

    expect(await screen.findByText('Alice Smith')).toBeInTheDocument();
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    expect(await screen.findByText('Bob Jones')).toBeInTheDocument();
    expect(await screen.findByText('bob@example.com')).toBeInTheDocument();
    expect(await screen.findByText('Carol Lee')).toBeInTheDocument();
    expect(await screen.findByText('carol@example.com')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /user list/i })).toBeInTheDocument();
  });

  it('renders empty state when no users', async () => {
    mockIdentityList([]);

    render(
      <TestWrapper>
        <UserList />
      </TestWrapper>,
    );

    const emptyElements = await screen.findAllByText(/no data/i);
    expect(emptyElements.length).toBeGreaterThan(0);
  });

  it('shows identity hub header', () => {
    render(
      <TestWrapper>
        <UserList />
      </TestWrapper>,
    );

    expect(screen.getByText(/identity hub/i)).toBeInTheDocument();
  });

  it('opens the identity page from a row, remembering the list page to return to', async () => {
    // 3.dn: the identity drawer became the page /identities/:id.
    const user = userEvent.setup();
    render(
      <TestWrapper initialEntry="/users?page=2&pageSize=20">
        <UserList />
      </TestWrapper>,
    );

    await user.click(await screen.findByText('Bob Jones'));

    expect(await screen.findByText('Identity page')).toBeInTheDocument();
    expect(location()).toBe('/identities/2 from /users?page=2&pageSize=20');
  });

  it('reads the page and page size from the URL, so Back restores them', async () => {
    render(
      <TestWrapper initialEntry="/users?page=2&pageSize=20">
        <UserList />
      </TestWrapper>,
    );

    await waitFor(() =>
      expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('/identity?_start=20&_end=40')),
    );
  });

  it('keeps the conflicts filter in the URL', async () => {
    const user = userEvent.setup();
    render(
      <TestWrapper>
        <UserList />
      </TestWrapper>,
    );

    await user.click(screen.getByRole('switch', { name: /show conflicts only/i }));

    expect(location()).toBe('/users?conflicts=1');
  });

  it('starts the pipeline from its button without leaving the list', async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValue({ data: { workflowId: 'wf-1' } });
    render(
      <TestWrapper>
        <UserList />
      </TestWrapper>,
    );
    await screen.findByText('Alice Smith');

    await user.click(screen.getAllByRole('button', { name: /Run Pipeline/ })[0]);

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(expect.stringContaining('/onboarding/start'), {
        email: 'alice@example.com',
      }),
    );
    expect(location()).toBe('/users');
  });

  // The Sync column showed "Drift detected" for whoever was in the tenant's 50 most recent drifts
  // of any status (corrected and ignored ones too), and "In sync" for identities whose drifts
  // were older. It reads the open drifts of the identities on the page now, in one request.
  it('shows drift for the identities on the page that have open drifts, in one request', async () => {
    vi.mocked(fetchOpenDriftCounts).mockResolvedValue({ '2': 3 });
    render(
      <TestWrapper>
        <UserList />
      </TestWrapper>,
    );

    const rowOf = async (name: string) =>
      (await screen.findByText(name)).closest('tr') as HTMLElement;
    expect(
      await within(await rowOf('Bob Jones')).findByRole('img', { name: 'Drift detected' }),
    ).toBeInTheDocument();
    expect(
      within(await rowOf('Alice Smith')).getByRole('img', { name: 'In sync, low risk' }),
    ).toBeInTheDocument();
    expect(
      within(await rowOf('Carol Lee')).getByRole('img', { name: 'In sync, low risk' }),
    ).toBeInTheDocument();
    expect(fetchOpenDriftCounts).toHaveBeenCalledTimes(1);
    expect(fetchOpenDriftCounts).toHaveBeenCalledWith(['1', '2', '3']);
  });
});

// 08 F7: a failed identity list showed the empty table ("No data") as if the tenant had no one.
describe('UserList when the identities cannot be loaded', () => {
  it('says so instead of showing an empty list', async () => {
    mockGet.mockImplementation((url: string) =>
      typeof url === 'string' && url.includes('/identity?')
        ? Promise.reject(
            Object.assign(new Error('Request failed with status code 500'), {
              response: { status: 500, data: { message: 'Operation failed' } },
            }),
          )
        : Promise.resolve({ data: [], headers: {} }),
    );

    render(
      <TestWrapper>
        <UserList />
      </TestWrapper>,
    );

    expect(await screen.findByText('Identities could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText(/no data/i)).toBeNull();
  });
});

// 08 F8: creating a user, a new hire and a pipeline run need operator (POST /identity,
// POST /onboarding/start); a viewer was offered them and got 403.
describe('UserList role gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentityList(mockUsers);
  });

  it('offers a viewer no Create user, New hire or Run Pipeline', async () => {
    const viewer = {
      ...mockAuthValue,
      user: {
        ...mockAuthValue.user,
        profile: { ...mockAuthValue.user.profile, roles: ['viewer'] },
      },
    };
    render(
      <TestWrapper authValue={viewer}>
        <UserList />
      </TestWrapper>,
    );

    expect(await screen.findByText('Alice Smith')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create user/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /New hire/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Run Pipeline/ })).toBeNull();
  });

  it('offers an operator all three', async () => {
    render(
      <TestWrapper>
        <UserList />
      </TestWrapper>,
    );

    expect(await screen.findByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create user/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New hire/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Run Pipeline/ })).toHaveLength(3);
  });
});

// r2-08 N3: the modal opened on the previous run's workflow until the POST answered, and a double
// click started two onboarding runs.
describe('UserList Run Pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentityList(mockUsers);
  });

  it('follows only the new run, and starts it once on a double click', async () => {
    const user = userEvent.setup();
    let answer!: (value: { data: { workflowId: string } }) => void;
    mockPost
      .mockResolvedValueOnce({ data: { workflowId: 'wf-alice' } })
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    render(
      <TestWrapper>
        <UserList />
      </TestWrapper>,
    );
    await screen.findByText('Alice Smith');
    const buttons = () => screen.getAllByRole('button', { name: /Run Pipeline/ });

    await user.click(buttons()[0]);
    expect(await screen.findByTestId('provisioning-progress')).toHaveTextContent('wf-alice');

    await user.dblClick(buttons()[1]);

    expect(screen.getByTestId('provisioning-progress')).toHaveTextContent('Bob Jones | none');
    answer({ data: { workflowId: 'wf-bob' } });
    await waitFor(() =>
      expect(screen.getByTestId('provisioning-progress')).toHaveTextContent('Bob Jones | wf-bob'),
    );
    expect(mockPost).toHaveBeenCalledTimes(2);
  });
});
