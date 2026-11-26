/**
 * One dead-letter entry in a centered modal: what failed, why, the masked payload, and the actions
 * the viewer's role and the entry allow (retry and replay: super-admin, an entry carrying a domain
 * event; dismiss: operator). Each action is confirmed first and reports what actually happened.
 * The body scrolls under a fixed title and footer, so the actions stay in reach of a long payload.
 */
import React, { useState } from 'react';
import { Alert, Button, Descriptions, Modal, Space, Tag, Typography, theme } from 'antd';
import { RedoOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  useDeadLetter,
  useDismissDeadLetter,
  useReplayDeadLetter,
  useRetryDeadLetter,
} from '@api/dead-letter-api';
import { usePermission } from '../../auth/usePermission';
import type { IDeadLetterEntry } from '../../interfaces';
import { DeadLetterActionModal, type DeadLetterAction } from './DeadLetterActionModal';
import {
  DISMISS_OUTCOME,
  STATUS_LABEL,
  STATUS_TAG,
  TYPE_LABEL,
  apiErrorMessage,
  canDismiss,
  canReplay,
  canRetry,
  replayOutcome,
  rerunBlocker,
  retryOutcome,
  type ActionOutcome,
} from './dead-letter-labels';

const { Paragraph, Text } = Typography;

const formatTime = (iso?: string) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm:ss') : undefined);

/** Fits a pretty-printed event payload; on narrow screens Ant Design caps it at the viewport. */
const MODAL_WIDTH = 880;

const ACTION_NAME: Record<DeadLetterAction, string> = {
  retry: 'Retry',
  replay: 'Replay',
  dismiss: 'Dismiss',
};

