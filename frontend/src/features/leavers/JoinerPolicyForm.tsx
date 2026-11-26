/**
 * Tenant mass-joiner limit: how many onboarding runs one HR sync may start before it pauses for
 * approval. The smaller of the count and the percentage wins, never below the floor.
 */
import React, { useEffect } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Form,
  InputNumber,
  Row,
  Skeleton,
  Space,
  Tag,
  Typography,
} from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { useJoinerPolicy, useUpdateJoinerPolicy } from '@api/joiners-api';
import { usePermission } from '../../auth/usePermission';
import { relativeTimeNullable } from '../../utils/date-helpers';
import type { IJoinerPolicySettings } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Text } = Typography;

export const JoinerPolicyForm: React.FC = () => {
  const { message } = App.useApp();
  const [form] = Form.useForm<IJoinerPolicySettings>();
  const { data: policy, isLoading, isError } = useJoinerPolicy();
  const update = useUpdateJoinerPolicy();
  const canEdit = usePermission('policy-admin');

  useEffect(() => {
    if (policy) form.setFieldsValue(policy);
  }, [policy, form]);

  if (isLoading) return <Skeleton active paragraph={{ rows: 3 }} />;
  if (isError || !policy) {
    return <Alert type="error" showIcon message="Could not load the mass-joiner limit" />;
  }

  const save = async (values: IJoinerPolicySettings) => {
    try {
      await update.mutateAsync({
        massJoinerMaxCount: values.massJoinerMaxCount,
        massJoinerMaxPercent: values.massJoinerMaxPercent,
        massJoinerMinCount: values.massJoinerMinCount,
      });
      message.success('Mass-joiner limit saved');
    } catch (err) {
      message.error(apiErrorMessage(err, 'Could not save the mass-joiner limit'));
    }
  };

  return (
    <Card
      title="Mass-joiner limit"
      size="small"
      extra={
        policy.configured ? (
          <Text type="secondary">
            Last changed {relativeTimeNullable(policy.updatedAt ?? null)}
            {policy.updatedBy ? ` by ${policy.updatedBy}` : ''}
          </Text>
        ) : (
          <Tag color="processing">Using the defaults</Tag>
        )
      }
    >
      <Form<IJoinerPolicySettings>
        form={form}
        layout="vertical"
        initialValues={policy}
        onFinish={save}
        disabled={!canEdit}
        requiredMark={false}
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          A sync that would start more onboarding runs than the smaller of the first two limits (but
          at least the floor) starts none and waits for approval above.
        </Text>
        <Row gutter={16}>
          <Col xs={24} md={8}>
            <Form.Item
              name="massJoinerMaxCount"
              label="Identities per sync"
              rules={[{ required: true, message: 'Required' }]}
            >
              <InputNumber min={0} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item
              name="massJoinerMaxPercent"
              label="Percent of active identities"
              rules={[{ required: true, message: 'Required' }]}
            >
              <InputNumber min={0} max={100} suffix="%" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item
              name="massJoinerMinCount"
              label="Always allowed per sync (floor)"
              dependencies={['massJoinerMaxCount']}
              rules={[
                { required: true, message: 'Required' },
                ({ getFieldValue }) => ({
                  validator: (_rule, value?: number) =>
                    value === undefined || value <= getFieldValue('massJoinerMaxCount')
                      ? Promise.resolve()
                      : Promise.reject(new Error('May not exceed the identities per sync')),
                }),
              ]}
            >
              <InputNumber min={0} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        {canEdit && (
          <Space>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SaveOutlined />}
              loading={update.isPending}
            >
              Save limit
            </Button>
          </Space>
        )}
      </Form>
    </Card>
  );
};
