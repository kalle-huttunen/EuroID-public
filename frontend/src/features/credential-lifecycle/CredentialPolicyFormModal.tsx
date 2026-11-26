/**
 * Create or edit a credential policy in a centered modal (policy-admin). It offers what the
 * nightly check uses: the systems and employment types the policy applies to, the maximum
 * password age (passwordPolicy.maxAgeDays) and the warning window (rotationPolicy.notifyDaysBefore),
 * and on or off. Nothing evaluates the stored complexity, reuse, rotation interval, secret storage,
 * MFA requirement or entitlement tiers, so the form leaves them out; an edit keeps their stored
 * values and sends only the changed fields. The API's message is shown on a refusal (409: name taken).
 */
import React, { useState } from 'react';
import { Alert, App, Form, Input, InputNumber, Modal, Select, Space, Switch } from 'antd';
import {
  useCreateCredentialPolicy,
  useUpdateCredentialPolicy,
} from '@api/credential-lifecycle-api';
import type { ICredentialPolicy, ICredentialPolicyBody } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import {
  EMPLOYMENT_TYPE_OPTIONS,
  NO_RESET_NOTE,
  NO_RESET_TITLE,
  SYSTEM_OPTIONS,
} from './credential-labels';

const MODAL_WIDTH = 620;

interface FormValues {
  name: string;
  description?: string;
  connectorTypes: string[];
  employmentTypes: string[];
  maxAgeDays: number;
  notifyDaysBefore: number;
  isActive: boolean;
}

function initialValues(policy?: ICredentialPolicy): FormValues {
  return {
    name: policy?.name ?? '',
    description: policy?.description ?? '',
    connectorTypes: policy?.targetScope?.connectorTypes ?? [],
    employmentTypes: policy?.targetScope?.employmentTypes ?? [],
    maxAgeDays: policy?.passwordPolicy?.maxAgeDays ?? 90,
    notifyDaysBefore: policy?.rotationPolicy?.notifyDaysBefore ?? 14,
    isActive: policy?.isActive ?? true,
  };
}

const sameList = (a: string[] = [], b: string[] = []) =>
  a.length === b.length && a.every((v) => b.includes(v));

/**
 * The stored settings of a sub-object, by the keys the API's strict update schema accepts. A
 * stored object may carry more: policies saved before 2026-11-25 have a nested tenantId.
 */
function storedSettings<T extends object, K extends keyof T>(
  stored: T | undefined,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const picked: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (stored?.[key] !== undefined) picked[key] = stored[key];
  }
  return picked;
}

type Settings<K extends keyof ICredentialPolicy> = NonNullable<ICredentialPolicy[K]>;
const TARGET_SCOPE_KEYS: readonly (keyof Settings<'targetScope'>)[] = [
  'connectorTypes',
  'employmentTypes',
  'entitlementTiers',
];
const PASSWORD_POLICY_KEYS: readonly (keyof Settings<'passwordPolicy'>)[] = [
  'maxAgeDays',
  'minLength',
  'requireComplexity',
  'preventReuse',
];
const ROTATION_POLICY_KEYS: readonly (keyof Settings<'rotationPolicy'>)[] = [
  'enabled',
  'intervalDays',
  'notifyDaysBefore',
  'vaultStorage',
];

/** The fields that differ from the stored policy; sub-objects keep their other stored values. */
function changesOf(policy: ICredentialPolicy, v: FormValues): ICredentialPolicyBody {
  const changes: ICredentialPolicyBody = {};
  const name = v.name.trim();
  if (name !== policy.name) changes.name = name;
  const description = v.description?.trim() ?? '';
  if (description !== (policy.description ?? '')) changes.description = description;
  if (
    !sameList(v.connectorTypes, policy.targetScope?.connectorTypes) ||
    !sameList(v.employmentTypes, policy.targetScope?.employmentTypes)
  ) {
    changes.targetScope = {
      ...storedSettings(policy.targetScope, TARGET_SCOPE_KEYS),
      connectorTypes: v.connectorTypes,
      employmentTypes: v.employmentTypes,
    };
  }
  if (v.maxAgeDays !== policy.passwordPolicy?.maxAgeDays) {
    changes.passwordPolicy = {
      ...storedSettings(policy.passwordPolicy, PASSWORD_POLICY_KEYS),
      maxAgeDays: v.maxAgeDays,
    };
  }
  if (v.notifyDaysBefore !== policy.rotationPolicy?.notifyDaysBefore) {
    changes.rotationPolicy = {
      ...storedSettings(policy.rotationPolicy, ROTATION_POLICY_KEYS),
      notifyDaysBefore: v.notifyDaysBefore,
    };
  }
  if (v.isActive !== policy.isActive) changes.isActive = v.isActive;
  return changes;
}

