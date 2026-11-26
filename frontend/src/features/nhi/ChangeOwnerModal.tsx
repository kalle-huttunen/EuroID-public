/**
 * A new owner for an agent (POST /nhi/:agentId/owner, super-admin): an active person, picked by
 * name or email. Offered for an agent whose owner was offboarded or erased; the new owner ends
 * that state, so the agent can be issued credentials again. A refusal stays in the modal with the
 * API's message.
 */
import React, { useState } from 'react';
import { Alert, App, Button, Modal, Space, Typography } from 'antd';
import { useReownAgent } from '@api/nhi-api';
import type { IAgentIdentity } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { OwnerPicker } from './OwnerPicker';

const { Paragraph } = Typography;

export const ChangeOwnerModal: React.FC<{ agent: IAgentIdentity; onClose: () => void }> = ({
  agent,
  onClose,
}) => {
  const { message } = App.useApp();
  const reown = useReownAgent();
  const [ownerIdentityId, setOwnerIdentityId] = useState<string | undefined>();

  const save = async () => {
    if (!ownerIdentityId) return;
    try {
      const after = await reown.mutateAsync({ agentId: agent.agentId, ownerIdentityId });
      message.success(`"${agent.agentId}" is now owned by ${after.owner.email}`);
      onClose();
    } catch {
      // Shown in the modal (reown.error), which stays open
    }
  };

  return (
    <Modal
      open
      centered
      title={`Change the owner of "${agent.agentId}"`}
      onCancel={() => !reown.isPending && onClose()}
      maskClosable={false}
      footer={
        <Space wrap style={{ justifyContent: 'flex-end' }}>
          <Button onClick={onClose} disabled={reown.isPending}>
            Cancel
          </Button>
          <Button
            type="primary"
            disabled={!ownerIdentityId}
            loading={reown.isPending}
            onClick={save}
          >
            Save owner
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Paragraph style={{ marginBottom: 0 }}>
          The new owner is accountable for the agent and must be an active person. The change is
          audited, and the agent can be issued credentials again.
        </Paragraph>
        <OwnerPicker
          ariaLabel="New owner"
          requireActive
          value={ownerIdentityId}
          onChange={setOwnerIdentityId}
          style={{ width: '100%' }}
        />
        {reown.isError && (
          <Alert
            type="error"
            showIcon
            message={`Change failed: ${apiErrorMessage(reown.error, 'the request failed')}`}
          />
        )}
      </Space>
    </Modal>
  );
};
