/**
 * SCIM Settings — Admin UI for SCIM token management and endpoint information.
 * Super-admin only.
 */
import React, { useState } from 'react';
import {
  Card,
  Table,
  Button,
  Modal,
  Form,
  Input,
  Checkbox,
  DatePicker,
  Tag,
  Popconfirm,
  Typography,
  Alert,
  Space,
  message,
  Skeleton,
  theme,
} from 'antd';
import { PlusOutlined, CopyOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { ColumnsType } from 'antd/es/table';
import {
  useScimTokens,
  useGenerateScimToken,
  useRevokeScimToken,
  type ScimTokenMetadata,
  type GenerateScimTokenResponse,
} from '@api/scim-api';
import { API_BASE } from '@api/constants';
import { relativeTimeNullable } from '../../utils/date-helpers';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Title, Text } = Typography;

const SCOPE_OPTIONS = [
  { label: 'Users:read', value: 'Users:read' },
  { label: 'Users:write', value: 'Users:write' },
  { label: 'Groups:read', value: 'Groups:read' },
  { label: 'Groups:write', value: 'Groups:write' },
];

const DEFAULT_SCOPES = ['Users:read', 'Users:write', 'Groups:read', 'Groups:write'];

function formatDate(iso: string): string {
  return dayjs(iso).format('YYYY-MM-DD');
}

function abbreviateScopes(scopes: string[]): string {
  const hasUr = scopes.includes('Users:read');
  const hasUw = scopes.includes('Users:write');
  const hasGr = scopes.includes('Groups:read');
  const hasGw = scopes.includes('Groups:write');
  const u = [hasUr && 'r', hasUw && 'w'].filter(Boolean).join('') || '-';
  const g = [hasGr && 'r', hasGw && 'w'].filter(Boolean).join('') || '-';
  if (u === '-' && g === '-') return '-';
  return `U:${u},G:${g}`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '..';
}

