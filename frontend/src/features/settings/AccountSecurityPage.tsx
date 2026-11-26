import React, { useEffect, useRef, useState } from 'react';
import {
  Card,
  Button,
  Typography,
  Alert,
  Space,
  Badge,
  Input,
  Form,
  Modal,
  message,
  Steps,
  Divider,
  theme,
} from 'antd';
import {
  SafetyCertificateOutlined,
  LockOutlined,
  CopyOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { useAuthContext } from '../../auth/auth-context';
import { PageContainer, PageHeader } from '@shared/PageHeader';

const { Title, Text, Paragraph } = Typography;

interface MfaStatus {
  mfaEnabled: boolean;
  backupCodesRemaining: number;
}

export function AccountSecurityPage() {
  const { token } = theme.useToken();
  const [searchParams] = useSearchParams();
  const auth = useAuthContext();
  const [mfaStatus, setMfaStatus] = useState<MfaStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // MFA setup wizard state
  const [setupStep, setSetupStep] = useState(-1); // -1 = not started
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [manualEntryKey, setManualEntryKey] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [setupLoading, setSetupLoading] = useState(false);

  // Disable/Regenerate modal
  const [disableModalOpen, setDisableModalOpen] = useState(false);
  const [regenModalOpen, setRegenModalOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Change password
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordForm] = Form.useForm();

  const enrollmentRequired = searchParams.get('mfa_enrollment') === 'true';
  // Each POST /auth/mfa/setup stores a new secret, so a required enrollment starts the setup once
  // per visit: with two requests open, the QR code on screen matches the stored secret only if
  // the answers come back in order. The status is fetched twice under StrictMode, and each new
  // status object re-runs the effect below.
  const enrollmentSetupStarted = useRef(false);

  useEffect(() => {
    fetchMfaStatus();
  }, []);

  useEffect(() => {
    if (enrollmentSetupStarted.current) return;
    if (enrollmentRequired && mfaStatus && !mfaStatus.mfaEnabled && setupStep === -1) {
      enrollmentSetupStarted.current = true;
      startSetup();
    }
  }, [enrollmentRequired, mfaStatus, setupStep]);

  const fetchMfaStatus = async () => {
    try {
      const { data } = await axiosInstance.get<MfaStatus>(`${API_BASE}/auth/mfa/status`);
      setMfaStatus(data);
    } catch {
      message.error('Failed to load MFA status');
    } finally {
      setLoading(false);
    }
  };

  const startSetup = async () => {
    setSetupLoading(true);
    try {
      const { data } = await axiosInstance.post<{
        qrCodeDataUrl: string;
        manualEntryKey: string;
      }>(`${API_BASE}/auth/mfa/setup`);
      setQrCodeDataUrl(data.qrCodeDataUrl);
      setManualEntryKey(data.manualEntryKey);
      setSetupStep(0);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        'Failed to start MFA setup';
      message.error(msg);
    } finally {
      setSetupLoading(false);
    }
  };

  const verifySetup = async (values: { code: string }) => {
    setSetupLoading(true);
    try {
      const { data } = await axiosInstance.post<{ backupCodes: string[] }>(
        `${API_BASE}/auth/mfa/verify-setup`,
        { code: values.code },
      );
      setBackupCodes(data.backupCodes);
      setSetupStep(2);
      message.success('MFA enabled successfully!');
      fetchMfaStatus();
    } catch {
      message.error('Invalid code. Please try again.');
    } finally {
      setSetupLoading(false);
    }
  };

  const disableMfa = async (values: { code: string }) => {
    setActionLoading(true);
    try {
      await axiosInstance.post(`${API_BASE}/auth/mfa/disable`, { code: values.code });
      message.success('MFA disabled');
      setDisableModalOpen(false);
      setSetupStep(-1);
      setBackupCodes([]);
      fetchMfaStatus();
    } catch {
      message.error('Invalid code. Please try again.');
    } finally {
      setActionLoading(false);
    }
  };

  const regenerateBackupCodes = async (values: { code: string }) => {
    setActionLoading(true);
    try {
      const { data } = await axiosInstance.post<{ backupCodes: string[] }>(
        `${API_BASE}/auth/mfa/backup-codes`,
        { code: values.code },
      );
      setBackupCodes(data.backupCodes);
      setRegenModalOpen(false);
      message.success('Backup codes regenerated');
      fetchMfaStatus();
    } catch {
      message.error('Invalid code. Please try again.');
    } finally {
      setActionLoading(false);
    }
  };

  const changePassword = async (values: { currentPassword: string; newPassword: string }) => {
    setPasswordLoading(true);
    try {
      await axiosInstance.post(`${API_BASE}/auth/change-password`, values);
      message.success('Password changed successfully. Please sign in again.');
      passwordForm.resetFields();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        'Failed to change password';
      message.error(msg);
    } finally {
      setPasswordLoading(false);
    }
  };

  const copyBackupCodes = () => {
    navigator.clipboard.writeText(backupCodes.join('\n'));
    message.success('Backup codes copied to clipboard');
  };

  const header = (
    <PageHeader
      title="Account security"
      subtitle="Two-factor authentication and password for your EuroID account."
    />
  );

  if (loading) {
    return (
      <PageContainer>
        {header}
        <Card loading style={{ maxWidth: 640 }} />
      </PageContainer>
    );
  }

  // MFA setup wizard
  if (setupStep >= 0 && setupStep < 3) {
    return (
      <PageContainer>
        {header}
        <div style={{ maxWidth: 640 }}>
          {enrollmentRequired && (
            <Alert
              type="warning"
              message="MFA Required"
              description="Your organization requires multi-factor authentication. Complete the setup below, then sign in again."
              showIcon
              // The only page of an enrollment session (auth/MfaEnrollmentGate.tsx): its way out.
              action={
                <Button size="small" onClick={() => void auth.signoutRedirect?.()}>
                  Sign out
                </Button>
              }
              style={{ marginBottom: 16 }}
            />
          )}

          <Card>
            <Title level={4} style={{ marginTop: 0 }}>
              <SafetyCertificateOutlined /> Set up two-factor authentication
            </Title>

            <Steps
              current={setupStep}
              items={[
                { title: 'Scan QR code' },
                { title: 'Verify code' },
                { title: 'Backup codes' },
              ]}
              style={{ marginBottom: 24 }}
            />

            {setupStep === 0 && (
              <div style={{ textAlign: 'center' }}>
                <Paragraph>
                  Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)
                </Paragraph>
                {qrCodeDataUrl && (
                  <img
                    src={qrCodeDataUrl}
                    alt="MFA QR Code"
                    style={{ width: 200, height: 200, margin: '16px 0' }}
                  />
                )}
                <Paragraph type="secondary">Can't scan? Enter this key manually:</Paragraph>
                <Paragraph code copyable style={{ fontSize: 14 }}>
                  {manualEntryKey}
                </Paragraph>
                <Button type="primary" onClick={() => setSetupStep(1)} style={{ marginTop: 16 }}>
                  Next: Verify Code
                </Button>
              </div>
            )}

            {setupStep === 1 && (
              <Form onFinish={verifySetup} layout="vertical">
                <Paragraph>
                  Enter the 6-digit code from your authenticator app to verify setup.
                </Paragraph>
                <Form.Item
                  name="code"
                  label="Verification Code"
                  rules={[{ required: true, message: 'Enter the 6-digit code' }]}
                >
                  <Input
                    placeholder="000000"
                    size="large"
                    maxLength={6}
                    autoFocus
                    style={{ maxWidth: 200, textAlign: 'center', letterSpacing: 4 }}
                  />
                </Form.Item>
                <Space>
                  <Button onClick={() => setSetupStep(0)}>Back</Button>
                  <Button type="primary" htmlType="submit" loading={setupLoading}>
                    Verify & Enable MFA
                  </Button>
                </Space>
              </Form>
            )}

            {setupStep === 2 && (
              <div>
                <Alert
                  type="success"
                  message="MFA Enabled!"
                  description="Save these backup codes in a safe place. Each code can only be used once."
                  showIcon
                  style={{ marginBottom: 16 }}
                />
                <Card
                  size="small"
                  extra={
                    <Button icon={<CopyOutlined />} size="small" onClick={copyBackupCodes}>
                      Copy All
                    </Button>
                  }
                >
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: 8,
                      fontFamily: token.fontFamilyCode,
                      fontSize: 14,
                    }}
                  >
                    {backupCodes.map((code, i) => (
                      <div key={i}>{code}</div>
                    ))}
                  </div>
                </Card>
                <Button
                  type="primary"
                  onClick={() => {
                    setSetupStep(-1);
                    setBackupCodes([]);
                    // A required enrollment runs on a token that can only set up MFA, not a
                    // session (auth/mfa-enrollment.ts): the admin signs in again, now with MFA.
                    if (enrollmentRequired) {
                      message.success(
                        'MFA is on. Sign in again: EuroID now asks for a code from your authenticator app.',
                      );
                      void auth.signoutRedirect?.();
                    }
                  }}
                  style={{ marginTop: 16 }}
                >
                  Done
                </Button>
              </div>
            )}
          </Card>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}
      <div style={{ maxWidth: 640 }}>
        {/* MFA Section */}
        <Card style={{ marginBottom: 16 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <Text strong>Two-factor authentication (MFA)</Text>
                <br />
                <Text type="secondary">
                  Add an extra layer of security with TOTP-based verification.
                </Text>
              </div>
              <Badge
                status={mfaStatus?.mfaEnabled ? 'success' : 'default'}
                text={mfaStatus?.mfaEnabled ? 'Enabled' : 'Disabled'}
              />
            </div>

            {mfaStatus?.mfaEnabled ? (
              <>
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <Text type="secondary">
                    Backup codes remaining: {mfaStatus.backupCodesRemaining}
                  </Text>
                  <Space>
                    <Button size="small" onClick={() => setRegenModalOpen(true)}>
                      Regenerate Backup Codes
                    </Button>
                    <Button size="small" danger onClick={() => setDisableModalOpen(true)}>
                      Disable MFA
                    </Button>
                  </Space>
                </div>
                {mfaStatus.backupCodesRemaining <= 2 && (
                  <Alert
                    type="warning"
                    message="Low backup codes"
                    description="You have very few backup codes remaining. Consider regenerating them."
                    showIcon
                  />
                )}
              </>
            ) : (
              <Button
                type="primary"
                icon={<SafetyCertificateOutlined />}
                onClick={startSetup}
                loading={setupLoading}
              >
                Enable MFA
              </Button>
            )}
          </Space>
        </Card>

        {/* Change Password Section */}
        <Card>
          <Title level={5}>
            <LockOutlined /> Change Password
          </Title>
          <Form form={passwordForm} onFinish={changePassword} layout="vertical">
            <Form.Item
              name="currentPassword"
              label="Current Password"
              rules={[{ required: true, message: 'Enter your current password' }]}
            >
              <Input.Password size="large" placeholder="Current password" />
            </Form.Item>
            <Form.Item
              name="newPassword"
              label="New Password"
              rules={[
                { required: true, min: 12, message: 'Password must be at least 12 characters' },
                {
                  pattern:
                    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?])/,
                  message: 'Must include uppercase, lowercase, number, and special character',
                },
              ]}
            >
              <Input.Password size="large" placeholder="New password (min 12 characters)" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={passwordLoading}>
              Change Password
            </Button>
          </Form>
        </Card>

        {/* Backup codes display (after regeneration) */}
        {backupCodes.length > 0 && (
          <Card style={{ marginTop: 16 }}>
            <Alert
              type="info"
              message="New Backup Codes"
              description="Save these backup codes in a safe place. Each code can only be used once."
              showIcon
              style={{ marginBottom: 12 }}
            />
            <Card
              size="small"
              extra={
                <Button icon={<CopyOutlined />} size="small" onClick={copyBackupCodes}>
                  Copy All
                </Button>
              }
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 8,
                  fontFamily: token.fontFamilyCode,
                  fontSize: 14,
                }}
              >
                {backupCodes.map((code, i) => (
                  <div key={i}>{code}</div>
                ))}
              </div>
            </Card>
            <Button size="small" onClick={() => setBackupCodes([])} style={{ marginTop: 8 }}>
              Dismiss
            </Button>
          </Card>
        )}

        {/* Disable MFA Modal */}
        <Modal
          title="Disable MFA"
          open={disableModalOpen}
          onCancel={() => setDisableModalOpen(false)}
          footer={null}
        >
          <Alert
            type="warning"
            message="This will remove two-factor authentication from your account."
            showIcon
            style={{ marginBottom: 16 }}
          />
          <Form onFinish={disableMfa} layout="vertical">
            <Form.Item
              name="code"
              label="Enter your current TOTP code or a backup code"
              rules={[{ required: true, message: 'Verification code is required' }]}
            >
              <Input placeholder="000000" maxLength={10} autoFocus />
            </Form.Item>
            <Space>
              <Button onClick={() => setDisableModalOpen(false)}>Cancel</Button>
              <Button type="primary" danger htmlType="submit" loading={actionLoading}>
                Disable MFA
              </Button>
            </Space>
          </Form>
        </Modal>

        {/* Regenerate Backup Codes Modal */}
        <Modal
          title="Regenerate Backup Codes"
          open={regenModalOpen}
          onCancel={() => setRegenModalOpen(false)}
          footer={null}
        >
          <Paragraph>
            This will invalidate all existing backup codes and generate new ones. Enter your current
            TOTP code to confirm.
          </Paragraph>
          <Form onFinish={regenerateBackupCodes} layout="vertical">
            <Form.Item
              name="code"
              label="Verification Code"
              rules={[{ required: true, message: 'Verification code is required' }]}
            >
              <Input placeholder="000000" maxLength={6} autoFocus />
            </Form.Item>
            <Space>
              <Button onClick={() => setRegenModalOpen(false)}>Cancel</Button>
              <Button type="primary" htmlType="submit" loading={actionLoading}>
                Regenerate
              </Button>
            </Space>
          </Form>
        </Modal>
      </div>
    </PageContainer>
  );
}
