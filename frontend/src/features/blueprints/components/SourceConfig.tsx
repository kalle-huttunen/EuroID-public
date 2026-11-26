/**
 * SourceConfig — HR source pipeline preview, sync, connection settings, and remove.
 * Extracted from ConfigDrawer.
 */
import React from 'react';
import {
  Form,
  Button,
  Space,
  Alert,
  Input,
  Typography,
  Popconfirm,
  Divider,
  Statistic,
  Table,
  Card,
  Tag,
  Select,
  theme,
  App,
  ConfigProvider,
} from 'antd';
import {
  DeleteOutlined,
  DatabaseOutlined,
  TeamOutlined,
  PlayCircleOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { CONNECTOR_REGISTRY } from '../shared';
import { PriorityMasteryTab } from '@features/connectors/PriorityMasteryTab';
import { ConnectorHealthCheck } from '@features/connectors/ConnectorHealthCheck';
import { ConnectionReadOnlyNote } from './ConnectorConfig';
import type { FormInstance } from 'antd';
import type { Node } from '@xyflow/react';
import type { IStandardUser } from '../../../interfaces';

const { Text } = Typography;

/**
 * A 'json' config field (an HR column or field map) must hold a JSON object; blank means the
 * connector's default map. The API checks each entry and names a wrong one.
 */
const jsonObjectRule = (label: string) => ({
  validator: (_: unknown, value: unknown) => {
    if (typeof value !== 'string' || value.trim() === '') return Promise.resolve();
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return Promise.resolve();
    } catch {
      // reported below
    }
    return Promise.reject(new Error(`${label} must be a JSON object, such as {"Email": "email"}.`));
  },
});

export interface SourceConfigProps {
  selectedNode: Node | null;
  form: FormInstance;
  onSave: (values: Record<string, unknown>) => void;
  onDeleteConnector: (nodeId: string) => void;
  onClose: () => void;
  pipelineCount: number;
  testUsers: IStandardUser[];
  onOpenSimulation?: () => void;
  sourceConnectorId: string;
  syncLoading: boolean;
  lastSyncCount: number | null;
  onSyncNow: () => void;
  /** Below policy-admin: nothing here can be changed or removed (the drawer offers no Save). */
  readOnly?: boolean;
  /**
   * A policy-admin without connector-admin: the connection settings are read-only (their PATCH
   * needs connector-admin); Priority & Mastery and Save still change the canvas node.
   */
  connectionReadOnly?: boolean;
  /** The other HR source nodes whose saved contract tag is PRIMARY (otherPrimarySources). */
  otherPrimarySources?: string[];
}

