/**
 * Create or edit an SoD policy in a centered modal. Create sends what CreateSodPolicySchema
 * accepts: a name, two or more entitlements from the catalog, action, severity, active. Edit
 * offers only what UpdateSodPolicySchema can change (action and severity; on or off is the
 * list's switch) and sends only the changed fields. The API's message is shown on a refusal.
 */
import React, { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useCreateSodPolicy, useUpdateSodPolicy } from '@api/sod-policies-api';
import type { ISodPolicy, IUpdateSodPolicy, SodAction, SodSeverity } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { SodEntitlementPicker } from './SodEntitlementPicker';
import { SodEntitlementList } from './SodEntitlementList';
import type { EntitlementNames } from './useEntitlementNames';
import {
  SEVERITIES,
  SEVERITY_LABEL,
  findDuplicate,
  toRef,
  type SodFormEntitlement,
} from './sod-labels';

const { Text } = Typography;

/** Fits two pickers side by side; on narrow screens Ant Design caps it at the viewport. */
const MODAL_WIDTH = 720;

interface FormValues {
  name: string;
  description?: string;
  entitlements: SodFormEntitlement[];
  action: SodAction;
  severity: SodSeverity;
  isActive: boolean;
}

const ActionField: React.FC = () => (
  <Form.Item name="action" label="When it matches">
    <Radio.Group>
      <Space direction="vertical" size={4}>
        <Radio value="BLOCK">
          Block <Text type="secondary">(refuses access requests, stops provisioning)</Text>
        </Radio>
        <Radio value="WARN">
          Warn <Text type="secondary">(access requests go ahead with a warning)</Text>
        </Radio>
      </Space>
    </Radio.Group>
  </Form.Item>
);

const SeverityField: React.FC = () => (
  <Form.Item
    name="severity"
    label="Severity"
    extra="Shown with each violation; it does not change what is blocked."
  >
    <Select
      aria-label="Severity"
      options={SEVERITIES.map((s) => ({ value: s, label: SEVERITY_LABEL[s] }))}
      style={{ maxWidth: 240 }}
    />
  </Form.Item>
);

export const SodPolicyFormModal: React.FC<{
  /** The policy to edit; absent to create one. */
  policy?: ISodPolicy;
  /** Catalog names for the edited policy's entitlements. */
  lookup: EntitlementNames;
  onClose: () => void;
}> = ({ policy, lookup, onClose }) => {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const create = useCreateSodPolicy();
  const update = useUpdateSodPolicy();
  const [error, setError] = useState<string | null>(null);
  const action = Form.useWatch('action', form) as SodAction | undefined;
  const severity = Form.useWatch('severity', form) as SodSeverity | undefined;

  const changes: IUpdateSodPolicy = {};
  if (policy && action && action !== policy.action) changes.action = action;
  if (policy && severity && severity !== policy.severity) changes.severity = severity;
  const pending = create.isPending || update.isPending;

  const submit = async (values: FormValues) => {
    setError(null);
    try {
      if (policy) {
        await update.mutateAsync({ id: policy.id, changes });
        message.success(`Policy "${policy.name}" saved`);
      } else {
        const name = values.name.trim();
        await create.mutateAsync({
          name,
          ...(values.description?.trim() ? { description: values.description.trim() } : {}),
          severity: values.severity,
          action: values.action,
          isActive: values.isActive,
          conflictingEntitlements: values.entitlements.map(toRef),
        });
        message.success(`Policy "${name}" created`);
      }
      onClose();
    } catch (err) {
      const verb = policy ? 'save' : 'create';
      setError(`Could not ${verb} the policy: ${apiErrorMessage(err, 'the request failed')}`);
    }
  };

  return (
    <Modal
      open
      centered
      width={MODAL_WIDTH}
      title={policy ? `Edit "${policy.name}"` : 'New SoD policy'}
      okText={policy ? 'Save changes' : 'Create policy'}
      okButtonProps={{ disabled: !!policy && Object.keys(changes).length === 0 }}
      confirmLoading={pending}
      onOk={() => form.submit()}
      onCancel={onClose}
      styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
    >
      <Form<FormValues>
        form={form}
        name={policy ? 'sod-edit' : 'sod-create'}
        layout="vertical"
        requiredMark={false}
        initialValues={
          policy
            ? { action: policy.action, severity: policy.severity }
            : { entitlements: [{}, {}], action: 'BLOCK', severity: 'HIGH', isActive: true }
        }
        onFinish={submit}
      >
        {error && (
          <Alert
            type="error"
            showIcon
            message={error}
            closable
            onClose={() => setError(null)}
            style={{ marginBottom: 16 }}
          />
        )}
        {policy ? (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="The API changes only the action and the severity here (and on or off with the switch in the list). To change the name, description or entitlements, create a new policy and delete this one: it stays in the list as inactive."
            />
            <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
              {policy.description && (
                <Descriptions.Item label="Description">{policy.description}</Descriptions.Item>
              )}
              <Descriptions.Item label="Conflicting entitlements (all at once)">
                <SodEntitlementList entitlements={policy.conflictingEntitlements} lookup={lookup} />
              </Descriptions.Item>
            </Descriptions>
          </>
        ) : (
          <>
            <Form.Item
              name="name"
              label="Name"
              rules={[{ required: true, whitespace: true, message: 'Enter a name' }]}
            >
              <Input placeholder="e.g. Create vendors vs approve payments" />
            </Form.Item>
            <Form.Item name="description" label="Description">
              <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} />
            </Form.Item>
            <Form.Item
              label="Conflicting entitlements"
              extra="A person violates the policy when one check would give them all of these at once."
              style={{ marginBottom: 8 }}
            >
              <Form.List
                name="entitlements"
                rules={[
                  {
                    validator: async (_, items: SodFormEntitlement[] = []) => {
                      const dup = findDuplicate(items);
                      if (dup) {
                        throw new Error(
                          `Entitlement ${dup.index + 1} is the same as entitlement ${dup.firstIndex + 1}. A policy needs different entitlements.`,
                        );
                      }
                    },
                  },
                ]}
              >
                {(fields, { add, remove }, { errors }) => (
                  <>
                    {fields.map((field, i) => (
                      <SodEntitlementPicker
                        key={field.key}
                        field={field}
                        index={i}
                        onRemove={fields.length > 2 ? () => remove(field.name) : undefined}
                      />
                    ))}
                    <Form.ErrorList errors={errors} />
                    <Button
                      type="dashed"
                      icon={<PlusOutlined />}
                      onClick={() => add({})}
                      style={{ marginTop: 4 }}
                    >
                      Add entitlement
                    </Button>
                  </>
                )}
              </Form.List>
            </Form.Item>
          </>
        )}
        <ActionField />
        <SeverityField />
        {!policy && (
          <Form.Item
            name="isActive"
            label="Active"
            valuePropName="checked"
            extra="Checked from the moment it is saved."
          >
            <Switch aria-label="Active" />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
};
