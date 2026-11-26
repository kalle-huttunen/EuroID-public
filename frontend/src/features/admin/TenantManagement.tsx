/**
 * Tenant Management — Admin UI for multi-tenant administration.
 * Platform admin only (PlatformAdminRoute; /tenants answers 403 to everyone else, a tenant
 * super-admin included). Lists tenants, CRUD, and current tenant settings.
 */
import React, { useState } from 'react';
import {
  Card,
  Table,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Tag,
  Popconfirm,
  Typography,
  Descriptions,
  Space,
  message,
  Skeleton,
} from 'antd';
import { PlusOutlined, EditOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  useTenants,
  useTenantById,
  useCreateTenant,
  useUpdateTenant,
  useSuspendTenant,
  type Tenant,
  type CreateTenantPayload,
} from '@api/tenant-api';
import { useTenant } from '../../auth/use-tenant';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Text } = Typography;

function statusTag(status: string) {
  const color = status === 'active' ? 'green' : status === 'suspended' ? 'orange' : 'red';
  return <Tag color={color}>{status}</Tag>;
}

function slugFormat(val: string): string {
  return val
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

export const TenantManagement: React.FC = () => {
  const { tenantId: currentTenantId } = useTenant();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);

  const [createForm] = Form.useForm();
  const [editForm] = Form.useForm();

  const { data: tenants = [], isLoading } = useTenants();
  const { data: currentTenant, isLoading: loadingCurrent } = useTenantById(currentTenantId || null);
  const createMutation = useCreateTenant();
  const updateMutation = useUpdateTenant();
  const suspendMutation = useSuspendTenant();

  const handleCreateOpen = () => {
    createForm.resetFields();
    setCreateModalOpen(true);
  };

  const handleCreateSubmit = async () => {
    try {
      const values = await createForm.validateFields();
      const payload: CreateTenantPayload = {
        tenantId: slugFormat(values.tenantId.trim()),
        name: values.name.trim(),
      };
      await createMutation.mutateAsync(payload);
      setCreateModalOpen(false);
      message.success('Tenant created');
    } catch (err: unknown) {
      const msg = apiErrorMessage(err, 'Failed to create tenant');
      message.error(msg);
    }
  };

  const handleEditOpen = (record: Tenant) => {
    setEditingTenant(record);
    editForm.setFieldsValue({
      name: record.name,
      maxIdentities: record.settings?.maxIdentities,
      retentionDays: record.settings?.retentionDays,
      allowedConnectors: record.settings?.allowedConnectors?.join(', '),
    });
    setEditModalOpen(true);
  };

  const handleEditSubmit = async () => {
    if (!editingTenant) return;
    try {
      const values = await editForm.validateFields();
      const settings: Tenant['settings'] = {
        ...editingTenant.settings,
        maxIdentities: values.maxIdentities,
        retentionDays: values.retentionDays,
        allowedConnectors: values.allowedConnectors
          ? values.allowedConnectors
              .split(',')
              .map((s: string) => s.trim())
              .filter(Boolean)
          : undefined,
      };
      await updateMutation.mutateAsync({
        id: editingTenant.tenantId,
        data: { name: values.name, settings },
      });
      setEditModalOpen(false);
      setEditingTenant(null);
      message.success('Tenant updated');
    } catch (err: unknown) {
      const msg = apiErrorMessage(err, 'Failed to update tenant');
      message.error(msg);
    }
  };

  const handleSuspend = async (record: Tenant) => {
    try {
      await suspendMutation.mutateAsync(record.tenantId);
      message.success(`Tenant "${record.name}" suspended`);
    } catch (err: unknown) {
      message.error(apiErrorMessage(err, 'Failed to suspend tenant'));
    }
  };

  const handleActivate = async (record: Tenant) => {
    try {
      await updateMutation.mutateAsync({
        id: record.tenantId,
        data: { status: 'active' },
      });
      message.success(`Tenant "${record.name}" activated`);
    } catch (err: unknown) {
      message.error(apiErrorMessage(err, 'Failed to activate tenant'));
    }
  };

  const columns: ColumnsType<Tenant> = [
    {
      title: 'Tenant ID',
      dataIndex: 'tenantId',
      key: 'tenantId',
      render: (v: string) => <Text strong>{v}</Text>,
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => statusTag(v),
    },
    {
      title: 'Identities',
      key: 'identities',
      render: () => <Text type="secondary">—</Text>,
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEditOpen(record)}
          >
            Edit
          </Button>
          {record.status === 'active' ? (
            <Popconfirm
              title="Suspend tenant"
              description={`Suspend "${record.name}"? Users won't be able to access.`}
              onConfirm={() => handleSuspend(record)}
              okText="Suspend"
              cancelText="Cancel"
              okButtonProps={{ danger: true }}
            >
              <Button type="link" size="small" danger>
                Suspend
              </Button>
            </Popconfirm>
          ) : (
            <Button type="link" size="small" onClick={() => handleActivate(record)}>
              Activate
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="Tenants"
        subtitle="Organisations served by this EuroID deployment and the settings of the current one."
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateOpen}>
            Create tenant
          </Button>
        }
      />
      {/* Section 1: Tenants Table */}
      <Card style={{ marginBottom: 16 }} title="All tenants">
        {isLoading ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : (
          <Table
            dataSource={tenants}
            columns={columns}
            rowKey="tenantId"
            pagination={false}
            locale={{
              emptyText: 'No tenants yet. Create one to enable multi-tenancy.',
            }}
          />
        )}
      </Card>

      {/* Section 2: Current Tenant Settings */}
      <Card title="Current tenant settings">
        {loadingCurrent ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : currentTenant ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="Tenant ID">{currentTenant.tenantId}</Descriptions.Item>
            <Descriptions.Item label="Name">{currentTenant.name}</Descriptions.Item>
            <Descriptions.Item label="Status">{statusTag(currentTenant.status)}</Descriptions.Item>
            <Descriptions.Item label="Max Identities">
              {currentTenant.settings?.maxIdentities ?? '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Retention Override">
              {currentTenant.settings?.retentionDays
                ? `${currentTenant.settings.retentionDays} days`
                : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Allowed Connectors">
              {currentTenant.settings?.allowedConnectors?.length
                ? currentTenant.settings.allowedConnectors.join(', ')
                : '—'}
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Text type="secondary">No tenant selected or loaded.</Text>
        )}
      </Card>

      {/* Create Tenant Modal */}
      <Modal
        title="Create Tenant"
        open={createModalOpen}
        onOk={handleCreateSubmit}
        onCancel={() => setCreateModalOpen(false)}
        confirmLoading={createMutation.isPending}
        okText="Create"
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical">
          <Form.Item
            name="tenantId"
            label="Tenant ID"
            rules={[
              { required: true, message: 'Required' },
              {
                pattern: /^[a-z0-9-]+$/,
                message: 'Lowercase, no spaces (e.g. acme-corp)',
              },
            ]}
          >
            <Input placeholder="e.g. acme-corp" />
          </Form.Item>
          <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Required' }]}>
            <Input placeholder="e.g. Acme Corporation" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit Tenant Modal */}
      <Modal
        title="Edit Tenant"
        open={editModalOpen}
        onOk={handleEditSubmit}
        onCancel={() => {
          setEditModalOpen(false);
          setEditingTenant(null);
        }}
        confirmLoading={updateMutation.isPending}
        okText="Save"
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Required' }]}>
            <Input placeholder="e.g. Acme Corporation" />
          </Form.Item>
          {/* Enforced where an identity is created (backend identity-limit.ts); empty: no limit */}
          <Form.Item
            name="maxIdentities"
            label="Max Identities"
            extra="The most live identities the tenant may have: no identity is created past it (HR rows of new people wait for the next sync). Leave empty for no limit."
          >
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="retentionDays" label="Retention Override (days)">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="allowedConnectors" label="Allowed Connectors (comma-separated)">
            <Input placeholder="e.g. Entra ID, SCIM, Jira" />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
};
