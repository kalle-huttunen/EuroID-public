import React from 'react';
import { Form, Input, Button, Typography } from 'antd';
import { MailOutlined, LockOutlined, UserOutlined, KeyOutlined } from '@ant-design/icons';

const { Text } = Typography;

export interface RegisterValues {
  email: string;
  password: string;
  name: string;
  /** An invite code, or for the first account the server's SETUP_TOKEN when it has one. */
  inviteToken?: string;
}

interface Props {
  loading: boolean;
  /**
   * No admin account exists yet: this one becomes the super-admin, and the code field takes the
   * setup token, needed only when the server sets SETUP_TOKEN. Otherwise registering needs an
   * invite code from a super-admin.
   */
  firstAccount: boolean;
  onSubmit: (values: RegisterValues) => void;
  onSwitchToLogin: () => void;
}

export function RegisterForm({ loading, firstAccount, onSubmit, onSwitchToLogin }: Props) {
  return (
    <Form onFinish={onSubmit} layout="vertical">
      <Form.Item
        name="name"
        rules={[{ required: true, message: 'Full name is required' }]}
        label="Full name"
      >
        <Input
          prefix={<UserOutlined />}
          placeholder="Full name"
          size="large"
          aria-label="Full name"
        />
      </Form.Item>
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
        rules={[
          { required: true, min: 12, message: 'Password must be at least 12 characters' },
          {
            pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?])/,
            message: 'Must include uppercase, lowercase, number, and special character',
          },
        ]}
        label="Password"
      >
        <Input.Password
          prefix={<LockOutlined />}
          placeholder="Password (min 12 characters)"
          size="large"
          aria-label="Password"
        />
      </Form.Item>
      <Form.Item
        name="inviteToken"
        label={firstAccount ? 'Setup token' : 'Invite code'}
        extra={
          firstAccount
            ? 'Only if the server sets SETUP_TOKEN.'
            : 'From the administrator who invited you. Use the email address the invite was made for.'
        }
        rules={
          firstAccount
            ? []
            : [
                {
                  required: true,
                  whitespace: true,
                  message: 'Enter the invite code from your administrator',
                },
              ]
        }
      >
        <Input
          prefix={<KeyOutlined />}
          placeholder={firstAccount ? 'Setup token (optional)' : 'Invite code'}
          size="large"
          autoComplete="off"
        />
      </Form.Item>
      <Button type="primary" htmlType="submit" block size="large" loading={loading}>
        Create account
      </Button>
      <div style={{ textAlign: 'center', marginTop: 12 }}>
        <Button type="link" onClick={onSwitchToLogin}>
          Already have an account? Sign in
        </Button>
      </div>
      <Text type="secondary" style={{ display: 'block', marginTop: 16, fontSize: 12 }}>
        Data handled securely per GDPR.
      </Text>
    </Form>
  );
}
