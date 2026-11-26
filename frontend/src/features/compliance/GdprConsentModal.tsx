/**
 * Record a consent grant (POST /identity/:id/consent, operator): a purpose, how it was collected
 * and an optional expiry date, as GrantConsentSchema takes them. A purpose that already has a
 * record is granted again: its date, method and expiry are replaced and a revocation is cleared.
 * The API's message is shown on a refusal.
 */
import React, { useState } from 'react';
import { Alert, App, AutoComplete, DatePicker, Form, Modal, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import type { IdentityOption } from '@api/identity-api';
import { useConsentReport, useGrantConsent } from '@api/gdpr-api';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import type { IConsentGrant } from '../../interfaces';
import { CONSENT_METHODS, identityLabel } from './gdpr-labels';

const { Text } = Typography;

interface FormValues {
  purpose: string;
  method?: string;
  expiresAt?: Dayjs;
}

export const GdprConsentModal: React.FC<{
  identity: IdentityOption;
  /** The purpose to grant again; absent for a new one. */
  purpose?: string;
  onClose: () => void;
}> = ({ identity, purpose, onClose }) => {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const grant = useGrantConsent();
  // Purposes already in use in the tenant, as suggestions (the API takes any text).
  const report = useConsentReport();
  const [error, setError] = useState<string | null>(null);

  const submit = async (values: FormValues) => {
    setError(null);
    const body: IConsentGrant = {
      purpose: values.purpose.trim(),
      ...(values.method?.trim() ? { method: values.method.trim() } : {}),
      ...(values.expiresAt ? { expiresAt: values.expiresAt.endOf('day').toISOString() } : {}),
    };
    try {
      await grant.mutateAsync({ identityId: identity.id, grant: body });
      message.success(`Consent for ${body.purpose} recorded.`);
      onClose();
    } catch (err) {
      setError(`Consent not recorded: ${apiErrorMessage(err, 'the request failed')}`);
    }
  };

  return (
    <Modal
      open
      centered
      title={purpose ? `Grant ${purpose} again` : 'Record consent'}
      okText="Record consent"
      confirmLoading={grant.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
    >
      <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
        For {identityLabel(identity)}. A purpose that already has a record is granted again: its
        date, method and expiry are replaced and a revocation is cleared.
      </Text>
      <Form<FormValues>
        form={form}
        name="gdpr-consent"
        layout="vertical"
        requiredMark={false}
        initialValues={{ purpose }}
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
        <Form.Item
          name="purpose"
          label="Purpose"
          rules={[{ required: true, whitespace: true, message: 'Enter the purpose' }]}
        >
          <AutoComplete
            disabled={!!purpose}
            placeholder="e.g. data_processing, analytics, marketing"
            options={(report.data?.byPurpose ?? []).map((p) => ({ value: p.purpose }))}
            filterOption={(input, option) =>
              String(option?.value ?? '')
                .toLowerCase()
                .includes(input.toLowerCase())
            }
          />
        </Form.Item>
        <Form.Item name="method" label="How it was collected">
          <AutoComplete
            placeholder="e.g. web-form, email, contract"
            options={CONSENT_METHODS.map((m) => ({ value: m }))}
          />
        </Form.Item>
        <Form.Item
          name="expiresAt"
          label="Expires"
          extra="Optional. EuroID does not revoke the consent on this date; the list marks it past expiry."
        >
          <DatePicker
            style={{ width: '100%', maxWidth: 240 }}
            disabledDate={(d) => d.isBefore(dayjs(), 'day')}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};
