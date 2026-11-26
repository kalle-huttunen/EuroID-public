/**
 * Closing an ACTIVE access request whose removal at its end date keeps failing, after the admin
 * removed the access in the target by hand (policy-admin, as the backend route): a required note,
 * then POST /access-requests/:id/removed-manually. The request ends EXPIRED, recorded with the
 * admin's name as removed manually, never as removed by EuroID, and its workflow stops retrying.
 */
import React, { useState } from 'react';
import { App, Input, Modal, Space, Typography } from 'antd';
import { useMarkRemovedManually, type AccessRequest } from '@api/access-requests-api';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Paragraph } = Typography;

export const RemovedManuallyModal: React.FC<{
  request: AccessRequest;
  open: boolean;
  onClose: () => void;
}> = ({ request, open, onClose }) => {
  const { message } = App.useApp();
  const mark = useMarkRemovedManually();
  const [note, setNote] = useState('');

  const close = () => {
    setNote('');
    onClose();
  };

  const confirm = async () => {
    if (!note.trim()) return;
    try {
      await mark.mutateAsync({ requestId: request.requestId, note: note.trim() });
      message.success('Request closed as removed manually');
      close();
    } catch (err) {
      message.error(`Not closed: ${apiErrorMessage(err, 'the request failed')}`);
    }
  };

  return (
    <Modal
      open={open}
      centered
      title="Removed manually"
      okText="Close as removed manually"
      okButtonProps={{ disabled: !note.trim() }}
      confirmLoading={mark.isPending}
      onOk={confirm}
      onCancel={close}
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {request.statusReason && (
          <Paragraph style={{ margin: 0 }}>{request.statusReason}</Paragraph>
        )}
        <Paragraph style={{ margin: 0 }}>
          Confirm only after you have removed this access in Entra ID yourself. The request ends
          EXPIRED, recorded with your name as removed manually, not as removed by EuroID, and EuroID
          stops trying to remove it.
        </Paragraph>
        <Input.TextArea
          rows={3}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="How and when was the access removed? (required)"
          aria-label="Removal note"
        />
      </Space>
    </Modal>
  );
};
