import React from 'react';
import { Form, Input, Button, Alert } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';

interface Props {
  loading: boolean;
  onSubmit: (values: { code: string }) => void;
  onBack: () => void;
}

export function MfaChallengeForm({ loading, onSubmit, onBack }: Props) {
  return (
    <Form onFinish={onSubmit} layout="vertical">
      <Alert
        type="info"
        message="Two-factor authentication required"
        description="Enter the 6-digit code from your authenticator app, or use a backup code."
        showIcon
        style={{ marginBottom: 16 }}
      />
      <Form.Item
        name="code"
        rules={[{ required: true, message: 'Enter your verification code' }]}
        label="Verification Code"
      >
        <Input
          prefix={<SafetyCertificateOutlined />}
          placeholder="000000"
          size="large"
          maxLength={10}
          autoFocus
        />
      </Form.Item>
      <Button type="primary" htmlType="submit" block size="large" loading={loading}>
        Verify
      </Button>
      <div style={{ textAlign: 'center', marginTop: 12 }}>
        <Button type="link" onClick={onBack}>
          Back to login
        </Button>
      </div>
    </Form>
  );
}