function getScimBaseUrl(): string {
  // SCIM endpoints are on the API server (same origin as API_BASE, but path /scim/v2/, outside
  // the /api/v1 prefix). API_BASE is relative in a same-origin deployment: resolve it against the
  // console's own origin.
  return `${new URL(API_BASE, window.location.origin).origin}/scim/v2/`;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const SCIMSettings: React.FC = () => {
  const { token } = theme.useToken();
  const [generateModalOpen, setGenerateModalOpen] = useState(false);
  const [successModalOpen, setSuccessModalOpen] = useState(false);
  const [generatedToken, setGeneratedToken] = useState<GenerateScimTokenResponse | null>(null);

  const [form] = Form.useForm();
  const { data: tokens = [], isLoading } = useScimTokens();
  const generateMutation = useGenerateScimToken();
  const revokeMutation = useRevokeScimToken();

  const activeTokens = tokens.filter((t) => t.status === 'active');

  const handleGenerateOpen = () => {
    form.resetFields();
    form.setFieldsValue({ scopes: DEFAULT_SCOPES });
    setGenerateModalOpen(true);
  };

  const handleGenerateSubmit = async () => {
    try {
      const values = await form.validateFields();
      const result = await generateMutation.mutateAsync({
        name: values.name.trim(),
        scopes: values.scopes,
        expiresAt: values.expiresAt ? values.expiresAt.toISOString() : undefined,
      });
      setGeneratedToken(result);
      setGenerateModalOpen(false);
      setSuccessModalOpen(true);
      message.success('Token generated');
    } catch (err: unknown) {
      const msg = apiErrorMessage(err, 'Failed to generate token');
      message.error(msg);
    }
  };

  const handleCopyToken = async () => {
    if (!generatedToken?.token) return;
    const ok = await copyToClipboard(generatedToken.token);
    if (ok) message.success('Token copied to clipboard');
    else message.error('Failed to copy');
  };

  const handleSuccessDone = () => {
    setSuccessModalOpen(false);
    setGeneratedToken(null);
  };

  const handleRevoke = async (id: string, name: string) => {
    try {
      await revokeMutation.mutateAsync(id);
      message.success(`Token "${name}" revoked`);
    } catch (err: unknown) {
      message.error(apiErrorMessage(err, 'Failed to revoke token'));
    }
  };

  const columns: ColumnsType<ScimTokenMetadata> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: 'Created By',
      dataIndex: 'createdBy',
      key: 'createdBy',
      render: (v: string) => truncate(v, 12),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: string) => formatDate(v),
    },
    {
      title: 'Last Used',
      dataIndex: 'lastUsedAt',
      key: 'lastUsedAt',
      render: (v: string | undefined) => relativeTimeNullable(v ?? null),
    },
    {
      title: 'Scopes',
      dataIndex: 'scopes',
      key: 'scopes',
      render: (scopes: string[]) => <Tag color="blue">{abbreviateScopes(scopes)}</Tag>,
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Popconfirm
          title="Revoke token"
          description={
            <>
              Are you sure you want to revoke token &quot;{record.name}&quot;? External systems
              using this token will immediately lose access.
            </>
          }
          onConfirm={() => handleRevoke(record.id, record.name)}
          okText="Revoke"
          cancelText="Cancel"
          okButtonProps={{ danger: true }}
        >
          <Button type="link" size="small" danger>
            Revoke
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const baseUrl = getScimBaseUrl();

  const curlDiscovery = `curl -H "Authorization: Bearer YOUR_TOKEN" \\
  ${baseUrl}ServiceProviderConfig`;

  const curlCreateUser = `curl -X POST -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/scim+json" \\
  -d '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"john@example.com","name":{"givenName":"John","familyName":"Doe"}}' \\
  ${baseUrl}Users`;

  const curlListUsers = `curl -H "Authorization: Bearer YOUR_TOKEN" \\
  "${baseUrl}Users?startIndex=1&count=10"`;

  const curlCreateGroup = `curl -X POST -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/scim+json" \\
  -d '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:Group"],"displayName":"Engineering"}' \\
  ${baseUrl}Groups`;

  return (
    <PageContainer>
      <PageHeader
        title="SCIM settings"
        subtitle="Tokens that let external systems provision users and groups into EuroID over SCIM 2.0."
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={handleGenerateOpen}>
            Generate token
          </Button>
        }
      />
      {/* Section 1: SCIM Provisioning Tokens */}
      <Card style={{ marginBottom: 16 }} title="Provisioning tokens">
        {isLoading ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : (
          <Table
            dataSource={activeTokens}
            columns={columns}
            rowKey="id"
            pagination={false}
            locale={{
              emptyText:
                'No tokens yet. Generate one to allow external systems to provision users and groups via SCIM.',
            }}
          />
        )}
      </Card>

      {/* Section 2: SCIM Endpoint Information */}
      <Card title="Endpoint information">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <Text strong>Base URL:</Text>
            <div style={{ marginTop: 4, fontFamily: token.fontFamilyCode, fontSize: 13 }}>
              {baseUrl}
            </div>
          </div>

          <div>
            <Text strong>Supported Operations:</Text>
            <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 20 }}>
              <li>Users: Create, Read, Update (PUT/PATCH), Delete</li>
              <li>Groups: Create, Read, Update (PUT/PATCH), Delete</li>
              <li>Discovery: ServiceProviderConfig, Schemas, ResourceTypes</li>
            </ul>
          </div>

          <Alert
            type="info"
            showIcon
            message="All SCIM requests require Bearer token authentication. Use Content-Type: application/scim+json for POST/PUT/PATCH."
          />

          <div>
            <Text strong>Test with curl:</Text>

            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Discovery (ServiceProviderConfig)
              </Text>
              <pre
                style={{
                  background: token.colorFillQuaternary,
                  padding: 12,
                  borderRadius: 6,
                  overflow: 'auto',
                  fontSize: 12,
                  marginTop: 4,
                }}
              >
                {curlDiscovery}
              </pre>
            </div>

            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Create user
              </Text>
              <pre
                style={{
                  background: token.colorFillQuaternary,
                  padding: 12,
                  borderRadius: 6,
                  overflow: 'auto',
                  fontSize: 12,
                  marginTop: 4,
                }}
              >
                {curlCreateUser}
              </pre>
            </div>

            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                List users
              </Text>
              <pre
                style={{
                  background: token.colorFillQuaternary,
                  padding: 12,
                  borderRadius: 6,
                  overflow: 'auto',
                  fontSize: 12,
                  marginTop: 4,
                }}
              >
                {curlListUsers}
              </pre>
            </div>

            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Create group
              </Text>
              <pre
                style={{
                  background: token.colorFillQuaternary,
                  padding: 12,
                  borderRadius: 6,
                  overflow: 'auto',
                  fontSize: 12,
                  marginTop: 4,
                }}
              >
                {curlCreateGroup}
              </pre>
            </div>
          </div>
        </Space>
      </Card>

      {/* Generate Token Modal */}
      <Modal
        title="Generate SCIM Token"
        open={generateModalOpen}
        onOk={handleGenerateSubmit}
        onCancel={() => setGenerateModalOpen(false)}
        confirmLoading={generateMutation.isPending}
        okText="Generate"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" initialValues={{ scopes: DEFAULT_SCOPES }}>
          <Form.Item
            name="name"
            label="Token Name"
            rules={[{ required: true, message: 'Token name is required' }]}
          >
            <Input placeholder="e.g. Workday SCIM" />
          </Form.Item>
          <Form.Item name="scopes" label="Scopes">
            <Checkbox.Group options={SCOPE_OPTIONS} />
          </Form.Item>
          <Form.Item name="expiresAt" label="Expiration (optional)">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Success Modal — token shown once */}
      <Modal
        title="Token Generated"
        open={successModalOpen}
        onOk={handleSuccessDone}
        onCancel={handleSuccessDone}
        footer={[
          <Button key="copy" type="primary" icon={<CopyOutlined />} onClick={handleCopyToken}>
            Copy Token
          </Button>,
          <Button key="done" onClick={handleSuccessDone}>
            Done
          </Button>,
        ]}
        closable={false}
        // The token is shown once: only Done closes this, never a stray click outside it or Esc
        maskClosable={false}
        keyboard={false}
      >
        <Alert
          type="warning"
          showIcon
          message="This token will only be shown once. Copy it now and store it securely."
          style={{ marginBottom: 16 }}
        />
        {generatedToken?.token && (
          <div>
            <Text type="secondary">Token for &quot;{generatedToken.name}&quot;:</Text>
            <div
              style={{
                marginTop: 8,
                padding: 12,
                background: token.colorFillQuaternary,
                borderRadius: 6,
                fontFamily: token.fontFamilyCode,
                fontSize: 12,
                wordBreak: 'break-all',
              }}
            >
              <code>{generatedToken.token}</code>
            </div>
          </div>
        )}
      </Modal>
    </PageContainer>
  );
};
