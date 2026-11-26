/**
 * Set a new console password with a reset token: from the emailed link (`/reset-password#token=`)
 * or a code a super-admin issued, typed in. The token is read from the URL fragment, which the
 * browser never sends to a server or in a Referer, and is removed from the address bar at once;
 * it lives in this page's state only. A reset signs nobody in: the admin then signs in with the new
 * password (and MFA, which stays as it was).
 */
import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, Result, Typography, theme } from 'antd';
import { KeyOutlined, LockOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { confirmPasswordReset } from '@api/password-reset-api';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Title, Text, Paragraph } = Typography;

/** Same rule as the API (STRONG_PASSWORD_SCHEMA) and the registration form. */
const PASSWORD_RULES = [
  { required: true, min: 12, message: 'Password must be at least 12 characters' },
  { max: 128, message: 'Password must be at most 128 characters' },
  {
    pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?])/,
    message: 'Must include uppercase, lowercase, number, and special character',
  },
];

/** The token in the link's `#token=...` fragment, if any. */
function tokenFromLink(): string | null {
  const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
  return token?.trim() || null;
}

interface FormValues {
  code?: string;
  newPassword: string;
  confirmPassword: string;
}

export function ResetPasswordPage() {
  const { token: themeToken } = theme.useToken();
  const navigate = useNavigate();
  const [linkToken, setLinkToken] = useState<string | null>(tokenFromLink);

  // Out of the address bar and the history once read: the page state holds it from here on.
  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, document.title, window.location.pathname);
    }
  }, []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (values: FormValues) => {
    const token = linkToken ?? values.code?.trim() ?? '';
    setLoading(true);
    setError(null);
    try {
      await confirmPasswordReset(token, values.newPassword);
      setLinkToken(null);
      setDone(true);
    } catch (err) {
      setError(apiErrorMessage(err, 'The password was not changed. Try again.'));
    } finally {
      setLoading(false);
    }
  };

  const wrapStyle: React.CSSProperties = {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    background: themeToken.colorBgLayout,
  };
  const cardStyle: React.CSSProperties = {
    width: 400,
    maxWidth: '100%',
    boxShadow: themeToken.boxShadowSecondary,
    borderRadius: 8,
  };

  return (
    <div style={wrapStyle}>
      <Card style={cardStyle}>
        {done ? (
          <Result
            status="success"
            title="Password changed"
            subTitle="Sign in with your new password. You were signed out everywhere; your MFA stays as it was."
            extra={
              <Button type="primary" onClick={() => navigate('/login', { replace: true })}>
                Sign in
              </Button>
            }
          />
        ) : (
          <>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <SafetyCertificateOutlined style={{ fontSize: 48, color: themeToken.colorPrimary }} />
              <Title level={3} style={{ marginTop: 8, marginBottom: 0 }}>
                Set a new password
              </Title>
              <Text type="secondary">EuroID admin account</Text>
            </div>
            {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
            <Form<FormValues> onFinish={submit} layout="vertical">
              {linkToken ? (
                <Paragraph>
                  Using the reset link from your email.{' '}
                  <Button type="link" style={{ padding: 0 }} onClick={() => setLinkToken(null)}>
                    Enter a code instead
                  </Button>
                </Paragraph>
              ) : (
                <Form.Item
                  name="code"
                  label="Reset code"
                  extra="From the reset email, or from a super-admin of your organization."
                  rules={[{ required: true, whitespace: true, message: 'Enter the reset code' }]}
                >
                  <Input prefix={<KeyOutlined />} size="large" autoComplete="off" />
                </Form.Item>
              )}
              <Form.Item name="newPassword" label="New password" rules={PASSWORD_RULES}>
                <Input.Password
                  prefix={<LockOutlined />}
                  size="large"
                  autoComplete="new-password"
                  placeholder="At least 12 characters"
                />
              </Form.Item>
              <Form.Item
                name="confirmPassword"
                label="Repeat the new password"
                dependencies={['newPassword']}
                rules={[
                  { required: true, message: 'Repeat the new password' },
                  ({ getFieldValue }) => ({
                    validator: (_, value?: string) =>
                      !value || value === getFieldValue('newPassword')
                        ? Promise.resolve()
                        : Promise.reject(new Error('The passwords do not match')),
                  }),
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined />}
                  size="large"
                  autoComplete="new-password"
                />
              </Form.Item>
              <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                Set new password
              </Button>
            </Form>
            <Paragraph type="secondary" style={{ marginTop: 16, fontSize: 12 }}>
              Setting the password signs you out on every device. It does not sign you in.
            </Paragraph>
            <div style={{ textAlign: 'center' }}>
              <Button type="link" onClick={() => navigate('/login')}>
                Back to sign in
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