export const SourceConfig: React.FC<SourceConfigProps> = ({
  selectedNode,
  form,
  onSave,
  onDeleteConnector,
  onClose,
  pipelineCount,
  testUsers,
  onOpenSimulation,
  sourceConnectorId,
  syncLoading,
  lastSyncCount,
  onSyncNow,
  readOnly = false,
  connectionReadOnly = false,
  otherPrimarySources = [],
}) => {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const previewUsers = testUsers.slice(0, 5);

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <Card
        size="small"
        style={{ borderColor: token.colorSuccessBorder, background: token.colorSuccessBg }}
      >
        <Space size="large">
          <Statistic
            title="Users in Pipeline"
            value={pipelineCount}
            prefix={<TeamOutlined />}
            valueStyle={{ color: token.colorSuccess, fontSize: 28 }}
          />
          <Divider type="vertical" style={{ height: 50 }} />
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              These users are ready to be provisioned through the Brain to your target connectors.
            </Text>
            <br />
            <Button
              type="link"
              icon={<PlayCircleOutlined />}
              onClick={onOpenSimulation}
              style={{ padding: 0, marginTop: 4 }}
            >
              Run Impact Simulation to preview
            </Button>
          </div>
        </Space>
      </Card>

      {sourceConnectorId && (
        <Card size="small">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space>
              <Button
                type="primary"
                icon={<SyncOutlined spin={syncLoading} />}
                onClick={onSyncNow}
                loading={syncLoading}
              >
                Sync Now
              </Button>
              {lastSyncCount !== null && <Tag color="green">{lastSyncCount} users synced</Tag>}
            </Space>
            <Text type="secondary" style={{ fontSize: 11 }}>
              Pull users from this HR source into the Identity Hub. Duplicates are merged by the
              correlation engine.
            </Text>
            <ConnectorHealthCheck connectorId={sourceConnectorId} form={form} />
          </Space>
        </Card>
      )}

      {previewUsers.length > 0 && (
        <>
          <Text strong style={{ fontSize: 13 }}>
            Pipeline Preview (first 5)
          </Text>
          <Table
            dataSource={previewUsers.map((u, i) => ({
              key: u._id || i,
              name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || 'Unknown',
              department: u.departmentCode || u.departmentName || '-',
              email: u.email || '-',
              status: u.status || 'Pending',
            }))}
            size="small"
            pagination={false}
            columns={[
              { title: 'Name', dataIndex: 'name', key: 'name' },
              { title: 'Department', dataIndex: 'department', key: 'dept', width: 120 },
              { title: 'Email', dataIndex: 'email', key: 'email', ellipsis: true },
              {
                title: 'Status',
                dataIndex: 'status',
                key: 'status',
                width: 90,
                render: (s: string) => <Tag color={s === 'Active' ? 'green' : 'blue'}>{s}</Tag>,
              },
            ]}
          />
          {pipelineCount > 5 && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              ...and {pipelineCount - 5} more users. Run Impact Simulation to see all.
            </Text>
          )}
        </>
      )}

      {pipelineCount === 0 && (
        <Alert
          message="No Users in Pipeline"
          description="No user records found in the identity hub. Import HR data to start provisioning."
          type="info"
          showIcon
        />
      )}

      <Divider>Connection Settings</Divider>
      <Alert
        message="HR Source Configuration"
        description="Configure the connection to your HR system. Data is pulled from this source into the EuroID identity hub."
        type="info"
        showIcon
        icon={<DatabaseOutlined />}
      />
      {connectionReadOnly && !readOnly && <ConnectionReadOnlyNote />}
      {/* Save Config sits in the drawer header, far above these fields: on a missing value it
          scrolls to the field and says why nothing was saved. */}
      <Form
        form={form}
        layout="vertical"
        onFinish={onSave}
        disabled={readOnly}
        scrollToFirstError
        onFinishFailed={({ errorFields }) =>
          message.error(`Not saved: ${errorFields.flatMap((f) => f.errors).join(' ')}`)
        }
      >
        <ConfigProvider componentDisabled={readOnly || connectionReadOnly}>
          {(() => {
            const meta = CONNECTOR_REGISTRY.find((c) =>
              c.idPatterns.some((p) =>
                (selectedNode?.id || '').toLowerCase().includes(p.toLowerCase()),
              ),
            );
            if (meta?.configSchema?.length) {
              return meta.configSchema.map((field) => (
                <Form.Item
                  key={field.key}
                  label={field.label}
                  name={field.key}
                  rules={[
                    ...(field.required
                      ? [{ required: true, message: `${field.label} is required.` }]
                      : []),
                    ...(field.type === 'json' ? [jsonObjectRule(field.label)] : []),
                  ]}
                  extra={field.type === 'json' ? field.helpText : undefined}
                >
                  {field.type === 'password' ? (
                    <Input.Password placeholder={field.placeholder} />
                  ) : field.type === 'json' ? (
                    <Input.TextArea
                      placeholder={field.placeholder}
                      autoSize={{ minRows: 2, maxRows: 8 }}
                      spellCheck={false}
                    />
                  ) : field.type === 'select' ? (
                    <Select
                      placeholder={field.placeholder}
                      options={(field.options || []).map((o) =>
                        typeof o === 'string' ? { label: o, value: o } : o,
                      )}
                    />
                  ) : (
                    <Input placeholder={field.placeholder} />
                  )}
                </Form.Item>
              ));
            }
            return (
              <Form.Item label="HR System URL" name="hrUrl">
                <Input placeholder="https://wd5-impl.workday.com/..." />
              </Form.Item>
            );
          })()}
        </ConfigProvider>
        <Divider>Priority & Mastery</Divider>
        <Form.Item
          noStyle
          shouldUpdate={(prev, curr) =>
            prev.ingestPriority !== curr.ingestPriority ||
            prev.contractTag !== curr.contractTag ||
            JSON.stringify(prev.masteryFields) !== JSON.stringify(curr.masteryFields)
          }
        >
          {() => (
            <>
              {(form.getFieldValue('contractTag') ?? 'PRIMARY') === 'PRIMARY' &&
                otherPrimarySources.length > 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message={`${otherPrimarySources.join(', ')} ${otherPrimarySources.length === 1 ? 'is' : 'are'} also tagged Primary`}
                    description="Every identity then gets the same primary HR source: the one with the lower ingest priority, then the one first in the source priority order of Admin > Recon Config, then by name. Its values win every field no source masters. Tag the other sources Secondary to choose."
                  />
                )}
              <PriorityMasteryTab
                value={{
                  ingestPriority: form.getFieldValue('ingestPriority') ?? 1,
                  contractTag: form.getFieldValue('contractTag') ?? 'PRIMARY',
                  masteryFields: form.getFieldValue('masteryFields') ?? [],
                }}
                onChange={(v) => {
                  if (v.ingestPriority != null)
                    form.setFieldValue('ingestPriority', v.ingestPriority);
                  if (v.contractTag) form.setFieldValue('contractTag', v.contractTag);
                  if (v.masteryFields) form.setFieldValue('masteryFields', v.masteryFields);
                }}
              />
            </>
          )}
        </Form.Item>
      </Form>

      {!readOnly && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 16px',
              background: token.colorErrorBg,
              borderRadius: 6,
              border: `1px solid ${token.colorErrorBorder}`,
            }}
          >
            <div>
              <Text strong style={{ color: token.colorErrorActive }}>
                Remove Source
              </Text>
              <br />
              <Text type="secondary" style={{ fontSize: 11 }}>
                Remove this source from the canvas. You can re-add it anytime.
              </Text>
            </div>
            <Popconfirm
              title="Remove this source?"
              description="It will be removed from the canvas. You can re-add it anytime."
              onConfirm={() => {
                onDeleteConnector(selectedNode?.id ?? '');
                onClose();
              }}
              okText="Yes, Remove"
              cancelText="Cancel"
              okButtonProps={{ danger: true }}
            >
              <Button danger icon={<DeleteOutlined />}>
                Remove
              </Button>
            </Popconfirm>
          </div>
        </>
      )}
    </Space>
  );
};
