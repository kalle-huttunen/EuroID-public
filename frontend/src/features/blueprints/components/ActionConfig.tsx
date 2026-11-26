/**
 * ActionConfig — Policy action node configuration (target system, action type).
 * Extracted from ConfigDrawer. The target systems are the registered target connectors plus
 * All Systems (POLICY_ACTION_TARGETS, connector-registry.ts).
 */
import React from 'react';
import { Form, Button, Space, Alert, Select, Popconfirm } from 'antd';
import { ThunderboltOutlined, DeleteOutlined } from '@ant-design/icons';
import { PolicyDisplay } from '../../../components/policy-engine/PolicyDisplay';
import { POLICY_ACTION_TARGETS, getPolicyTargetLabel } from '../shared';
import type { FormInstance } from 'antd';
import type { Node } from '@xyflow/react';

const ACTION_TYPES = [
  { value: 'assign_group', label: 'Assign Group' },
  { value: 'assign_license', label: 'Assign License' },
  { value: 'create_account', label: 'Create Account' },
  { value: 'remove_access', label: 'Remove Access' },
  { value: 'send_notification', label: 'Send Notification' },
];

export interface ActionConfigProps {
  selectedNode: Node | null;
  form: FormInstance;
  onSave: (values: Record<string, unknown>) => void;
  onRemove?: (nodeId: string) => void;
  onClose: () => void;
  /** Below policy-admin: the fields are read-only (the drawer offers no Save or Remove). */
  readOnly?: boolean;
}

const ACTION_TYPE_LABEL = (type: string) => ACTION_TYPES.find((a) => a.value === type)?.label;

export const ActionConfig: React.FC<ActionConfigProps> = ({
  selectedNode,
  form,
  onSave,
  onRemove,
  onClose,
  readOnly = false,
}) => {
  // The summary follows the selects below as they change, by the names they show.
  const targetSystem: string =
    Form.useWatch('targetSystem', form) ??
    (selectedNode?.data?.targetSystem as string | undefined) ??
    'entra-id';
  const actionType: string =
    Form.useWatch('actionType', form) ??
    (selectedNode?.data?.actionType as string | undefined) ??
    'assign_group';
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <Alert
        message="Action"
        description="This action will run when the connected condition matches."
        type="info"
        showIcon
        icon={<ThunderboltOutlined />}
      />
      <PolicyDisplay
        policy={{
          conditions: [],
          actions: [
            {
              type: actionType,
              target: targetSystem,
              value: '',
              params: (selectedNode?.data ?? {}) as Record<string, unknown>,
            },
          ],
          rawJson: (selectedNode?.data ?? {}) as Record<string, unknown>,
        }}
        labels={{ actionType: ACTION_TYPE_LABEL, target: getPolicyTargetLabel }}
      />
      <Form form={form} layout="vertical" onFinish={onSave} disabled={readOnly}>
        <Form.Item name="targetSystem" label="Target System" rules={[{ required: true }]}>
          <Select options={POLICY_ACTION_TARGETS} placeholder="Select system" />
        </Form.Item>
        <Form.Item name="actionType" label="Action Type" rules={[{ required: true }]}>
          <Select options={ACTION_TYPES} placeholder="Select action" />
        </Form.Item>
      </Form>
      {onRemove && (
        <Popconfirm
          title="Remove this action?"
          onConfirm={() => {
            onRemove(selectedNode?.id ?? '');
            onClose();
          }}
          okText="Yes"
          cancelText="Cancel"
          okButtonProps={{ danger: true }}
        >
          <Button danger icon={<DeleteOutlined />}>
            Remove
          </Button>
        </Popconfirm>
      )}
    </Space>
  );
};
