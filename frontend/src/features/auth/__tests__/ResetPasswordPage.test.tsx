import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, mockAuthValue } from '../../../test/test-utils';
import { ResetPasswordPage } from '../ResetPasswordPage';

const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const signedOut = {
  ...mockAuthValue,
  user: null,
  isAuthenticated: false,
  isLoading: false,
} as unknown as typeof mockAuthValue;

const TOKEN = '3b9d1f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d';
const NEW_PASSWORD = 'NewPassword2@y';

type User = ReturnType<typeof userEvent.setup>;

async function fill(user: User, label: string, text: string) {
  await user.click(screen.getByLabelText(label));
  await user.paste(text);
}

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockResolvedValue({
      data: { success: true, message: 'Password changed. Sign in with your new password.' },
    });
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it(
    'takes the token from the link, clears it from the address bar and sets the password',
    { timeout: 30_000 },
    async () => {
      window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`);
      const user = userEvent.setup();
      renderWithProviders(<ResetPasswordPage />, { authValue: signedOut });

      expect(screen.getByText(/Using the reset link from your email/)).toBeInTheDocument();
      expect(screen.queryByLabelText('Reset code')).not.toBeInTheDocument();
      await waitFor(() => expect(window.location.hash).toBe(''));

      await fill(user, 'New password', NEW_PASSWORD);
      await fill(user, 'Repeat the new password', NEW_PASSWORD);
      await user.click(screen.getByRole('button', { name: 'Set new password' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringMatching(/\/api\/v1\/auth\/password-reset\/confirm$/),
          { token: TOKEN, newPassword: NEW_PASSWORD },
        ),
      );
      expect(await screen.findByText('Password changed')).toBeInTheDocument();
      expect(
        screen.getByText(/You were signed out everywhere; your MFA stays/),
      ).toBeInTheDocument();
      expect(document.body.textContent).not.toContain(TOKEN);
    },
  );

  it('takes a code a super-admin issued, typed in', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    renderWithProviders(<ResetPasswordPage />, { authValue: signedOut });

    await fill(user, 'Reset code', `  ${TOKEN} `);
    await fill(user, 'New password', NEW_PASSWORD);
    await fill(user, 'Repeat the new password', NEW_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Set new password' }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(expect.any(String), {
        token: TOKEN,
        newPassword: NEW_PASSWORD,
      }),
    );
  });

  it(
    'shows the API message when the code is refused and keeps the form',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      mockPost.mockRejectedValue({
        response: {
          status: 400,
          data: {
            message: 'This reset link or code is invalid, used or expired. Ask for a new one.',
          },
        },
      });
      renderWithProviders(<ResetPasswordPage />, { authValue: signedOut });

      await fill(user, 'Reset code', TOKEN);
      await fill(user, 'New password', NEW_PASSWORD);
      await fill(user, 'Repeat the new password', NEW_PASSWORD);
      await user.click(screen.getByRole('button', { name: 'Set new password' }));

      expect(
        await screen.findByText(
          'This reset link or code is invalid, used or expired. Ask for a new one.',
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Set new password' })).toBeInTheDocument();
    },
  );

  it(
    'refuses a weak or mismatched password before asking the API',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      renderWithProviders(<ResetPasswordPage />, { authValue: signedOut });

      await fill(user, 'Reset code', TOKEN);
      await fill(user, 'New password', 'short');
      await fill(user, 'Repeat the new password', 'other');
      await user.click(screen.getByRole('button', { name: 'Set new password' }));

      expect(
        await screen.findByText('Password must be at least 12 characters'),
      ).toBeInTheDocument();
      expect(screen.getByText('The passwords do not match')).toBeInTheDocument();
      expect(mockPost).not.toHaveBeenCalled();
    },
  );
});
