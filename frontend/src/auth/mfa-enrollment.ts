/**
 * A sign-in answered `mfa_enrollment_required`: the tenant requires MFA and the admin has none
 * (backend AuthLocalService.completeSignIn, for a password and a SAML sign-in alike). The answer's
 * `mfa_enrollment_token` can only set up MFA (MfaEnrollmentScopeGuard) and gives no session.
 */
import type { NavigateFunction } from 'react-router-dom';
import { setAccessToken, setRefreshToken, setTenantId } from './token-store';

/** Account security with its MFA setup wizard started (AccountSecurityPage `mfa_enrollment`). */
export const MFA_ENROLLMENT_PATH = '/settings/security?mfa_enrollment=true';

/**
 * Keeps the setup-only token in memory as the access token (no refresh token) and opens MFA
 * setup. The session is marked `mfaEnrollmentOnly` (LocalAuthProvider), so MfaEnrollmentGate
 * keeps the admin on MFA setup and LoginPage sends them there instead of to `/`.
 * AccountSecurityPage signs the admin out when the setup is done: they sign in again, now with
 * the MFA step.
 */
export function beginMfaEnrollment(
  enrollmentToken: string,
  user: { id: string; email: string; name: string; role: string; tenantId: string },
  navigate: NavigateFunction,
): void {
  setAccessToken(enrollmentToken);
  setRefreshToken(null);
  setTenantId(user.tenantId);
  window.dispatchEvent(
    new CustomEvent('euroid-login-success', { detail: { user, mfaEnrollmentOnly: true } }),
  );
  navigate(MFA_ENROLLMENT_PATH, { replace: true });
}
