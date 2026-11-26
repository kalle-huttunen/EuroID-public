/**
 * Outbound webhooks: the tenant's event subscriptions, each sending the events it names to an
 * HTTPS endpoint as signed POSTs with ids only. A super-admin creates and edits them (centered
 * modal), pauses and resumes, deletes, sends a test delivery and reads a subscription's delivery
 * history (centered modal). Route, nav entry and every route of the API need super-admin.
 */
import React, { useState } from 'react';
import { App, Button, Card, Result, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  HistoryOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  useDeleteWebhook,
  useTestWebhook,
  useUpdateWebhook,
  useWebhookSubscriptions,
  webhookKeys,
} from '@api/webhooks-api';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { EmptyState } from '@shared/EmptyState';
import { ErrorState } from '@shared/ErrorState';
import { usePermission } from '../../auth/usePermission';
import type { IWebhookSubscription, IWebhookTestResult } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { STATUS_LABEL, STATUS_TAG } from './webhook-labels';
import { WebhookFormModal } from './WebhookFormModal';
import { WebhookDeliveriesModal } from './WebhookDeliveriesModal';

const { Paragraph, Text } = Typography;

/** Below this width (phones) the table scrolls sideways instead of squeezing every column. */
const TABLE_MIN_WIDTH = 940;
/** Event types shown per row before "+N". */
const EVENT_TAGS_SHOWN = 3;

/** The receiver's status for a refusal, otherwise the error (unreachable, redirect). */
const testFailure = (result: IWebhookTestResult) =>
  result.httpStatus !== undefined && result.httpStatus >= 400
    ? `The receiver answered ${result.httpStatus}.`
    : (result.error ?? result.message);

