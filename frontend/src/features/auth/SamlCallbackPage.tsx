import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Spin, Result, Button } from 'antd';
import { setAccessToken, setRefreshToken, setTenantId } from '../../auth/token-store';
import { setMfaToken } from '../../auth/mfa-token-store';
import { beginMfaEnrollment } from '../../auth/mfa-enrollment';
import { sanitizeSamlError } from '../../auth/auth-utils';
import { setReturnUrl, takeReturnUrl } from '../../auth/return-url-store';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { LoginResponseSchema } from '@api/schemas/auth-responses';

export function SamlCallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const samlError = searchParams.get('saml_error');
    if (samlError) {
      const sanitized = sanitizeSamlError(samlError);
      queueMicrotask(() => setError(sanitized ?? 'An error occurred during sign-in.'));
      return;
    }

    const code = searchParams.get('code');
    if (!code) {
      queueMicrotask(() => setError('Missing authentication data from SSO provider.'));
      return;
    }

    // The page asked for, carried through the SAML RelayState; the store keeps a console path
    // only, and the MFA step on /login goes there too
    const returnUrl = searchParams.get('returnUrl');
    if (returnUrl) setReturnUrl(returnUrl);

    // Clear code from URL immediately to prevent leakage
    window.history.replaceState({}, document.title, window.location.pathname);

    const doExchange = async () => {
      try {
        const { data } = await axiosInstance.post<unknown>(`${API_BASE}/auth/saml/exchange`, {
          code,
        });
        const parsed = LoginResponseSchema.safeParse(data);
        if (!parsed.success) {
          setError('Invalid authentication response from SSO provider.');
          return;
        }
        const p = parsed.data;

        if (p.mfa_required && p.mfa_token) {
          setMfaToken(p.mfa_token);
          navigate('/login?mfa_required=true', { replace: true });
          return;
        }

        if (p.mfa_enrollment_required && p.mfa_enrollment_token && p.user) {
          const user = {
            id: p.user.id,
            email: p.user.email,
            name: p.user.displayName ?? p.user.email,
            role: p.user.role,
            tenantId: p.user.tenantId ?? '',
          };
          beginMfaEnrollment(p.mfa_enrollment_token, user, navigate);
          return;
        }

        if (p.access_token && p.refresh_token && p.user) {
          setAccessToken(p.access_token);
          setRefreshToken(p.refresh_token);
          setTenantId(p.user.tenantId ?? null);
          window.dispatchEvent(
            new CustomEvent('euroid-login-success', {
              detail: {
                user: {
                  id: p.user.id,
                  email: p.user.email,
                  name: p.user.displayName ?? p.user.email,
                  role: p.user.role,
                  tenantId: p.user.tenantId ?? '',
                },
              },
            }),
          );
          navigate(takeReturnUrl(), { replace: true });
          return;
        }

        setError('Invalid authentication response from SSO provider.');
      } catch {
        setError('Failed to complete SSO sign-in. The link may have expired.');
      }
    };

    doExchange();
  }, [searchParams, navigate]);

  if (error) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Result
          status="error"
          title="SSO Sign-in Failed"
          subTitle={error}
          extra={
            <Button type="primary" onClick={() => navigate('/login')}>
              Back to Login
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Spin size="large" tip="Completing SSO sign in..." />
    </div>
  );
}