export const DeadLetterDetailModal: React.FC<{
  /** The row the modal opened from; the entry is re-read from GET /dead-letter/:id. */
  row: IDeadLetterEntry | null;
  onClose: () => void;
}> = ({ row, onClose }) => {
  const { token } = theme.useToken();
  const isSuperAdmin = usePermission('super-admin');
  const isOperator = usePermission('operator');
  const detail = useDeadLetter(row?._id);
  const entry = detail.data ?? row;
  const retry = useRetryDeadLetter();
  const replay = useReplayDeadLetter();
  const dismiss = useDismissDeadLetter();
  const [action, setAction] = useState<DeadLetterAction | null>(null);
  // The last action's result, shown only for the entry it was run on.
  const [result, setResult] = useState<{ id: string; outcome: ActionOutcome } | null>(null);

  if (!entry) return null;

  const outcome = result?.id === entry._id ? result.outcome : null;
  const setOutcome = (next: ActionOutcome | null) =>
    setResult(next ? { id: entry._id, outcome: next } : null);

  const blocker = rerunBlocker(entry);
  const closed =
    !blocker && !canRetry(entry) && !canReplay(entry)
      ? `the entry is already ${STATUS_LABEL[entry.status].toLowerCase()}.`
      : undefined;
  const pending = retry.isPending || replay.isPending || dismiss.isPending;

  const run = async (chosen: DeadLetterAction) => {
    try {
      if (chosen === 'retry') {
        const { entry: after } = await retry.mutateAsync(entry._id);
        setOutcome(retryOutcome(after));
      } else if (chosen === 'replay') {
        const { entry: after } = await replay.mutateAsync(entry._id);
        setOutcome(replayOutcome(after));
      } else {
        await dismiss.mutateAsync(entry._id);
        setOutcome(DISMISS_OUTCOME);
      }
    } catch (err) {
      setOutcome({
        type: 'error',
        message: `${ACTION_NAME[chosen]} failed: ${apiErrorMessage(err, 'the request failed')}`,
        description: 'The entry below shows its current state.',
      });
    } finally {
      setAction(null);
    }
  };

  const note = !isSuperAdmin
    ? 'Retry and replay need the super-admin role.'
    : blocker || closed
      ? `Retry and replay are not available: ${blocker ?? closed}`
      : undefined;

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
      <Text type="secondary" style={{ fontSize: 12, flex: '1 1 240px' }}>
        {note}
      </Text>
      <Space wrap>
        {isSuperAdmin && (
          <>
            <Button
              type="primary"
              icon={<RedoOutlined />}
              disabled={!canRetry(entry) || pending}
              onClick={() => setAction('retry')}
            >
              Retry
            </Button>
            <Button
              icon={<ReloadOutlined />}
              disabled={!canReplay(entry) || pending}
              onClick={() => setAction('replay')}
            >
              Replay
            </Button>
          </>
        )}
        {isOperator && (
          <Button
            icon={<StopOutlined />}
            disabled={!canDismiss(entry) || pending}
            onClick={() => setAction('dismiss')}
          >
            Dismiss
          </Button>
        )}
      </Space>
    </div>
  );

  return (
    <Modal
      open={!!row}
      onCancel={() => {
        setResult(null);
        onClose();
      }}
      width={MODAL_WIDTH}
      title={
        <Space size={8} wrap>
          <Text code style={{ wordBreak: 'break-all' }}>
            {entry.source}
          </Text>
          <Tag color={STATUS_TAG[entry.status]}>{STATUS_LABEL[entry.status]}</Tag>
        </Space>
      }
      footer={isOperator ? footer : null}
      styles={{ body: { maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' } }}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {outcome && (
          <Alert
            showIcon
            closable
            type={outcome.type}
            message={outcome.message}
            description={outcome.description}
            onClose={() => setOutcome(null)}
          />
        )}
        {detail.isError && (
          <Alert
            type="warning"
            showIcon
            message="Could not reload this entry; showing it as listed."
          />
        )}
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="Type">{TYPE_LABEL[entry.type] ?? entry.type}</Descriptions.Item>
          <Descriptions.Item label="Captured">{formatTime(entry.createdAt)}</Descriptions.Item>
          {entry.handler && (
            <Descriptions.Item label="Handler">
              <Text code>{entry.handler}</Text>
            </Descriptions.Item>
          )}
          <Descriptions.Item label="Error">
            <Paragraph style={{ margin: 0 }}>
              {entry.error?.message}
              {entry.error?.code && <Text type="secondary"> (code {entry.error.code})</Text>}
            </Paragraph>
          </Descriptions.Item>
          <Descriptions.Item label="Retries">
            {entry.retryCount} of {entry.maxRetries}
          </Descriptions.Item>
          {entry.lastRetryError && (
            <Descriptions.Item label="Last retry error">{entry.lastRetryError}</Descriptions.Item>
          )}
          {entry.resolvedBy && (
            <Descriptions.Item label="Closed by">
              {entry.resolvedBy}
              {entry.resolvedAt && <Text type="secondary"> on {formatTime(entry.resolvedAt)}</Text>}
            </Descriptions.Item>
          )}
          {entry.correlationId && (
            <Descriptions.Item label="Correlation id">
              <Text code copyable>
                {entry.correlationId}
              </Text>
            </Descriptions.Item>
          )}
        </Descriptions>
        <div>
          <Text strong>Payload</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
            As captured; the API masks secrets, email addresses and phone number fields.
          </Text>
          <pre
            aria-label="Entry payload"
            style={{
              margin: 0,
              fontSize: 12,
              background: token.colorFillQuaternary,
              padding: 12,
              borderRadius: token.borderRadius,
              overflowX: 'auto',
            }}
          >
            {JSON.stringify(entry.originalPayload ?? {}, null, 2)}
          </pre>
        </div>
        {entry.error?.stack && (
          <details>
            <summary>
              <Text type="secondary">Stack trace</Text>
            </summary>
            <pre style={{ fontSize: 11, overflowX: 'auto', margin: '8px 0 0' }}>
              {entry.error.stack}
            </pre>
          </details>
        )}
      </Space>
      <DeadLetterActionModal
        action={action}
        entry={entry}
        pending={pending}
        onConfirm={run}
        onCancel={() => setAction(null)}
      />
    </Modal>
  );
};
