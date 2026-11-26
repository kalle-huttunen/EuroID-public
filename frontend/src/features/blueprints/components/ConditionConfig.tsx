/**
 * ConditionConfig — Policy condition node configuration (field, operator, value).
 * Extracted from ConfigDrawer.
 */
import React from 'react';
import { Form, Button, Space, Alert, Input, Select, Popconfirm } from 'antd';
import { FilterOutlined, DeleteOutlined } from '@ant-design/icons';
import { PolicyDisplay } from '../../../components/policy-engine/PolicyDisplay';
import type { FormInstance } from 'antd';
import type { Node } from '@xyflow/react';

const CONDITION_FIELDS = [
  { value: 'department', label: 'Department' },
  { value: 'jobTitle', label: 'Job Title' },
  { value: 'location', label: 'Location' },
  { value: 'employmentType', label: 'Employment Type' },
  { value: 'email', label: 'Email' },
  { value: 'status', label: 'Status' },
];

const OPERATORS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'in', label: 'in' },
  { value: 'regex', label: 'matches regex' },
];

export interface ConditionConfigProps {
  selectedNode: Node | null;
  form: FormInstance;
  onSave: (values: Record<string, unknown>) => void;
  onRemove?: (nodeId: string) => void;
  onClose: () => void;
  /** Below policy-admin: the fields are read-only (the drawer offers no Save or Remove). */
  readOnly?: boolean;
}

export const ConditionConfig: React.FC<ConditionConfigProps> = ({
  selectedNode,
  form,
  onSave,
  onRemove,
  onClose,
  readOnly = false,
}) => (
  <Space direction="vertical" style={{ width: '100%' }} size="large">
    <Alert
      message="Condition"
      description="When this condition matches, the connected actions will run."
      type="info"
      showIcon
      icon={<FilterOutlined />}
    />
    <PolicyDisplay
      policy={{
        conditions: [
          {
            field: (selectedNode?.data?.field as string) || 'department',
            operator: (selectedNode?.data?.operator as string) || 'equals',
            value: (selectedNode?.data?.value as string) ?? '',
          },
        ],
        actions: [],
        rawJson: (selectedNode?.data ?? {}) as Record<string, unknown>,
      }}
    />
    <Form form={form} layout="vertical" onFinish={onSave} disabled={readOnly}>
      <Form.Item name="field" label="Field" rules={[{ required: true }]}>
        <Select options={CONDITION_FIELDS} placeholder="Select field" />
      </Form.Item>
      <Form.Item name="operator" label="Operator" rules={[{ required: true }]}>
        <Select options={OPERATORS} placeholder="Select operator" />
      </Form.Item>
      <Form.Item name="value" label="Value" rules={[{ required: true }]}>
        <Input placeholder="e.g. Sales, Engineering" />
      </Form.Item>
    </Form>
    {onRemove && (
      <Popconfirm
        title="Remove this condition?"
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
