/**
 * Tenant leaver policy: which HR signals offboard someone, how long a person may be missing
 * from a feed, the mass-leaver limit and the time zone in which an end date's day ends.
 */
import React, { useEffect, useMemo } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Form,
  InputNumber,
  Row,
  Select,
  Skeleton,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { useLeaverPolicy, useUpdateLeaverPolicy } from '@api/leavers-api';
import { usePermission } from '../../auth/usePermission';
import { relativeTimeNullable } from '../../utils/date-helpers';
import type { ILeaverPolicySettings } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Text } = Typography;

function timeZoneOptions(current?: string): Array<{ label: string; value: string }> {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  const zones = new Set<string>(['UTC', ...(supported ? supported('timeZone') : [])]);
  if (current) zones.add(current);
  return [...zones].map((z) => ({ label: z, value: z }));
}

const SIGNALS: Array<{
  name: keyof ILeaverPolicySettings['signals'];
  label: string;
  help: string;
}> = [
  {
    name: 'terminated',
    label: 'HR status marks the person as left',
    help: 'Offboards at the end of the termination date, or at once when the record has none.',
  },
  {
    name: 'endDate',
    label: 'Employment end date has passed',
    help: 'Offboards the day after the end date, in the time zone below.',
  },
  {
    name: 'missingFromSource',
    label: 'Person is missing from the HR feed',
    help: 'Only full syncs count: a failed or partial sync never adds a miss. Reappearing resets the count.',
  },
];

export const LeaverPolicyForm: React.FC = () => {
  const { message } = App.useApp();
  const [form] = Form.useForm<ILeaverPolicySettings>();
  const { data: policy, isLoading, isError } = useLeaverPolicy();
  const update = useUpdateLeaverPolicy();
  const canEdit = usePermission('policy-admin');
  const zones = useMemo(() => timeZoneOptions(policy?.timezone), [policy?.timezone]);

  useEffect(() => {
    if (policy) form.setFieldsValue(policy);
  }, [policy, form]);

  if (isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (isError || !policy) {
    return <Alert type="error" showIcon message="Could not load the leaver policy" />;
  }

  const save = async (values: ILeaverPolicySettings) => {
    try {
      await update.mutateAsync({
        signals: values.signals,
        terminatedStatuses: values.terminatedStatuses,
        missingSyncThreshold: values.missingSyncThreshold,
        massLeaverMaxCount: values.massLeaverMaxCount,
        massLeaverMaxPercent: values.massLeaverMaxPercent,
        massLeaverMinCount: values.massLeaverMinCount,
        timezone: values.timezone,
      });
      message.success('Leaver policy saved');
    } catch (err) {
      message.error(apiErrorMessage(err, 'Could not save the leaver policy'));
    }
  };

  return (
    <Form<ILeaverPolicySettings>
      form={form}
      layout="vertical"
      initialValues={policy}
      onFinish={save}
      disabled={!canEdit}
      requiredMark={false}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space wrap size={8}>
          {policy.configured ? (
            <Text type="secondary">
              Last changed {relativeTimeNullable(policy.updatedAt ?? null)}
              {policy.updatedBy ? ` by ${policy.updatedBy}` : ''}
            </Text>
          ) : (
            <Tag color="processing">Using the defaults</Tag>
          )}
        </Space>

        <Card title="Leaver signals" size="small">
          {SIGNALS.map((s) => (
            <Form.Item key={s.name} style={{ marginBottom: 12 }}>
              <Space align="start" size={12}>
                <Form.Item name={['signals', s.name]} valuePropName="checked" noStyle>
                  <Switch aria-label={s.label} />
                </Form.Item>
                <div>
                  <Text strong>{s.label}</Text>
                  <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                    {s.help}
                  </Text>
                </div>
              </Space>
            </Form.Item>
          ))}
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item
                name="terminatedStatuses"
                label="HR status words that mean left"
                extra="Compared without case. Map the HR status column per connector (CSV: Status, JSON: status)."
                rules={[
                  { required: true, type: 'array', min: 1, message: 'Add at least one word' },
                ]}
              >
                <Select mode="tags" tokenSeparators={[',']} placeholder="terminated" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="missingSyncThreshold"
                label="Missing for consecutive full syncs"
                rules={[{ required: true, message: 'Required' }]}
              >
                <InputNumber min={1} max={30} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        <Card title="Mass-leaver limit" size="small">
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            A sync that would offboard more than the smaller of the first two limits (but at least
            the floor) starts nobody and waits for approval on the Pending tab.
          </Text>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item
                name="massLeaverMaxCount"
                label="Identities per sync"
                rules={[{ required: true, message: 'Required' }]}
              >
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                name="massLeaverMaxPercent"
                label="Percent of active identities"
                rules={[{ required: true, message: 'Required' }]}
              >
                <InputNumber min={0} max={100} suffix="%" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                name="massLeaverMinCount"
                label="Always allowed per sync (floor)"
                dependencies={['massLeaverMaxCount']}
                rules={[
                  { required: true, message: 'Required' },
                  ({ getFieldValue }) => ({
                    validator: (_rule, value?: number) =>
                      value === undefined || value <= getFieldValue('massLeaverMaxCount')
                        ? Promise.resolve()
                        : Promise.reject(new Error('May not exceed the identities per sync')),
                  }),
                ]}
              >
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        <Card title="Time zone" size="small">
          <Form.Item
            name="timezone"
            label="End dates end at midnight in"
            rules={[{ required: true, message: 'Required' }]}
            style={{ marginBottom: 0, maxWidth: 420 }}
          >
            <Select showSearch options={zones} optionFilterProp="label" />
          </Form.Item>
        </Card>

        {canEdit && (
          <div>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SaveOutlined />}
              loading={update.isPending}
            >
              Save policy
            </Button>
          </div>
        )}
      </Space>
    </Form>
  );
};