/** POST body: the API fills the other password and rotation settings with its defaults. */
function createBody(v: FormValues): ICredentialPolicyBody {
  const description = v.description?.trim();
  return {
    name: v.name.trim(),
    ...(description ? { description } : {}),
    targetScope: { connectorTypes: v.connectorTypes, employmentTypes: v.employmentTypes },
    passwordPolicy: { maxAgeDays: v.maxAgeDays },
    rotationPolicy: { notifyDaysBefore: v.notifyDaysBefore },
    isActive: v.isActive,
  };
}

export const CredentialPolicyFormModal: React.FC<{
  /** The policy to edit; absent to create one. */
  policy?: ICredentialPolicy;
  onClose: () => void;
}> = ({ policy, onClose }) => {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const create = useCreateCredentialPolicy();
  const update = useUpdateCredentialPolicy();
  const [error, setError] = useState<string | null>(null);
  const watched = Form.useWatch([], form) as FormValues | undefined;
  const changes =
    policy && watched ? changesOf(policy, { ...initialValues(policy), ...watched }) : {};
  const pending = create.isPending || update.isPending;

  const submit = async (values: FormValues) => {
    setError(null);
    try {
      if (policy) {
        await update.mutateAsync({ id: policy._id, changes: changesOf(policy, values) });
        message.success(`Policy "${values.name.trim()}" saved`);
      } else {
        await create.mutateAsync(createBody(values));
        message.success(`Policy "${values.name.trim()}" created`);
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
      title={policy ? `Edit "${policy.name}"` : 'New credential policy'}
      okText={policy ? 'Save changes' : 'Create policy'}
      okButtonProps={{ disabled: !!policy && Object.keys(changes).length === 0 }}
      confirmLoading={pending}
      onOk={() => form.submit()}
      onCancel={onClose}
      styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
    >
      <Form<FormValues>
        form={form}
        name={policy ? 'credential-policy-edit' : 'credential-policy-create'}
        layout="vertical"
        requiredMark={false}
        initialValues={initialValues(policy)}
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
        <Alert
          type="info"
          showIcon
          message={NO_RESET_TITLE}
          description={`${NO_RESET_NOTE} The policy sets when a password counts as overdue.`}
          style={{ marginBottom: 16 }}
        />
        <Form.Item
          name="name"
          label="Name"
          rules={[
            { required: true, whitespace: true, message: 'Enter a name' },
            { max: 200, message: 'At most 200 characters' },
          ]}
        >
          <Input placeholder="e.g. Service accounts in Active Directory" />
        </Form.Item>
        <Form.Item
          name="description"
          label="Description"
          rules={[{ max: 1000, message: 'At most 1000 characters' }]}
        >
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} />
        </Form.Item>
        <Form.Item
          name="connectorTypes"
          label="Systems"
          extra="None chosen: every system. When several active policies fit an account, the one naming its system wins, then the one naming its employment type."
        >
          <Select mode="multiple" aria-label="Systems" allowClear options={SYSTEM_OPTIONS} />
        </Form.Item>
        <Form.Item
          name="employmentTypes"
          label="Employment types"
          extra="None chosen: every employment type."
        >
          <Select
            mode="multiple"
            aria-label="Employment types"
            allowClear
            options={EMPLOYMENT_TYPE_OPTIONS}
          />
        </Form.Item>
        <Space wrap size="large" align="start">
          <Form.Item
            name="maxAgeDays"
            label="Maximum password age (days)"
            extra="Older than this: overdue."
            rules={[{ required: true, message: 'Enter 1 to 365 days' }]}
          >
            <InputNumber min={1} max={365} precision={0} />
          </Form.Item>
          <Form.Item
            name="notifyDaysBefore"
            label="Warn before (days)"
            extra="Expiring soon from this many days before."
            rules={[{ required: true, message: 'Enter 1 to 30 days' }]}
          >
            <InputNumber min={1} max={30} precision={0} />
          </Form.Item>
        </Space>
        <Form.Item
          name="isActive"
          label="Active"
          valuePropName="checked"
          extra="Only active policies are applied, from the next nightly check."
        >
          <Switch aria-label="Active" />
        </Form.Item>
      </Form>
    </Modal>
  );
};
