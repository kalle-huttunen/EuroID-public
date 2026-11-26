import React from 'react';
import { Form, Input, Button, Divider } from 'antd';
import { MailOutlined, LockOutlined, LoginOutlined } from '@ant-design/icons';
import { getReturnUrl } from '../../../auth/return-url-store';
import { API_BASE } from '@api/constants';

interface Props {
  loading: boolean;
  samlEnabled: boolean;
  onSubmit: (values: { email: string; password: string }) => void;
  onSwitchToRegister: () => void;
  onForgotPassword: () => void;
}

export function LoginForm({
  loading,
  samlEnabled,
  onSubmit,
  onSwitchToRegister,
  onForgotPassword,
}: Props) {
  return (
    <>
      <Form onFinish={onSubmit} layout="vertical">
        <Form.Item
          name="email"
          rules={[{ required: true, type: 'email', message: 'Enter a valid email' }]}
          label="Email"
        >
          <Input
            prefix={<MailOutlined />}
            placeholder="Email"
            size="large"
            aria-label="Email address"
          />
        </Form.Item>
        <Form.Item
          name="password"
          rules={[{ required: true, message: 'Password is required' }]}
          label="Password"
          extra={
            <Button type="link" size="small" style={{ padding: 0 }} onClick={onForgotPassword}>
              Forgot password?
            </Button>
          }
        >
          <Input.Password
            prefix={<LockOutlined />}
            placeholder="Password"
            size="large"
            aria-label="Password"
          />
        </Form.Item>
        <Button type="primary" htmlType="submit" block size="large" loading={loading}>
          Sign in
        </Button>
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <Button type="link" onClick={onSwitchToRegister}>
            Create an account
          </Button>
        </div>
      </Form>

      {samlEnabled && (
        <>
          <Divider plain>or</Divider>
          <Button
            block
            size="large"
            icon={<LoginOutlined />}
            onClick={() => {
              // The page asked for travels through the SAML RelayState (getReturnUrl: a path only)
              const returnUrl = getReturnUrl();
              const query = returnUrl ? `?returnUrl=${encodeURIComponent(returnUrl)}` : '';
              window.location.href = `${API_BASE}/auth/saml/login${query}`;
            }}
          >
            Sign in with SSO (SAML)
          </Button>
        </>
      )}
    </>
  );
}
