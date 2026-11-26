import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from '../ProtectedRoute';
import { renderWithProviders, mockAuthValue } from '../../test/test-utils';

describe('ProtectedRoute', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_DISABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const signedOut = {
    ...mockAuthValue,
    isAuthenticated: false,
    isLoading: false,
    user: null,
  } as unknown as typeof mockAuthValue;

  const withRoles = (roles: string[]) => ({
    ...mockAuthValue,
    user: { ...mockAuthValue.user, profile: { ...mockAuthValue.user.profile, roles } },
  });

  it('in dev mode: renders children immediately without redirect', () => {
    render(
      <ProtectedRoute>
        <div data-testid="protected-content">Protected</div>
      </ProtectedRoute>,
    );
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.getByText('Protected')).toBeInTheDocument();
  });

  it('when authenticated: renders children', () => {
    vi.stubEnv('VITE_AUTH_DISABLED', 'false');
    renderWithProviders(
      <ProtectedRoute>
        <div data-testid="protected-content">Protected</div>
      </ProtectedRoute>,
    );
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
  });

  it('when not authenticated: shows redirecting state', () => {
    vi.stubEnv('VITE_AUTH_DISABLED', 'false');
    const onNotAuthenticated = vi.fn();
    renderWithProviders(
      <ProtectedRoute onNotAuthenticated={onNotAuthenticated}>
        <div data-testid="protected-content">Protected</div>
      </ProtectedRoute>,
      {
        authValue: {
          ...mockAuthValue,
          isAuthenticated: false,
          isLoading: false,
          user: null,
        } as typeof mockAuthValue,
      },
    );
    // When not authenticated: ProtectedRoute shows fullscreen spinner and starts the sign-in
    expect(screen.getByText('Redirecting to sign in...')).toBeInTheDocument();
    expect(onNotAuthenticated).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('when isLoading: shows spinner', () => {
    vi.stubEnv('VITE_AUTH_DISABLED', 'false');
    const onNotAuthenticated = vi.fn();
    const { container } = renderWithProviders(
      <ProtectedRoute onNotAuthenticated={onNotAuthenticated}>
        <div data-testid="protected-content">Protected</div>
      </ProtectedRoute>,
      { authValue: { ...signedOut, isLoading: true } },
    );
    // While the session is still loading: a spinner, no redirect yet and no verdict on access.
    expect(container.querySelector('.ant-spin')).toBeInTheDocument();
    expect(onNotAuthenticated).not.toHaveBeenCalled();
    expect(screen.queryByText('Redirecting to sign in...')).not.toBeInTheDocument();
    expect(screen.queryByText('Access Denied')).not.toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('with requiredRole: renders children when user has role', () => {
    vi.stubEnv('VITE_AUTH_DISABLED', 'false');
    renderWithProviders(
      <ProtectedRoute requiredRole="super-admin">
        <div data-testid="protected-content">Protected</div>
      </ProtectedRoute>,
    );
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
  });

  it('with requiredRole: blocks when user lacks role', () => {
    vi.stubEnv('VITE_AUTH_DISABLED', 'false');
    renderWithProviders(
      <ProtectedRoute requiredRole="super-admin">
        <div data-testid="protected-content">Protected</div>
      </ProtectedRoute>,
      {
        authValue: {
          ...mockAuthValue,
          user: {
            ...mockAuthValue.user!,
            profile: {
              ...mockAuthValue.user!.profile,
              roles: ['viewer'],
            },
          },
        },
      },
    );
    expect(screen.getByText('Access Denied')).toBeInTheDocument();
    expect(screen.getByText('You do not have permission to view this page.')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it.each([
    ['operator', 'policy-admin', false],
    ['policy-admin', 'operator', true],
    ['connector-admin', 'policy-admin', false],
    ['connector-admin', 'operator', true],
    ['auditor', 'viewer', false], // a role the hierarchy does not know grants nothing
  ])('with requiredRole: a %s may open a %s page: %s', (role, requiredRole, allowed) => {
    vi.stubEnv('VITE_AUTH_DISABLED', 'false');
    renderWithProviders(
      <ProtectedRoute requiredRole={requiredRole}>
        <div data-testid="protected-content">Protected</div>
      </ProtectedRoute>,
      { authValue: withRoles([role]) },
    );
    expect({
      shown: screen.queryByTestId('protected-content') !== null,
      denied: screen.queryByText('Access Denied') !== null,
    }).toEqual({ shown: allowed, denied: !allowed });
  });

  // The bypass is `DEV && VITE_AUTH_DISABLED`: a production build with the flag set still signs in.
  it('outside a dev build ignores VITE_AUTH_DISABLED and sends a signed-out visitor to /login', () => {
    vi.stubEnv('VITE_AUTH_DISABLED', 'true');
    vi.stubEnv('DEV', false);
    renderWithProviders(
      <Routes>
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <div data-testid="protected-content">Protected</div>
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<div>Sign-in page</div>} />
      </Routes>,
      { authValue: signedOut },
    );
    expect(screen.getByText('Sign-in page')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });
});
