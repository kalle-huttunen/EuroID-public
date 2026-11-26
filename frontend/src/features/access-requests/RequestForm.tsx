/**
 * RequestForm: submit an access request with a justification. Shows the SoD pre-check and, for
 * operators, whether the entitlements are unusual for the requester's peer group
 * (PeerCheckWarnings).
 */
import React, { useState } from 'react';
import { App, Modal, Form, Input, InputNumber, Button, Space, Alert, List, Typography } from 'antd';
import {
  useCreateAccessRequest,
  useSodPreCheck,
  type RequestableCatalogEntry,
  type SodViolationItem,
} from '@api/access-requests-api';
import { isAxiosError } from 'axios';
import { PeerCheckWarnings } from './PeerCheckWarnings';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { TextArea } = Input;
const { Text } = Typography;

function renderSodViolations(violations: SodViolationItem[], type: 'error' | 'warning') {
  if (violations.length === 0) return null;
  return (
    <Alert
      type={type}
      showIcon
      style={{ marginBottom: 16 }}
      message={
        type === 'error'
          ? 'SoD violation: request conflicts with segregation of duties policies'
          : 'SoD warnings: review before submitting'
      }
      description={
        <ul style={{ margin: '8px 0 0 0', paddingLeft: 20 }}>
          {violations.map((v, i) => (
            <li key={i}>
              <Text strong>{v.policyName}</Text> ({v.severity})
              {v.conflictingEntitlements?.length > 0 && (
                <span> — conflicts: {v.conflictingEntitlements.join(', ')}</span>
              )}
            </li>
          ))}
        </ul>
      }
    />
  );
}

export interface RequestFormProps {
  entries: RequestableCatalogEntry[];
  onSuccess: () => void;
  onCancel: () => void;
}

export const RequestForm: React.FC<RequestFormProps> = ({ entries, onSuccess, onCancel }) => {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const createMutation = useCreateAccessRequest();
  const entryIds = entries.map((e) => e._id);
  const entryKey = entryIds.join(',');
  // A failed pre-check is non-blocking (same as before): the server re-checks SoD on submit.
  const preCheck = useSodPreCheck(entryIds);
  const preCheckBlockers = preCheck.data?.blockers ?? [];
  const preCheckWarnings = preCheck.data?.warnings ?? [];
  const preCheckLoading = preCheck.isFetching;

  // Submit-time violations belong to the entry set they were returned for.
  const [submitError, setSubmitError] = useState<{
    key: string;
    violations: SodViolationItem[];
  } | null>(null);
  const submitErrorViolations = submitError?.key === entryKey ? submitError.violations : null;
  const setSubmitErrorViolations = (violations: SodViolationItem[] | null) =>
    setSubmitError(violations ? { key: entryKey, violations } : null);

  const maxDuration = Math.min(
    ...entries.map((e) => e.maxDurationDays ?? 365).filter(Boolean),
    Infinity,
  );
  const showDuration = maxDuration > 0 && isFinite(maxDuration);
  const hasBlockers = preCheckBlockers.length > 0 || (submitErrorViolations?.length ?? 0) > 0;
  const displayBlockers = submitErrorViolations ?? preCheckBlockers;

  const handleSubmit = async () => {
    setSubmitErrorViolations(null);
    try {
      const values = await form.validateFields();
      const entitlements = entries.map((e) => ({
        catalogEntryId: e._id,
        justification: values[`justification_${e._id}`] || values.justification,
      }));

      if (entitlements.some((e) => !e.justification || e.justification.length < 10)) {
        form.setFields([
          {
            name: 'justification',
            errors: ['Justification must be at least 10 characters for each entitlement'],
          },
        ]);
        return;
      }

      await createMutation.mutateAsync({
        entitlements,
        // A cleared duration field is null, which the API refuses: no duration then
        requestedDurationDays: values.requestedDurationDays ?? undefined,
      });
      onSuccess();
    } catch (err: unknown) {
      // The form's own field errors are shown on the fields
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      if (isAxiosError(err) && err.response?.data) {
        const data = err.response.data as { message?: string; sodViolations?: SodViolationItem[] };
        if (data.sodViolations?.length) {
          setSubmitErrorViolations(data.sodViolations);
          return;
        }
      }
      message.error(apiErrorMessage(err, 'The request could not be submitted'));
    }
  };

  return (
    <Modal title="Request access" open onCancel={onCancel} footer={null} width={560} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={handleSubmit}>
        <List
          size="small"
          dataSource={entries}
          renderItem={(e) => (
            <List.Item>
              <List.Item.Meta title={e.name} description={`${e.system} • ${e.type}`} />
            </List.Item>
          )}
        />

        {preCheckLoading && (
          <Alert
            type="info"
            message="Checking segregation of duties..."
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}

        {displayBlockers.length > 0 && renderSodViolations(displayBlockers, 'error')}
        {preCheckWarnings.length > 0 &&
          !hasBlockers &&
          renderSodViolations(preCheckWarnings, 'warning')}
        <PeerCheckWarnings entries={entries} />

        {entries.length === 1 ? (
          <Form.Item
            name="justification"
            label="Justification (min 10 characters)"
            rules={[
              { required: true, message: 'Justification is required' },
              { min: 10, message: 'At least 10 characters required' },
            ]}
          >
            <TextArea rows={3} placeholder="Why do you need this access?" />
          </Form.Item>
        ) : (
          entries.map((e) => (
            <Form.Item
              key={e._id}
              name={`justification_${e._id}`}
              label={`Justification for ${e.name}`}
              rules={[
                { required: true, message: 'Required' },
                { min: 10, message: 'At least 10 characters' },
              ]}
            >
              <TextArea rows={2} placeholder="Why do you need this access?" />
            </Form.Item>
          ))
        )}

        {showDuration && (
          <Form.Item
            name="requestedDurationDays"
            label="Duration (days, optional)"
            extra={`Max ${maxDuration} days for these entitlements`}
          >
            <InputNumber min={1} max={maxDuration} style={{ width: 120 }} />
          </Form.Item>
        )}

        <Form.Item>
          <Space>
            <Button
              type="primary"
              htmlType="submit"
              loading={createMutation.isPending}
              disabled={hasBlockers}
            >
              Submit Request
            </Button>
            <Button onClick={onCancel}>Cancel</Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  );
};
