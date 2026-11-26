import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider, App as AntdApp, Form, Input, type FormInstance } from 'antd';
import { AuthContext } from '../../../auth/auth-context';
import { mockAuthValue } from '../../../test/test-utils';
import type { IStandardUser } from '../../../interfaces';
import { GitHubLoginInput } from '../components/GitHubLoginInput';
import { validateGitHubLogin } from '../components/github-login';
import { IdentityDetailPage } from '../IdentityDetailPage';

// Dev builds (VITE_AUTH_DISABLED) grant every role; the role test sets it explicitly.
let mockIsOperator = true;
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => (role === 'viewer' ? true : mockIsOperator),
}));

const mockGet = vi.fn();
const mockPatch = vi.fn();
const mockDelete = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    post: vi.fn(),
  },
}));

vi.mock('@api/reconciliation-api', () => ({
  fetchDrifts: vi.fn().mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]),
  correctDrift: vi.fn(),
  reconciliationKeys: {
    drifts: (p?: object) => ['reconciliation', 'drifts', p],
    driftsPrefix: () => ['reconciliation', 'drifts'],
  },
}));

// The tabs keep their own behaviour and specs; here they only show what the page hands them.
vi.mock('../components/AccessTab', () => ({
  AccessTab: ({ identityId }: { identityId: string }) => <div>Access for {identityId}</div>,
}));
vi.mock('../components/DriftTab', () => ({
  DriftTab: ({ identityId }: { identityId: string }) => <div>Drift for {identityId}</div>,
}));
vi.mock('../components/UserTimeline', () => ({
  UserTimeline: ({ userId }: { userId: string }) => <div>Timeline for {userId}</div>,
}));
vi.mock('../components/UserRiskTab', () => ({ UserRiskTab: () => <div>Risk tab</div> }));
vi.mock('../components/RawDataTab', () => ({ RawDataTab: () => <div>Raw tab</div> }));
vi.mock('../../credential-lifecycle/CredentialListTabs', () => ({
  IdentityCredentialsTab: ({ identityId }: { identityId: string }) => (
    <div>Credentials for {identityId}</div>
  ),
}));
vi.mock('../../intelligence/IdentityRecommendationsTab', () => ({
  IdentityRecommendationsTab: ({ identityId }: { identityId: string }) => (
    <div>Recommendations for {identityId}</div>
  ),
}));
// The save tests run against a stand-in with some of the real form's fields; one save test sets
// realProfileTab and runs the real form, so the page's diff is also proven against the fields the
// form really has.
let realProfileTab = false;
vi.mock('../components/UserProfileTab', async (importOriginal) => {
  const real = await importOriginal<typeof import('../components/UserProfileTab')>();
  return {
    UserProfileTab: (props: React.ComponentProps<typeof real.UserProfileTab>) =>
      realProfileTab ? <real.UserProfileTab {...props} /> : <StandInProfileTab {...props} />,
  };
});

// Some of the real form's fields, one of them PII (the API answers it masked), and the real
// edit-only GitHub login field with its rule.
const StandInProfileTab = ({
  user,
  form,
  onFieldsChange,
}: {
  user: IStandardUser;
  form: FormInstance;
  onFieldsChange: () => void;
}) => (
  <Form form={form} onFieldsChange={onFieldsChange}>
    <Form.Item name="firstName" label="First name">
      <Input />
    </Form.Item>
    <Form.Item name="jobTitle" label="Job title">
      <Input />
    </Form.Item>
    <Form.Item name="mobilePhone" label="Mobile phone">
      <Input />
    </Form.Item>
    <Form.Item name="status" label="Status">
      <Input />
    </Form.Item>
    <Form.Item
      name="customAttributes"
      label="GitHub login"
      rules={[{ validator: validateGitHubLogin }]}
    >
      <GitHubLoginInput current={user.customAttributes} />
    </Form.Item>
  </Form>
);

const ID = '64b7f0c2a1b2c3d4e5f60001';
const identity = {
  _id: ID,
  email: 'maija.meikalainen@corp.example',
  firstName: 'Maija',
  lastName: 'Meikäläinen',
  status: 'ACTIVE',
  jobTitle: 'Analyst',
  mobilePhone: '+358 •• ••• 4567',
};

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

function renderPage(
  entry: { pathname?: string; search?: string; state?: unknown } = {},
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  }),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={mockAuthValue}>
        <MemoryRouter initialEntries={[{ pathname: `/identities/${ID}`, ...entry }]}>
          <ConfigProvider>
            <AntdApp>
              <Routes>
                <Route path="/identities/:id" element={<IdentityDetailPage />} />
                <Route path="/users" element={<div>Identity list</div>} />
                <Route path="/identity/:id/map" element={<div>Entitlement map</div>} />
                <Route path="/access-explorer" element={<div>Access explorer</div>} />
              </Routes>
              <LocationProbe />
            </AntdApp>
          </ConfigProvider>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const location = () => screen.getByTestId('location').textContent;

