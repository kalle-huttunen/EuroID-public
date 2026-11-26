/**
 * Confirmation before an action on a dead-letter entry: says what the backend will do, including
 * that a re-run repeats the side effects of the handler (or handlers) it runs.
 */
import React from 'react';
import { Modal, Space, Typography } from 'antd';
import type { IDeadLetterEntry } from '../../interfaces';
import { eventTypeOf } from './dead-letter-labels';

const { Paragraph, Text } = Typography;

export type DeadLetterAction = 'retry' | 'replay' | 'dismiss';

const OK_TEXT: Record<DeadLetterAction, string> = {
  retry: 'Retry event',
  replay: 'Replay event',
  dismiss: 'Dismiss entry',
};

const TITLE: Record<DeadLetterAction, string> = {
  retry: 'Retry this entry?',
  replay: 'Replay this entry?',
  dismiss: 'Dismiss this entry?',
};

const SideEffects: React.FC<{ entry: IDeadLetterEntry }> = ({ entry }) => (
  <Paragraph type="warning" style={{ margin: 0 }}>
    {entry.handler
      ? 'The handler runs again, so what it does (a timeline entry, a workflow start, a webhook) can happen a second time.'
      : 'Its handlers run again, so anything the event triggers (provisioning, notifications, webhooks) can happen a second time.'}
  </Paragraph>
);

/** What a re-run runs: the failed handler alone, or every handler of the event. */
const Rerun: React.FC<{ entry: IDeadLetterEntry }> = ({ entry }) => {
  const event = <Text code>{eventTypeOf(entry) ?? entry.source}</Text>;
  return entry.handler ? (
    <>
      EuroID runs the handler that failed, <Text code>{entry.handler}</Text>, again with the stored{' '}
      {event} event and waits for it.
    </>
  ) : (
    <>EuroID emits the original {event} event again to all its handlers and waits for them.</>
  );
};

const Body: React.FC<{ action: DeadLetterAction; entry: IDeadLetterEntry }> = ({
  action,
  entry,
}) => {
  if (action === 'retry') {
    const next = Math.min(entry.retryCount + 1, entry.maxRetries);
    return (
      <>
        <Paragraph style={{ margin: 0 }}>
          <Rerun entry={entry} /> If it fails, the entry goes back to pending (attempt {next} of{' '}
          {entry.maxRetries}); at the limit it is closed as failed permanently. Otherwise it is
          closed as replayed.
        </Paragraph>
        <SideEffects entry={entry} />
      </>
    );
  }
  if (action === 'replay') {
    return (
      <>
        <Paragraph style={{ margin: 0 }}>
          <Rerun entry={entry} /> If it succeeds, the entry is closed as replayed; if it fails, the
          entry stays pending with the error. A replay does not count as a retry attempt.
        </Paragraph>
        <SideEffects entry={entry} />
      </>
    );
  }
  return (
    <Paragraph style={{ margin: 0 }}>
      The entry is closed as dismissed under your name. Nothing is re-run: fix the cause first if it
      still matters.
    </Paragraph>
  );
};

export const DeadLetterActionModal: React.FC<{
  action: DeadLetterAction | null;
  entry: IDeadLetterEntry;
  pending: boolean;
  onConfirm: (action: DeadLetterAction) => void;
  onCancel: () => void;
}> = ({ action, entry, pending, onConfirm, onCancel }) => (
  <Modal
    open={!!action}
    title={action ? TITLE[action] : ''}
    okText={action ? OK_TEXT[action] : 'OK'}
    okButtonProps={{ danger: action === 'retry' || action === 'replay' }}
    confirmLoading={pending}
    onOk={() => action && onConfirm(action)}
    onCancel={onCancel}
    destroyOnHidden
  >
    {action && (
      <Space direction="vertical" style={{ width: '100%' }}>
        <Body action={action} entry={entry} />
      </Space>
    )}
  </Modal>
);