export const WebhooksPage: React.FC = () => {
  const qc = useQueryClient();
  const { modal, message, notification } = App.useApp();
  const isSuperAdmin = usePermission('super-admin');
  const list = useWebhookSubscriptions(isSuperAdmin);
  const update = useUpdateWebhook();
  const remove = useDeleteWebhook();
  const test = useTestWebhook();
  /**
   * The form modal; `subscription` null creates one. Kept while closing, so the title holds. Each
   * open is a new `session`, which remounts the form: a kept form carried a secret generated in
   * Create into the next Edit, where Save would have rotated the subscription's secret.
   */
  const [form, setForm] = useState<{
    open: boolean;
    subscription: IWebhookSubscription | null;
    session: number;
  }>({ open: false, subscription: null, session: 0 });
  const openForm = (subscription: IWebhookSubscription | null) =>
    setForm((f) => ({ open: true, subscription, session: f.session + 1 }));
  const [history, setHistory] = useState<IWebhookSubscription | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const subscriptions = list.data ?? [];

  const sendTest = async (sub: IWebhookSubscription) => {
    setTestingId(sub._id);
    try {
      const result = await test.mutateAsync(sub._id);
      if (result.success) {
        notification.success({
          message: `Test delivered to ${sub.name}`,
          description: `The receiver answered ${result.httpStatus}. Delivery id ${result.deliveryId}.`,
        });
      } else {
        notification.error({
          message: `Test not delivered to ${sub.name}`,
          description: testFailure(result),
          duration: 0,
        });
      }
    } catch (err) {
      notification.error({
        message: `Test not sent to ${sub.name}`,
        description: apiErrorMessage(err, 'the request failed'),
        duration: 0,
      });
    } finally {
      setTestingId(null);
    }
  };

  const setStatus = async (sub: IWebhookSubscription, status: 'ACTIVE' | 'PAUSED') => {
    try {
      await update.mutateAsync({ id: sub._id, body: { status } });
      message.success(
        status === 'PAUSED'
          ? `${sub.name} paused.`
          : `${sub.name} resumed. Retries that were waiting are sent by the next retry poll.`,
      );
    } catch (err) {
      message.error(
        `${status === 'PAUSED' ? 'Pause' : 'Resume'} failed: ${apiErrorMessage(err, 'the request failed')}`,
      );
    }
  };

  const confirmPause = (sub: IWebhookSubscription) =>
    modal.confirm({
      title: `Pause ${sub.name}?`,
      content:
        'EuroID stops sending events to it. Events that happen while it is paused are not delivered later; retries of earlier deliveries wait until it is resumed.',
      okText: 'Pause subscription',
      onOk: () => setStatus(sub, 'PAUSED'),
    });

  const confirmDelete = (sub: IWebhookSubscription) =>
    modal.confirm({
      title: `Delete ${sub.name}?`,
      content:
        'EuroID stops sending events to it at once and deliveries waiting for a retry are not sent. Its delivery history can no longer be opened here. Dead-letter entries of its deliveries stay, but retrying them fails.',
      okText: 'Delete subscription',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await remove.mutateAsync(sub._id);
          message.success(`${sub.name} deleted.`);
        } catch (err) {
          message.error(`Delete failed: ${apiErrorMessage(err, 'the request failed')}`);
        }
      },
    });

  const columns: ColumnsType<IWebhookSubscription> = [
    {
      title: 'Subscription',
      key: 'name',
      width: 300,
      render: (_: unknown, sub) => (
        <div style={{ minWidth: 0 }}>
          <Text strong ellipsis={{ tooltip: sub.name }} style={{ display: 'block' }}>
            {sub.name}
          </Text>
          <Text
            type="secondary"
            ellipsis={{ tooltip: sub.webhook.url }}
            style={{ display: 'block', fontSize: 12 }}
          >
            {sub.webhook.url}
          </Text>
        </div>
      ),
    },
    {
      title: 'Event types',
      key: 'eventTypes',
      render: (_: unknown, sub) => {
        const types = sub.filters.eventTypes;
        const rest = types.slice(EVENT_TAGS_SHOWN);
        return (
          <Space size={[4, 4]} wrap>
            {types.slice(0, EVENT_TAGS_SHOWN).map((type) => (
              <Tag key={type} style={{ marginInlineEnd: 0 }}>
                {type}
              </Tag>
            ))}
            {rest.length > 0 && (
              <Tooltip title={rest.join(', ')}>
                <Tag style={{ marginInlineEnd: 0 }}>+{rest.length}</Tag>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: IWebhookSubscription['status']) => (
        <Tag color={STATUS_TAG[status]}>{STATUS_LABEL[status] ?? status}</Tag>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 110,
      render: (iso: string) => dayjs(iso).format('YYYY-MM-DD'),
    },
    {
      title: '',
      key: 'actions',
      width: 190,
      render: (_: unknown, sub) => {
        const active = sub.status === 'ACTIVE';
        return (
          <Space size={4}>
            <Tooltip title="Delivery history">
              <Button
                size="small"
                icon={<HistoryOutlined />}
                aria-label={`Deliveries of ${sub.name}`}
                onClick={() => setHistory(sub)}
              />
            </Tooltip>
            <Tooltip title="Send a test delivery">
              <Button
                size="small"
                icon={<SendOutlined />}
                aria-label={`Send a test to ${sub.name}`}
                loading={testingId === sub._id}
                disabled={!!testingId && testingId !== sub._id}
                onClick={() => sendTest(sub)}
              />
            </Tooltip>
            <Tooltip title="Edit">
              <Button
                size="small"
                icon={<EditOutlined />}
                aria-label={`Edit ${sub.name}`}
                onClick={() => openForm(sub)}
              />
            </Tooltip>
            <Tooltip title={active ? 'Pause' : 'Resume'}>
              <Button
                size="small"
                icon={active ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                aria-label={`${active ? 'Pause' : 'Resume'} ${sub.name}`}
                disabled={update.isPending}
                onClick={() => (active ? confirmPause(sub) : setStatus(sub, 'ACTIVE'))}
              />
            </Tooltip>
            <Tooltip title="Delete">
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                aria-label={`Delete ${sub.name}`}
                onClick={() => confirmDelete(sub)}
              />
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  if (!isSuperAdmin) {
    return (
      <PageContainer>
        <PageHeader title="Webhooks" />
        <Result status="403" title="Webhooks need the super-admin role." />
      </PageContainer>
    );
  }

  let body: React.ReactNode;
  if (list.isLoading) {
    body = <Skeleton active paragraph={{ rows: 4 }} />;
  } else if (list.isError) {
    body = (
      <ErrorState
        title="Could not load the webhook subscriptions"
        error={list.error}
        onRetry={() => list.refetch()}
      />
    );
  } else if (!subscriptions.length) {
    body = (
      <EmptyState
        title="No webhook subscriptions yet"
        description="Create one to send EuroID events to a SIEM, a ticketing system or your own service."
        action={{
          label: 'New subscription',
          icon: <PlusOutlined />,
          onClick: () => openForm(null),
        }}
      />
    );
  } else {
    body = (
      <Table<IWebhookSubscription>
        size="small"
        rowKey="_id"
        columns={columns}
        dataSource={subscriptions}
        pagination={false}
        tableLayout="fixed"
        scroll={{ x: TABLE_MIN_WIDTH }}
      />
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Webhooks"
        subtitle="Send EuroID events to external systems as signed HTTPS POSTs."
        actions={
          <>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => qc.invalidateQueries({ queryKey: webhookKeys.all })}
            >
              Refresh
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm(null)}>
              New subscription
            </Button>
          </>
        }
      />
      <Card size="small" style={{ marginBottom: 16 }} title="What a webhook carries">
        <Paragraph style={{ marginBottom: 8 }}>
          Ids only: the event's id, type and time, the id of the record it is about, and the
          identity, policy, campaign, drift or anomaly id when the event has one. No names, email
          addresses or other personal data: the receiver looks them up in EuroID.
        </Paragraph>
        <Paragraph type="secondary" style={{ margin: 0 }}>
          <Text code>X-EuroID-Signature</Text> is sha256= and the HMAC-SHA256 of the raw body with
          the subscription's signing secret; <Text code>X-EuroID-Event</Text> names the event type
          and <Text code>X-EuroID-Delivery</Text> the delivery, the same id on every retry.
        </Paragraph>
      </Card>
      <Card
        size="small"
        role="region"
        aria-label="Webhook subscriptions"
        aria-busy={list.isFetching}
      >
        {body}
      </Card>
      <WebhookFormModal
        key={form.session}
        open={form.open}
        subscription={form.subscription}
        namesInUse={subscriptions.map((s) => s.name)}
        onClose={() => setForm((f) => ({ ...f, open: false }))}
      />
      <WebhookDeliveriesModal subscription={history} onClose={() => setHistory(null)} />
    </PageContainer>
  );
};