describe('IdentityDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOperator = true;
    realProfileTab = false;
    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/identity/${ID}`)
        ? Promise.resolve({ data: identity })
        : Promise.resolve({ data: { identity: null } }),
    );
    mockPatch.mockResolvedValue({ data: {} });
    mockDelete.mockResolvedValue({ data: { workflowId: 'wf-1' } });
  });

  it('shows the identity as a page with its tabs, not a drawer', async () => {
    // 3.dn: the 720 px drawer became the deep-linkable page /identities/:id.
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Maija Meikäläinen' })).toBeInTheDocument();
    expect(document.querySelector('.ant-drawer')).toBeNull();
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    for (const tab of [
      'Profile',
      'Access',
      'Recommendations',
      'Credentials',
      'Timeline',
      'Risk',
      'Raw data',
    ]) {
      expect(screen.getByRole('tab', { name: tab })).toBeInTheDocument();
    }
    expect(await screen.findByRole('tab', { name: /Drift/ })).toHaveTextContent('2');
    expect(screen.getByLabelText('Job title')).toHaveValue('Analyst');
  });

  it('opens the tab named in the URL, so a tab can be linked', async () => {
    renderPage({ search: '?tab=timeline' });
    expect(await screen.findByText(`Timeline for ${ID}`)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true');
  });

  it('puts the chosen tab in the URL and keeps where the page was opened from', async () => {
    const user = userEvent.setup();
    renderPage({ state: { from: '/users?page=3' } });
    await screen.findByRole('heading', { name: 'Maija Meikäläinen' });

    await user.click(screen.getByRole('tab', { name: 'Access' }));

    expect(await screen.findByText(`Access for ${ID}`)).toBeInTheDocument();
    expect(location()).toBe(`/identities/${ID}?tab=access from /users?page=3`);
  });

  it('goes back to the list in the state it was left in', async () => {
    const user = userEvent.setup();
    renderPage({ search: '?tab=risk', state: { from: '/users?page=3&pageSize=20' } });
    await screen.findByRole('heading', { name: 'Maija Meikäläinen' });

    await user.click(screen.getByRole('button', { name: /Back$/ }));

    expect(await screen.findByText('Identity list')).toBeInTheDocument();
    expect(location()).toBe('/users?page=3&pageSize=20');
  });

  it('goes back to the Identity hub when opened from a link', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Maija Meikäläinen' });

    await user.click(screen.getByRole('button', { name: /Back$/ }));

    expect(location()).toBe('/users');
  });

  it('says when the identity cannot be loaded and still offers Back', async () => {
    // A 404 is final; other failures are retried first (api/__tests__/identity-api.test.tsx).
    mockGet.mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        response: { status: 404, data: { message: `Identity ${ID} not found` } },
      }),
    );
    renderPage();

    expect(await screen.findByText('Could not load this identity')).toBeInTheDocument();
    expect(screen.getByText(`Identity ${ID} not found`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back$/ })).toBeInTheDocument();
  });

  it(
    'saves the profile without sending a masked PII value back, and stays on the page',
    { timeout: 20_000 },
    async () => {
      // The real Profile form: every field it has, the masked phone in its PII input.
      realProfileTab = true;
      mockGet.mockImplementation((url: string) =>
        Promise.resolve({
          data: url.endsWith(`/identity/${ID}`)
            ? identity
            : url.endsWith(`/identity/${ID}/mastery`)
              ? { identityId: ID, masteredBy: {}, attributeControls: {} }
              : { identity: null },
        }),
      );
      const user = userEvent.setup();
      renderPage();
      const jobTitle = await screen.findByLabelText(/^Job Title/);
      await waitFor(() => expect(jobTitle).toHaveValue('Analyst'));

      await user.clear(jobTitle);
      await user.type(jobTitle, 'Lead analyst');
      await user.click(screen.getByRole('button', { name: /Save changes$/ }));

      await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
      const [url, values] = mockPatch.mock.calls[0] as [string, Record<string, unknown>];
      expect(url).toMatch(new RegExp(`/identity/${ID}$`));
      expect(values).toEqual({ jobTitle: 'Lead analyst' });
      expect(location()).toBe(`/identities/${ID}`);
    },
  );

  it(
    "shows the API's message when a save is refused, so the admin sees what to fix",
    { timeout: 20_000 },
    async () => {
      const reason =
        'Masked values cannot be saved: mobilePhone. Reveal the field before editing it.';
      mockPatch.mockRejectedValue(
        Object.assign(new Error('Request failed with status code 400'), {
          response: { status: 400, data: { message: reason } },
        }),
      );
      const user = userEvent.setup();
      renderPage();
      const jobTitle = await screen.findByLabelText('Job title');
      await waitFor(() => expect(jobTitle).toHaveValue('Analyst'));

      await user.type(jobTitle, ' 2');
      await user.click(screen.getByRole('button', { name: /Save changes$/ }));

      expect(await screen.findByText(`Failed to update user: ${reason}`)).toBeInTheDocument();
      expect(screen.queryByText(/status code 400/)).toBeNull();
    },
  );

  it(
    'saves nothing for an unchanged form, so the timeline gets no empty "Updated" entry',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByLabelText('Job title')).toHaveValue('Analyst'));

      await user.click(screen.getByRole('button', { name: /Save changes$/ }));

      expect(await screen.findByText('No changes to save')).toBeInTheDocument();
      expect(mockPatch).not.toHaveBeenCalled();
    },
  );

  it(
    "shows the API's 409 for a field an HR source masters, naming the owner",
    { timeout: 20_000 },
    async () => {
      const reason = 'jobTitle is mastered by csv-hr: change it in HR, or set an override.';
      mockPatch.mockRejectedValue(
        Object.assign(new Error('Request failed with status code 409'), {
          response: { status: 409, data: { message: reason } },
        }),
      );
      const user = userEvent.setup();
      renderPage();
      const jobTitle = await screen.findByLabelText('Job title');
      await waitFor(() => expect(jobTitle).toHaveValue('Analyst'));

      await user.type(jobTitle, ' 2');
      await user.click(screen.getByRole('button', { name: /Save changes$/ }));

      expect(await screen.findByText(`Failed to update user: ${reason}`)).toBeInTheDocument();
    },
  );

  it(
    'sends only the fields that changed, so the timeline lists only those',
    { timeout: 20_000 },
    async () => {
      // The timeline entry names every field the PATCH body carries: a save that sent the whole
      // form recorded "13 field(s) updated" for one changed GitHub login.
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByLabelText('First name')).toHaveValue('Maija'));

      await user.type(screen.getByLabelText('GitHub login'), 'octocat');
      await user.click(screen.getByRole('button', { name: /Save changes$/ }));

      await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
      const [, values] = mockPatch.mock.calls[0] as [string, Record<string, unknown>];
      expect(values).toEqual({ customAttributes: { githubLogin: 'octocat' } });
    },
  );

  it(
    'shows an invalid GitHub login on its field and saves nothing',
    { timeout: 20_000 },
    async () => {
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => rejections.push(reason);
      process.on('unhandledRejection', onRejection);
      try {
        const user = userEvent.setup();
        renderPage();
        await waitFor(() => expect(screen.getByLabelText('First name')).toHaveValue('Maija'));

        await user.type(screen.getByLabelText('GitHub login'), 'not a login!');
        await user.click(screen.getByRole('button', { name: /Save changes$/ }));

        expect(
          await screen.findByText(
            'A GitHub login has letters, digits and hyphens, at most 39 characters',
          ),
        ).toBeInTheDocument();
        // An unhandled rejection is reported a macrotask after it happens.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(rejections).toEqual([]);
        expect(mockPatch).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    },
  );

  it('discards unsaved profile changes', async () => {
    const user = userEvent.setup();
    renderPage();
    const jobTitle = await screen.findByLabelText('Job title');
    await waitFor(() => expect(jobTitle).toHaveValue('Analyst'));

    await user.type(jobTitle, ' (temp)');
    await user.click(screen.getByRole('button', { name: /Discard changes$/ }));

    expect(jobTitle).toHaveValue('Analyst');
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('discards an edited GitHub login, which the loaded profile values do not carry', async () => {
    const user = userEvent.setup();
    renderPage();
    const login = await screen.findByLabelText('GitHub login');

    await user.type(login, 'octocat');
    expect(login).toHaveValue('octocat');
    await user.click(screen.getByRole('button', { name: /Discard changes$/ }));

    // Resetting the field remounts its input, so it is looked up again.
    expect(screen.getByLabelText('GitHub login')).toHaveValue('');
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('offers a viewer no save or delete, like PATCH and DELETE /identity/:id', async () => {
    mockIsOperator = false;
    renderPage();
    await screen.findByRole('heading', { name: 'Maija Meikäläinen' });

    expect(screen.queryByRole('button', { name: /Save changes$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete user$/ })).toBeNull();
  });

  // GET /credential-lifecycle/inventory/:identityId needs operator.
  it('opens the identity’s credentials on their tab for an operator', async () => {
    renderPage({ search: '?tab=credentials' });
    expect(await screen.findByText(`Credentials for ${ID}`)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Credentials' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  // GET /intelligence/recommendations/:identityId needs operator.
  it('opens the identity’s recommendations on their tab for an operator', async () => {
    renderPage({ search: '?tab=recommendations' });
    expect(await screen.findByText(`Recommendations for ${ID}`)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Recommendations' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('offers a viewer no Recommendations tab, and a link to it opens Profile', async () => {
    mockIsOperator = false;
    renderPage({ search: '?tab=recommendations' });
    await screen.findByRole('heading', { name: 'Maija Meikäläinen' });

    expect(screen.queryByRole('tab', { name: 'Recommendations' })).toBeNull();
    expect(screen.queryByText(`Recommendations for ${ID}`)).toBeNull();
    expect(screen.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true');
  });

  it('offers a viewer no Credentials tab, and a link to it opens Profile', async () => {
    mockIsOperator = false;
    renderPage({ search: '?tab=credentials' });
    await screen.findByRole('heading', { name: 'Maija Meikäläinen' });

    expect(screen.queryByRole('tab', { name: 'Credentials' })).toBeNull();
    expect(screen.queryByText(`Credentials for ${ID}`)).toBeNull();
    expect(screen.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true');
  });

  it(
    'deletes after confirmation and returns to where the page was opened from',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      renderPage({ state: { from: '/users?page=2' } });
      await screen.findByRole('heading', { name: 'Maija Meikäläinen' });

      await user.click(screen.getByRole('button', { name: /Delete user$/ }));
      // antd also puts the confirm's title in a hidden modal title; match the visible one.
      const dialog = (
        await screen.findByText('Delete user and trigger offboarding?', {
          selector: '.ant-modal-confirm-title',
        })
      ).closest('.ant-modal') as HTMLElement;
      await user.click(within(dialog).getByRole('button', { name: /Yes, delete user$/ }));

      await waitFor(() =>
        expect(mockDelete).toHaveBeenCalledWith(expect.stringMatching(`/identity/${ID}$`)),
      );
      expect(await screen.findByText('Identity list')).toBeInTheDocument();
      expect(location()).toBe('/users?page=2');
    },
  );

  it('opens the entitlement map so that its back button returns to this tab', async () => {
    const user = userEvent.setup();
    renderPage({ search: '?tab=access' });
    await screen.findByRole('heading', { name: 'Maija Meikäläinen' });

    await user.click(screen.getByRole('button', { name: /Entitlement map$/ }));

    expect(location()).toBe(`/identity/${ID}/map from /identities/${ID}?tab=access`);
  });

  // The identity's access graph, holders, path and SoD views read GET /access-explorer (viewer):
  // every role gets the link, and the explorer opens on this identity.
  it('opens the access explorer on this identity', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Maija Meikäläinen' });

    await user.click(screen.getByRole('button', { name: /Access graph$/ }));

    expect(await screen.findByText('Access explorer')).toBeInTheDocument();
    expect(location()).toBe(`/access-explorer?identity=${ID}`);
  });
});

// r2-08 N10: a refetch that brought changed data (a real-time event invalidates every identity
// query) reloaded the form and threw away the admin's unsaved edits.
describe('IdentityDetailPage while the admin edits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOperator = true;
    realProfileTab = false;
    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/identity/${ID}`)
        ? Promise.resolve({ data: identity })
        : Promise.resolve({ data: { identity: null } }),
    );
  });

  it('keeps unsaved edits when the identity changes elsewhere, and says so', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    const user = userEvent.setup();
    renderPage({}, queryClient);
    const jobTitle = await screen.findByLabelText('Job title');
    await waitFor(() => expect(jobTitle).toHaveValue('Analyst'));
    await user.clear(jobTitle);
    await user.type(jobTitle, 'Team lead');

    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/identity/${ID}`)
        ? Promise.resolve({ data: { ...identity, firstName: 'Maija-Liisa' } })
        : Promise.resolve({ data: { identity: null } }),
    );
    await queryClient.invalidateQueries({ queryKey: ['identity'] });

    expect(await screen.findByText(/changed while you were editing/)).toBeInTheDocument();
    expect(screen.getByLabelText('Job title')).toHaveValue('Team lead');
    expect(screen.getByLabelText('First name')).toHaveValue('Maija');
  });
});
