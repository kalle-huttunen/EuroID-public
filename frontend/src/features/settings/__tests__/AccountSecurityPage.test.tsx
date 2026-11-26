import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, mockAuthValue } from '../../../test/test-utils';
import { AccountSecurityPage } from '../AccountSecurityPage';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

/** MFA off until verify-setup turns it on; setup and verification answer as the API does. */
function serveMfa() {
  let enabled = false;
  mockGet.mockImplementation((url: string) => {
    if (url.endsWith('/auth/mfa/status')) {
      return Promise.resolve({
        data: { mfaEnabled: enabled, backupCodesRemaining: enabled ? 10 : 0 },
      });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  mockPost.mockImplementation((url: string) => {
    if (url.endsWith('/auth/mfa/setup')) {
      return Promise.resolve({
        data: { qrCodeDataUrl: 'data:image/png;base64,AAAA', manualEntryKey: 'JBSWY3DPEHPK3PXP' },
      });
    }
    if (url.endsWith('/auth/mfa/verify-setup')) {
      enabled = true;
      return Promise.resolve({ data: { backupCodes: ['code-1', 'code-2'] } });
    }
    return Promise.reject(new Error(`unexpected POST ${url}`));
  });
}

/** Through the setup wizard, already on its first step, to the backup codes and Done. */
async function completeSetup() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Next: Verify Code' }));
  await user.click(screen.getByLabelText('Verification Code'));
  await user.paste('123456');
  await user.click(screen.getByRole('button', { name: /Verify & Enable MFA/ }));
  await user.click(await screen.findByRole('button', { name: 'Done' }));
  return user;
}

describe('AccountSecurityPage MFA setup', () => {
  let signoutRedirect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    signoutRedirect = vi.fn();
    serveMfa();
  });

  // Reached with the setup-only token of a sign-in in a tenant that requires MFA. That token
  // gives no session, so once MFA is on the admin signs in again (password or SSO, then a code).
  it(
    'required enrollment: starts the setup, then signs out so the admin signs in with MFA',
    { timeout: 30_000 },
    async () => {
      renderWithProviders(<AccountSecurityPage />, {
        authValue: { ...mockAuthValue, signoutRedirect } as unknown as typeof mockAuthValue,
        initialRoute: '/settings/security?mfa_enrollment=true',
      });

      expect(await screen.findByText('MFA Required')).toBeInTheDocument();
      await completeSetup();

      await waitFor(() => expect(signoutRedirect).toHaveBeenCalledTimes(1));
      expect(mockPost).toHaveBeenCalledWith(expect.stringMatching(/\/auth\/mfa\/verify-setup$/), {
        code: '123456',
      });
    },
  );

  // Each POST /auth/mfa/setup stores a new secret (MfaService.setupMfa). With two requests open,
  // the QR code on screen holds the secret the API kept only if the answers come back in order.
  it(
    'required enrollment under StrictMode: one setup request, whose key the page shows',
    { timeout: 30_000 },
    async () => {
      const statusAnswers: Array<(value: unknown) => void> = [];
      mockGet.mockImplementation(() => new Promise((resolve) => statusAnswers.push(resolve)));
      const setupAnswers: Array<(value: unknown) => void> = [];
      mockPost.mockImplementation(() => new Promise((resolve) => setupAnswers.push(resolve)));
      const mfaOff = () => ({ data: { mfaEnabled: false, backupCodesRemaining: 0 } });

      // StrictMode at the root, as index.tsx renders the app: React runs the mount effects twice
      // in development (a StrictMode nested under a non-strict parent mounted with it does not).
      renderWithProviders(<AccountSecurityPage />, {
        initialRoute: '/settings/security?mfa_enrollment=true',
        reactStrictMode: true,
      });
      // The mount effect ran twice: two status requests.
      await waitFor(() => expect(statusAnswers).toHaveLength(2));
      await act(async () => statusAnswers[0](mfaOff()));
      await waitFor(() => expect(setupAnswers).toHaveLength(1));
      // The second status answer comes while the setup request is still open.
      await act(async () => statusAnswers[1](mfaOff()));
      await act(async () =>
        setupAnswers.forEach((answer, i) =>
          answer({
            data: { qrCodeDataUrl: 'data:image/png;base64,AAAA', manualEntryKey: `KEY${i + 1}` },
          }),
        ),
      );

      expect(setupAnswers).toHaveLength(1);
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(await screen.findByText('KEY1')).toBeInTheDocument();
    },
  );

  // MFA setup is the only page of an enrollment session (auth/MfaEnrollmentGate.tsx), shown
  // without the app's top bar and its Sign out.
  it('required enrollment: Sign out leaves the setup', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    renderWithProviders(<AccountSecurityPage />, {
      authValue: { ...mockAuthValue, signoutRedirect } as unknown as typeof mockAuthValue,
      initialRoute: '/settings/security?mfa_enrollment=true',
    });

    expect(await screen.findByText('MFA Required')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(signoutRedirect).toHaveBeenCalledTimes(1);
  });

  it('an admin who turns MFA on by choice stays signed in', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    renderWithProviders(<AccountSecurityPage />, {
      authValue: { ...mockAuthValue, signoutRedirect } as unknown as typeof mockAuthValue,
      initialRoute: '/settings/security',
    });

    await user.click(await screen.findByRole('button', { name: /Enable MFA/ }));
    await completeSetup();

    expect(await screen.findByText('Enabled')).toBeInTheDocument();
    expect(signoutRedirect).not.toHaveBeenCalled();
  });
});
