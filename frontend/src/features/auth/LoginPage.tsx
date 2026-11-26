import React, { useState, useEffect, useRef } from 'react';
import { Card, Alert, Typography, message, theme } from 'antd';
import { useAuthContext } from '../../auth/auth-context';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { LoginResponseSchema } from '@api/schemas/auth-responses';
import { setAccessToken, setRefreshToken, setTenantId } from '../../auth/token-store';
import { getMfaToken, clearMfaToken } from '../../auth/mfa-token-store';
import { sanitizeSamlError } from '../../auth/auth-utils';
import { takeReturnUrl } from '../../auth/return-url-store';
import { beginMfaEnrollment, MFA_ENROLLMENT_PATH } from '../../auth/mfa-enrollment';
import { LoginForm } from './components/LoginForm';
import { RegisterForm, type RegisterValues } from './components/RegisterForm';
import { MfaChallengeForm } from './components/MfaChallengeForm';
import { ForgotPasswordForm } from './components/ForgotPasswordForm';

const { Title, Text } = Typography;

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string;
}

export function LoginPage() {
  const { token } = theme.useToken();
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  /** No admin account exists yet (setup status): the next registration is the super-admin. */
  const [firstAccount, setFirstAccount] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupLoading, setSetupLoading] = useState(true);
  const [samlEnabled, setSamlEnabled] = useState(false);
  const navigate = useNavigate();
  const auth = useAuthContext();
  const [searchParams] = useSearchParams();

  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(null);

  /** Where a sign-in goes: the page asked for before it (return-url-store.ts), else `/`. */
  const destination = useRef<string | null>(null);
  const takeDestination = () => (destination.current ??= takeReturnUrl());

  // A signed-in visitor leaves the sign-in page. A session that can only set up MFA goes to MFA
  // setup: this runs before beginMfaEnrollment's own navigation lands (that one is a transition),
  // so a plain `/` here would replace it. The page asked for is read once (the ref), so this
  // effect and the sign-in's own navigation go to the same place.
  useEffect(() => {
    if (!auth.isLoading && auth.isAuthenticated) {
      navigate(auth.mfaEnrollmentOnly ? MFA_ENROLLMENT_PATH : takeDestination(), { replace: true });
    }
  }, [auth.isLoading, auth.isAuthenticated, auth.mfaEnrollmentOnly, navigate]);

  useEffect(() => {
    if (auth.isAuthenticated) return;
    axiosInstance
      .get<{ hasAdminUsers: boolean }>(`${API_BASE}/auth/setup-status`)
      .then(({ data }) => {
        if (!data.hasAdminUsers) {
          setFirstAccount(true);
          setMode('register');
        }
      })
      .catch(() => setMode('login'))
      .finally(() => setSetupLoading(false));
  }, [auth.isAuthenticated]);

  useEffect(() => {
    axiosInstance
      .get<{ enabled: boolean }>(`${API_BASE}/auth/saml/config`)
      .then(({ data }) => setSamlEnabled(data.enabled))
      .catch(() => setSamlEnabled(false));
  }, []);

  useEffect(() => {
    const mfaParam = searchParams.get('mfa_required');
    if (mfaParam === 'true') {
      const storedToken = getMfaToken();
      if (storedToken) {
        setMfaRequired(true);
        setMfaToken(storedToken);
        clearMfaToken();
      }
    }
    const samlError = searchParams.get('saml_error');
    if (samlError) {
      setError(sanitizeSamlError(samlError) ?? 'An error occurred during sign-in.');
    }
  }, [searchParams]);

  const handleLoginSuccess = (data: {
    access_token?: string;
    refresh_token?: string;
    user: AuthUser;
  }) => {
    if (data.access_token) setAccessToken(data.access_token);
    if (data.refresh_token) setRefreshToken(data.refresh_token);
    setTenantId(data.user.tenantId);
    window.dispatchEvent(new CustomEvent('euroid-login-success', { detail: { user: data.user } }));
    navigate(takeDestination());
  };

  const extractError = (err: unknown, fallback: string): string => {
    if (err && typeof err === 'object' && 'response' in err) {
      return (
        (err as { response?: { data?: { message?: string } } }).response?.data?.message ?? fallback
      );
    }
    return fallback;
  };

  const buildUser = (u: {
    id: string;
    email: string;
    displayName?: string;
    role: string;
    tenantId?: string;
  }): AuthUser => ({
    id: u.id,
    email: u.email,
    name: u.displayName ?? u.email,
    role: u.role,
    tenantId: u.tenantId ?? '',
  });

  const onLogin = async (values: { email: string; password: string }) => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await axiosInstance.post<unknown>(`${API_BASE}/auth/login`, values);
      const parsed = LoginResponseSchema.safeParse(data);
      if (!parsed.success) {
        setError('Invalid response from server');
        return;
      }
      const p = parsed.data;

      if (p.mfa_required && p.mfa_token) {
        setMfaRequired(true);
        setMfaToken(p.mfa_token);
        return;
      }
      if (p.mfa_enrollment_required && p.mfa_enrollment_token && p.user) {
        beginMfaEnrollment(p.mfa_enrollment_token, buildUser(p.user), navigate);
        return;
      }
      if (p.user) {
        handleLoginSuccess({
          access_token: p.access_token,
          refresh_token: p.refresh_token,
          user: buildUser(p.user),
        });
        return;
      }
      setError('Invalid response from server');
    } catch (err: unknown) {
      setError(extractError(err, 'Invalid email or password'));
    } finally {
      setLoading(false);
    }
  };

  const onMfaChallenge = async (values: { code: string }) => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await axiosInstance.post<unknown>(`${API_BASE}/auth/mfa/challenge`, {
        mfa_token: mfaToken,
        code: values.code,
      });
      const parsed = LoginResponseSchema.safeParse(data);
      if (!parsed.success || !parsed.data.user) {
        setError('Invalid response from server');
        return;
      }
      handleLoginSuccess({
        access_token: parsed.data.access_token,
        refresh_token: parsed.data.refresh_token,
        user: buildUser(parsed.data.user),
      });
    } catch {
      setError('Invalid verification code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const onRegister = async ({ inviteToken, ...values }: RegisterValues) => {
    setLoading(true);
    setError(null);
    const code = inviteToken?.trim();
    try {
      await axiosInstance.post(`${API_BASE}/auth/register`, {
        ...values,
        ...(code ? { inviteToken: code } : {}),
      });
      message.success('Account created! Please sign in.');
      // An admin exists now: a further registration needs an invite.
      setFirstAccount(false);
      setMode('login');
    } catch (err: unknown) {
      setError(extractError(err, 'Registration failed'));
    } finally {
      setLoading(false);
    }
  };

  const cardStyle = { width: 400, boxShadow: token.boxShadowSecondary, borderRadius: 8 };
  const wrapStyle = {
    minHeight: '100vh',
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    background: token.colorBgLayout,
  };

  if (setupLoading) {
    return (
      <div style={wrapStyle}>
        <Card loading style={cardStyle} />
      </div>
    );
  }

  return (
    <div style={wrapStyle}>
      <Card style={cardStyle}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <SafetyCertificateOutlined style={{ fontSize: 48, color: token.colorPrimary }} />
          <Title level={3} style={{ marginTop: 8, marginBottom: 0 }}>
            EuroID
          </Title>
          <Text type="secondary">Identity Governance &amp; Administration</Text>
          <div style={{ marginTop: 4 }}>
            <Text type="secondary" italic>
              Schengen for your apps: one passport, no border checks.
            </Text>
          </div>
        </div>

        {mode === 'register' && firstAccount && (
          <Alert
            type="info"
            message="First account will be created as Super Admin"
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}
        {error && (
          <Alert
            type="error"
            message={error}
            showIcon
            closable
            onClose={() => setError(null)}
            style={{ marginBottom: 16 }}
          />
        )}

        {mfaRequired ? (
          <MfaChallengeForm
            loading={loading}
            onSubmit={onMfaChallenge}
            onBack={() => {
              setMfaRequired(false);
              setMfaToken(null);
              setError(null);
            }}
          />
        ) : mode === 'forgot' ? (
          <ForgotPasswordForm onBack={() => setMode('login')} />
        ) : mode === 'login' ? (
          <>
            <LoginForm
              loading={loading}
              samlEnabled={samlEnabled}
              onSubmit={onLogin}
              onSwitchToRegister={() => setMode('register')}
              onForgotPassword={() => {
                setError(null);
                setMode('forgot');
              }}
            />
            <Text type="secondary" style={{ display: 'block', marginTop: 16, fontSize: 12 }}>
              Data handled securely per GDPR.
            </Text>
          </>
        ) : (
          <RegisterForm
            loading={loading}
            firstAccount={firstAccount}
            onSubmit={onRegister}
            onSwitchToLogin={() => setMode('login')}
          />
        )}
      </Card>
    </div>
  );
}
