import React from 'react';
import { render, RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider, App as AntdApp, type ThemeConfig } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../auth/auth-context';

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
    access_token: 'dev-token-not-a-real-jwt',
  },
  isAuthenticated: true,
  isLoading: false,
  signoutRedirect: undefined,
  signinRedirect: undefined,
};

interface TestProviderOptions {
  authValue?: typeof mockAuthValue;
  initialRoute?: string;
}

/**
 * Without antd's hashed class scope, every antd style rule is a plain class selector instead of
 * one prefixed with `:where(.css-<hash>)`. jsdom matches every rule against an element in
 * getComputedStyle, which role queries and user-event call for each element they check, and the
 * prefixed selectors take its slow path: the heavy page tests run about 40 % faster without them.
 * A test renders a single theme, so the scope never told two elements apart.
 */
const TEST_THEME: ThemeConfig = { hashed: false };

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(
  ui: React.ReactElement,
  options?: TestProviderOptions & Omit<RenderOptions, 'wrapper'>,
) {
  const { authValue = mockAuthValue, initialRoute = '/', ...renderOptions } = options || {};
  const queryClient = createTestQueryClient();

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={authValue}>
          <MemoryRouter initialEntries={[initialRoute]}>
            <ConfigProvider theme={TEST_THEME}>
              <AntdApp>{children}</AntdApp>
            </ConfigProvider>
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>
    );
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}

export { mockAuthValue };
