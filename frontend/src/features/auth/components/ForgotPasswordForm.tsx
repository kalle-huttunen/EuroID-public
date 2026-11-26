import React, { useState } from 'react';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { MailOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { requestPasswordReset, usePasswordResetConfig } from '@api/password-reset-api';
import { apiErrorMessage } from '../../dead-letter/dead-letter-labels';

const { Paragraph } = Typography;

/**
 * "Forgot password?" on the sign-in page. With email on, the admin asks for a link: the answer is
 * the API's own, the same whether or not the address has an account. Without email, a super-admin
 * issues a reset code. Either way the reset page takes the code.
 */
export function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const config = usePasswordResetConfig();
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async ({ email }: { email: string }) => {
    setLoading(true);
    setError(null);
    try {
      setAnswer((await requestPasswordReset(email)).message);
    } catch (err) {
      setError(apiErrorMessage(err, 'The request failed. Try again later.'));
    } finally {
      setLoading(false);
    }
  };

  const footer = (
    <div style={{ textAlign: 'center', marginTop: 12 }}>
      <Link to="/reset-password">I have a reset code</Link>
      <br />
      <Button type="link" onClick={onBack}>
        Back to sign in
      </Button>
    </div>
  );

  if (config.isLoading) return null;

  if (!config.data?.byEmail) {
    return (
      <>
        <Paragraph>
          This EuroID does not send email. Ask a super-admin of your organization for a password
          reset code, then enter it with your new password on the reset page.
        </Paragraph>
        {footer}
      </>
    );
  }

  return (
    <>
      <Paragraph>
        Enter the email address of your admin account. If it signs in with a password, EuroID emails
        it a link to set a new one.
      </Paragraph>
      {answer && <Alert type="success" showIcon message={answer} style={{ marginBottom: 16 }} />}
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
      {!answer && (
        <Form onFinish={submit} layout="vertical">
          <Form.Item
            name="email"
            label="Email"
            normalize={(value?: string) => value?.trim()}
            rules={[{ required: true, type: 'email', message: 'Enter a valid email' }]}
          >
            <Input
              prefix={<MailOutlined />}
              placeholder="Email"
              size="large"
              aria-label="Email address"
              autoComplete="email"
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={loading}>
            Send reset link
          </Button>
        </Form>
      )}
      {footer}
    </>
  );
}
