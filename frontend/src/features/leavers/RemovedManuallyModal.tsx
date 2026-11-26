/**
 * Close a failed offboarding target: the admin confirms they removed the account in the target
 * system by hand and says how. EuroID records it as "removed manually" (never as removed by
 * EuroID); when it was the last failed target, the Golden Record is deleted. The API refuses that
 * while a linked admin account of the person is still live; the dialog shows its message.
 */
import React, { useState } from 'react';
import { App, Input, Modal, Space, Typography } from 'antd';
import { useMarkRemovedManually } from '@api/leavers-api';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Paragraph, Text } = Typography;

export interface RemovedManuallyTarget {
  /** The offboarding (workflow id) whose target is closed. */
  workflowId: string;
  displayName: string;
  system: string;
  /** Why offboarding failed there. */
  failure?: string;
  /** No other target of this offboarding is failed: closing it deletes the Golden Record. */
  last: boolean;
}

/** A failure reason ends its sentence: "Okta API rate limit exceeded" gets a full stop. */
const asSentence = (text: string) => {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

export const RemovedManuallyModal: React.FC<{
  target: RemovedManuallyTarget | null;
  onClose: () => void;
}> = ({ target, onClose }) => {
  const { message } = App.useApp();
  const mark = useMarkRemovedManually();
  const [reason, setReason] = useState('');

  const close = () => {
    setReason('');
    onClose();
  };

  const confirm = async () => {
    if (!target || !reason.trim()) return;
    try {
      await mark.mutateAsync({
        workflowId: target.workflowId,
        system: target.system,
        reason: reason.trim(),
      });
      message.success(
        target.last
          ? `${target.system} closed: offboarding complete, Golden Record deleted`
          : `${target.system} recorded as removed manually`,
      );
      close();
    } catch (err) {
      // The API says why, e.g. a linked admin account of the person is still live (409)
      message.error(apiErrorMessage(err, 'Could not record the removal'));
    }
  };

  return (
    <Modal
      open={!!target}
      title={target ? `Removed manually: ${target.system}` : ''}
      okText="Record as removed manually"
      okButtonProps={{ danger: target?.last, disabled: !reason.trim() }}
      confirmLoading={mark.isPending}
      onOk={confirm}
      onCancel={close}
      destroyOnHidden
    >
      {target && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Paragraph style={{ margin: 0 }}>
            EuroID could not remove {target.displayName}&apos;s access in{' '}
            <Text code>{target.system}</Text>
            {target.failure ? `: ${asSentence(target.failure)}` : '.'}
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            Confirm only after you have removed the account in {target.system} yourself. It is
            recorded with your name as removed manually, not as removed by EuroID.
          </Paragraph>
          {target.last && (
            <Paragraph type="warning" style={{ margin: 0 }}>
              This is the last failed target: the offboarding completes and the Golden Record is
              deleted.
            </Paragraph>
          )}
          <Input.TextArea
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="How and when was the account removed? (required)"
            aria-label="Removal note"
          />
        </Space>
      )}
    </Modal>
  );
};
