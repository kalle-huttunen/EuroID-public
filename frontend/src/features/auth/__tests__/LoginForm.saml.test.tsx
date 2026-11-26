import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from '../components/LoginForm';
import { setReturnUrl } from '../../../auth/return-url-store';

/**
 * Sign in with SSO: the page a signed-out visitor asked for (return-url-store) goes to
 * GET /auth/saml/login as returnUrl, which the API carries through the SAML RelayState.
 */
describe('LoginForm SSO button', () => {
  let href = '';
  const original = window.location;

  beforeEach(() => {
    href = '';
    window.sessionStorage.clear();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...original,
        get href() {
          return href;
        },
        set href(value: string) {
          href = value;
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });

  const renderForm = () =>
    render(
      <LoginForm
        loading={false}
        samlEnabled
        onSubmit={vi.fn()}
        onSwitchToRegister={vi.fn()}
        onForgotPassword={vi.fn()}
      />,
    );

  it('sends the page asked for as returnUrl', async () => {
    setReturnUrl('/identities/abc?tab=access');
    renderForm();

    await userEvent.click(screen.getByRole('button', { name: /sign in with sso/i }));

    expect(href).toBe(
      `/api/v1/auth/saml/login?returnUrl=${encodeURIComponent('/identities/abc?tab=access')}`,
    );
  });

  it('sends no returnUrl when no page was asked for', async () => {
    renderForm();

    await userEvent.click(screen.getByRole('button', { name: /sign in with sso/i }));

    expect(href).toBe('/api/v1/auth/saml/login');
  });
});
