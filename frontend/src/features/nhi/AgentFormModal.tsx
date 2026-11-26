/**
 * Create an agent (POST /nhi) or delegate a sub-agent from `parent` (POST /nhi/:parent/delegate),
 * super-admin, in a centered modal. The fields say the backend's rules before submit: an owner
 * who is an active person, a lowercase id, capabilities like `hr:read`, an expiry at most 90 days
 * away, and for a sub-agent a subset of the parent's scope and no later expiry than the parent's.
 * A refusal stays in the modal with the API's message.
 */
import React, { useState } from 'react';
import { Alert, App, DatePicker, Form, Input, Modal, Select, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useCreateAgent, useDelegateAgent } from '@api/nhi-api';
import type { AgentKind, IAgentIdentity, ICreateAgentBody } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { OwnerPicker } from './OwnerPicker';
import {
  AGENT_ID_RE,
  KINDS,
  KIND_LABEL,
  MAX_LIFETIME_DAYS,
  MAX_SCOPE_ENTRIES,
  RISK_LABEL,
  SCOPE_ENTRY_RE,
  expiryProblem,
  formatDateTime,
} from './nhi-labels';

const { Text } = Typography;

const MODAL_WIDTH = 640;
/** A new agent's suggested lifetime; the parent's expiry when that comes first. */
const DEFAULT_LIFETIME_DAYS = 30;

interface FormValues {
  agentId: string;
  displayName: string;
  kind: AgentKind;
  ownerIdentityId?: string;
  scope: string[];
  expiresAt: Dayjs | null;
}

function initialValues(parent?: IAgentIdentity): FormValues {
  const suggested = dayjs().add(DEFAULT_LIFETIME_DAYS, 'day');
  const parentExpiry = parent ? dayjs(parent.expiresAt) : undefined;
  return {
    agentId: '',
    displayName: '',
    kind: parent?.kind ?? 'service-account',
    ownerIdentityId: parent?.owner.identityId,
    scope: [],
    expiresAt: parentExpiry && parentExpiry.isBefore(suggested) ? parentExpiry : suggested,
  };
}

function scopeProblem(scope: string[] | undefined): string | undefined {
  if (!scope?.length) return 'Add at least one capability';
  if (scope.length > MAX_SCOPE_ENTRIES) return `At most ${MAX_SCOPE_ENTRIES} capabilities`;
  const bad = scope.find((s) => !SCOPE_ENTRY_RE.test(s));
  return bad ? `"${bad}" is not a capability like hr:read or entra:users:write` : undefined;
}

