/**
 * A subscription's delivery history in a centered modal: one row per event delivered to it, newest
 * first, with its attempts, the receiver's last status or error and the next retry; a row expands
 * to the delivery id the receiver got and the body sent (ids only). A failed delivery without a
 * retry ahead links to its dead-letter entries (source `webhook:<subscription>:<event type>`).
 * The pager sits in the fixed footer, so it stays in reach under a long page.
 */
import React, { useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Modal,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import dayjs from 'dayjs';
import { WEBHOOK_DELIVERIES_PAGE_SIZE, useWebhookDeliveries } from '@api/webhooks-api';
import { ErrorState } from '@shared/ErrorState';
import { EmptyState } from '@shared/EmptyState';
import type { IWebhookDelivery, IWebhookSubscription } from '../../interfaces';
import {
  DELIVERY_STATUS_LABEL,
  DELIVERY_STATUS_TAG,
  deadLetterHref,
  deadLetterSource,
  mayBeDeadLettered,
  retryOf,
  waitsForSubscription,
} from './webhook-labels';

const { Paragraph, Text } = Typography;

/** antd caps a modal at the viewport less 32 px; at 1440 px the whole table fits. */
const MODAL_WIDTH = 1280;
/**
 * The sum of the column widths: the table fits the modal body (1232 px) at 1440 px and scrolls
 * sideways inside the modal on a narrower screen.
 */
const TABLE_MIN_WIDTH = 1200;

const formatTime = (iso?: string) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm:ss') : '');

const SENDING_HINT =
  'Being sent, the first time or as a retry. A send not finished after a minute (unless the deployment sets another time) was interrupted, for example by a restart: the retry poller sends it again and counts the interrupted send as an attempt.';

const DeliveryDetails: React.FC<{ delivery: IWebhookDelivery }> = ({ delivery }) => {
  const { token } = theme.useToken();
  return (
    <Descriptions size="small" column={1} bordered>
      <Descriptions.Item label="Delivery id (X-EuroID-Delivery)">
        <Text code copyable>
          {delivery._id}
        </Text>
      </Descriptions.Item>
      <Descriptions.Item label="Event id">
        <Text code copyable>
          {delivery.eventId}
        </Text>
      </Descriptions.Item>
      {delivery.updatedAt && (
        <Descriptions.Item label="Last change">{formatTime(delivery.updatedAt)}</Descriptions.Item>
      )}
      <Descriptions.Item label="Body sent">
        {delivery.body ? (
          <pre
            aria-label="Delivery body"
            style={{
              margin: 0,
              fontSize: 12,
              background: token.colorFillQuaternary,
              padding: 8,
              borderRadius: token.borderRadius,
              overflowX: 'auto',
            }}
          >
            {JSON.stringify(delivery.body, null, 2)}
          </pre>
        ) : (
          <Text type="secondary">Not kept for deliveries recorded before bodies were stored.</Text>
        )}
      </Descriptions.Item>
    </Descriptions>
  );
};

export const WebhookDeliveriesModal: React.FC<{
  subscription: IWebhookSubscription | null;
  onClose: () => void;
}> = ({ subscription, onClose }) => {
  const [page, setPage] = useState(0);
  const deliveries = useWebhookDeliveries(subscription?._id, page);

  if (!subscription) return null;

  // "Passed" is judged at the time the rows were loaded (a pure render).
  const now = deliveries.dataUpdatedAt;
  const items = deliveries.data?.items ?? [];
  const active = subscription.status === 'ACTIVE';
  const waitingForResume = items.some((d) => waitsForSubscription(d, active));

  const close = () => {
    setPage(0);
    onClose();
  };

  const columns: ColumnsType<IWebhookDelivery> = [
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (iso: string) => formatTime(iso),
    },
    {
      title: 'Event',
      dataIndex: 'eventType',
      key: 'eventType',
      width: 190,
      ellipsis: { showTitle: false },
      render: (type: string) => (
        <Tooltip title={type}>
          <Text code>{type}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: IWebhookDelivery['status']) => {
        const tag = (
          <Tag color={DELIVERY_STATUS_TAG[status]}>{DELIVERY_STATUS_LABEL[status] ?? status}</Tag>
        );
        return status === 'PENDING' ? <Tooltip title={SENDING_HINT}>{tag}</Tooltip> : tag;
      },
    },
    {
      title: 'Response',
      dataIndex: 'httpStatus',
      key: 'httpStatus',
      width: 90,
      // Empty when the receiver could not be reached.
      render: (code?: number) => code ?? null,
    },
    { title: 'Attempts', dataIndex: 'attempts', key: 'attempts', width: 80 },
    {
      title: 'Next retry',
      key: 'nextRetry',
      width: 180,
      render: (_: unknown, delivery) => {
        const retry = retryOf(delivery, now);
        if (!retry) return null;
        return (
          <span>
            {formatTime(retry.at)}
            {retry.passed && <Text type="secondary"> (passed)</Text>}
          </span>
        );
      },
    },
    {
      title: 'Error',
      dataIndex: 'lastError',
      key: 'lastError',
      width: 240,
      // Whole, wrapping: the reason is what the admin opens the history for.
      render: (error?: string) => <span style={{ overflowWrap: 'anywhere' }}>{error}</span>,
    },
    {
      title: '',
      key: 'deadLetter',
      width: 100,
      render: (_: unknown, delivery) =>
        mayBeDeadLettered(delivery, now, active) ? (
          <Tooltip title="Dead-letter entries for this subscription and event type. A delivery is there once its last attempt failed.">
            <Link
              to={deadLetterHref(deadLetterSource(subscription._id, delivery.eventType))}
              aria-label={`Dead-letter entries for ${delivery.eventType}`}
            >
              Dead letter
            </Link>
          </Tooltip>
        ) : null,
    },
  ];

  let body: React.ReactNode;
  if (deliveries.isLoading) {
    body = <Table<IWebhookDelivery> loading size="small" columns={columns} dataSource={[]} />;
  } else if (deliveries.isError) {
    body = (
      <ErrorState
        compact
        title="Could not load the delivery history"
        error={deliveries.error}
        onRetry={() => deliveries.refetch()}
      />
    );
  } else if (!items.length) {
    body = (
      <EmptyState
        title={page ? 'No older deliveries' : 'No deliveries yet'}
        description={
          page
            ? undefined
            : 'A delivery is recorded when an event this subscription names happens while it is active. Test deliveries are not recorded.'
        }
      />
    );
  } else {
    body = (
      <Table<IWebhookDelivery>
        size="small"
        rowKey="_id"
        columns={columns}
        dataSource={items}
        pagination={false}
        tableLayout="fixed"
        scroll={{ x: TABLE_MIN_WIDTH }}
        expandable={{
          columnWidth: 48,
          expandedRowRender: (delivery) => <DeliveryDetails delivery={delivery} />,
        }}
      />
    );
  }

  const footer = (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        textAlign: 'start',
      }}
    >
      <Link to={deadLetterHref(deadLetterSource(subscription._id))}>
        All dead-letter entries of this subscription
      </Link>
      <Space wrap>
        <Text type="secondary">Page {page + 1}</Text>
        <Button
          icon={<LeftOutlined />}
          disabled={page === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
        >
          Newer
        </Button>
        <Button
          icon={<RightOutlined />}
          iconPosition="end"
          disabled={!deliveries.data?.hasMore}
          onClick={() => setPage((p) => p + 1)}
        >
          Older
        </Button>
      </Space>
    </div>
  );

  return (
    <Modal
      open
      onCancel={close}
      width={MODAL_WIDTH}
      title={`Deliveries: ${subscription.name}`}
      footer={footer}
      styles={{ body: { maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' } }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Paragraph type="secondary" style={{ margin: 0 }}>
          {WEBHOOK_DELIVERIES_PAGE_SIZE} per page, newest first, kept for 30 days. A failed delivery
          is sent again after 1, 5, 25 and 125 seconds (the retry poller runs every 30 seconds).
          After its last attempt (5 unless the deployment sets another limit) it goes to the
          dead-letter queue, where it can be retried.
        </Paragraph>
        {waitingForResume && (
          <Alert
            type="warning"
            showIcon
            message="Retries are waiting for this subscription"
            description="A retry fell due while this subscription was paused or did not name the event. Such a delivery keeps its attempts and waits; it is sent again once the subscription is active and names the event, and never if the subscription is deleted."
          />
        )}
        <div role="region" aria-label="Delivery attempts" aria-busy={deliveries.isFetching}>
          {body}
        </div>
      </Space>
    </Modal>
  );
};