export const AgentFormModal: React.FC<{
  /** The agent to delegate from; absent to create a top-level agent. */
  parent?: IAgentIdentity;
  onClose: () => void;
}> = ({ parent, onClose }) => {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const create = useCreateAgent();
  const delegate = useDelegateAgent();
  const [error, setError] = useState<string | null>(null);
  const pending = create.isPending || delegate.isPending;
  const lastDay = (() => {
    const max = dayjs().add(MAX_LIFETIME_DAYS, 'day');
    return parent && dayjs(parent.expiresAt).isBefore(max) ? dayjs(parent.expiresAt) : max;
  })();

  const submit = async (values: FormValues) => {
    setError(null);
    const body: ICreateAgentBody = {
      agentId: values.agentId.trim(),
      displayName: values.displayName.trim(),
      kind: values.kind,
      ownerIdentityId: values.ownerIdentityId as string,
      scope: values.scope,
      expiresAt: (values.expiresAt as Dayjs).toISOString(),
    };
    try {
      if (parent) {
        const child = await delegate.mutateAsync({ parentAgentId: parent.agentId, body });
        message.success(`Agent "${child.agentId}" delegated from "${parent.agentId}"`);
      } else {
        const agent = await create.mutateAsync(body);
        message.success(
          `Agent "${agent.agentId}" created, risk tier ${RISK_LABEL[agent.riskTier]?.toLowerCase() ?? agent.riskTier}`,
        );
      }
      onClose();
    } catch (err) {
      const verb = parent ? 'delegate' : 'create';
      setError(`Could not ${verb} the agent: ${apiErrorMessage(err, 'the request failed')}`);
    }
  };

  return (
    <Modal
      open
      centered
      width={MODAL_WIDTH}
      title={parent ? `Delegate from "${parent.agentId}"` : 'New agent'}
      okText={parent ? 'Delegate agent' : 'Create agent'}
      confirmLoading={pending}
      onOk={() => form.submit()}
      onCancel={onClose}
      maskClosable={false}
      styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
    >
      <Form<FormValues>
        form={form}
        name={parent ? 'nhi-delegate' : 'nhi-create'}
        layout="vertical"
        requiredMark={false}
        initialValues={initialValues(parent)}
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
        {parent && (
          <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
            The sub-agent gets part of what &quot;{parent.displayName}&quot; may do, never more, and
            ends no later than it. Revoking &quot;{parent.agentId}&quot; revokes it too.
          </Text>
        )}
        <Form.Item
          name="agentId"
          label="Agent id"
          extra="3 to 64 lowercase letters, digits and hyphens, starting with a letter. Unique in the tenant; routes and credentials use it and it cannot be changed."
          rules={[
            { required: true, whitespace: true, message: 'Enter an agent id' },
            {
              pattern: AGENT_ID_RE,
              message: 'Lowercase letters, digits and hyphens; a letter first, no hyphen last',
            },
          ]}
        >
          <Input placeholder="e.g. payroll-sync-bot" autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="displayName"
          label="Display name"
          rules={[
            { required: true, whitespace: true, message: 'Enter a display name' },
            { max: 200, message: 'At most 200 characters' },
          ]}
        >
          <Input placeholder="e.g. Payroll sync" />
        </Form.Item>
        <Form.Item name="kind" label="Kind" rules={[{ required: true }]}>
          <Select
            aria-label="Kind"
            options={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          />
        </Form.Item>
        <Form.Item
          name="ownerIdentityId"
          label="Owner"
          extra="An active person in the identity hub who answers for the agent. People who are not active are listed but cannot be chosen."
          rules={[{ required: true, message: 'Choose the owner' }]}
        >
          <OwnerPicker
            ariaLabel="Owner"
            requireActive
            initial={
              parent
                ? {
                    id: parent.owner.identityId,
                    email: parent.owner.email,
                    displayName: parent.owner.email,
                  }
                : undefined
            }
          />
        </Form.Item>
        <Form.Item
          name="scope"
          label="Scope"
          extra={
            parent
              ? `A subset of the parent's scope: ${parent.scope.join(', ')}.`
              : `What the agent may do, 1 to ${MAX_SCOPE_ENTRIES} capabilities like hr:read or entra:users:write (a lowercase domain, then one to four parts after colons). Press Enter or a comma after each. Wildcards, admin capabilities and long lists raise the risk tier.`
          }
          rules={[
            {
              validator: (_, v?: string[]) => {
                const problem = scopeProblem(v);
                return problem ? Promise.reject(new Error(problem)) : Promise.resolve();
              },
            },
          ]}
        >
          {parent ? (
            <Select
              mode="multiple"
              aria-label="Scope"
              options={parent.scope.map((s) => ({ value: s, label: s }))}
            />
          ) : (
            <Select
              mode="tags"
              aria-label="Scope"
              tokenSeparators={[',', ' ']}
              notFoundContent={null}
              placeholder="hr:read"
            />
          )}
        </Form.Item>
        <Form.Item
          name="expiresAt"
          label="Expires"
          extra={
            parent
              ? `No later than the parent's expiry, ${formatDateTime(parent.expiresAt)}, and at most ${MAX_LIFETIME_DAYS} days from now.`
              : `At most ${MAX_LIFETIME_DAYS} days from now; the API shortens a later date to ${MAX_LIFETIME_DAYS} days.`
          }
          rules={[
            {
              validator: (_, v?: Dayjs | null) => {
                const problem = expiryProblem(v, dayjs(), parent?.expiresAt);
                return problem ? Promise.reject(new Error(problem)) : Promise.resolve();
              },
            },
          ]}
        >
          <DatePicker
            aria-label="Expires"
            showTime={{ format: 'HH:mm' }}
            format="YYYY-MM-DD HH:mm"
            disabledDate={(d) => d.isBefore(dayjs(), 'day') || d.isAfter(lastDay, 'day')}
            style={{ width: '100%', maxWidth: 260 }}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};
